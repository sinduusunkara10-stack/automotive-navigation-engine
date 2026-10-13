import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function withDiagnosticFlag<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  if (enabled) {
    process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  } else {
    delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
  }
  return fn().finally(() => {
    if (previous === undefined) {
      delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    } else {
      process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
    }
  });
}

test("dealerLookupTrace: absent when FORM_DISCOVERY_DIAGNOSTIC is unset, present when set -- behaviour otherwise identical", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-two-postcode-fields-unresolved.html`);
    const resultDisabled = await withDiagnosticFlag(false, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-trace-off" }),
    );
    assert.equal(resultDisabled.dealerLookupTrace, undefined);

    await page.goto(`${baseUrl}/lead-form-two-postcode-fields-unresolved.html`);
    const resultEnabled = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-trace-on" }),
    );
    assert.ok(resultEnabled.dealerLookupTrace, "dealerLookupTrace must be present when the flag is enabled");
    assert.equal(resultEnabled.dealerLookupTrace?.enabled, true);

    // Production outcome is identical regardless of the flag -- the diagnostic is additive only.
    assert.equal(resultEnabled.success, resultDisabled.success);
    assert.equal(resultEnabled.formFillOutcome, resultDisabled.formFillOutcome);
    assert.deepEqual(resultEnabled.formPostSubmitDiagnostics?.preSubmitReadinessFailures, resultDisabled.formPostSubmitDiagnostics?.preSubmitReadinessFailures);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: reports the real regression -- a distant trigger is reported as a rejected candidate pair with its exact pixel-distance evidence, and diagnosticCompleteness explains the block", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-two-postcode-fields-unresolved.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-regression" }),
    );

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.ok(result.formPostSubmitDiagnostics?.preSubmitReadinessFailures.some((f) => f.startsWith("multiple_postcode_fields_unresolved")));

    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");

    // Every candidate pair considered is reported, not just the winner -- there is at least one
    // trigger (the Search button) and it was evaluated against both postcode fields.
    assert.ok(trace!.triggerFieldPairs.length >= 2, "every trigger x field pair considered must be reported");
    for (const pair of trace!.triggerFieldPairs) {
      assert.equal(typeof pair.ancestorHopCutoff, "number");
      assert.equal(typeof pair.pixelDistanceCutoff, "number");
      assert.equal(typeof pair.accepted, "boolean");
      assert.equal(typeof pair.isWinner, "boolean");
    }

    // The pair for the dealer-widget's own postcode field (dealer-postcode, the one placed far
    // from its trigger) must be rejected with a concrete, measured reason -- not merely "false".
    const rejected = trace!.triggerFieldPairs.filter((p) => !p.accepted);
    assert.ok(rejected.length > 0, "at least one pair must be reported as rejected");
    for (const pair of rejected) {
      assert.ok(pair.rejectionReason && pair.rejectionReason.length > 0, "a rejected pair must carry an exact rejection reason");
    }
    // At least one rejection must cite the real, measured cutoff violation (pixel distance),
    // since the fixture's whole point is a trigger placed 900px below its field.
    assert.ok(
      rejected.some((p) => p.rejectionReason?.includes("pixel distance") || p.rejectionReason?.includes("ancestor-hop")),
      "rejection reason must cite the actual measured signal that exceeded its cutoff",
    );
    assert.ok(trace!.triggerFieldPairs.every((p) => !p.isWinner), "no pair should have won -- this is the no-candidate-passed case");

    // diagnosticCompleteness must explain the block, not just report raw data.
    assert.equal(trace!.diagnosticCompleteness.finalDecision, "submit_blocked");
    assert.ok(trace!.diagnosticCompleteness.finalDecisionReason.length > 0);
    assert.equal(trace!.diagnosticCompleteness.evaluatedCandidateCount, trace!.triggerFieldPairs.length);
    assert.equal(trace!.diagnosticCompleteness.rejectedCandidateCount, rejected.length);

    // Field-level evidence (sanitised, no values) must exist for both postcode fields.
    const fieldRoles = trace!.fields.filter((f) => f.role === "field");
    assert.ok(fieldRoles.length >= 2, "both postcode-purpose fields must have field-level evidence");
    for (const field of fieldRoles) {
      assert.equal(typeof field.visible, "boolean");
      assert.equal(typeof field.required, "boolean");
      assert.equal(typeof field.populated, "boolean");
      assert.ok(Array.isArray(field.domAncestry));
      assert.ok(field.boundingBox);
    }
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: a resolved dealer flow reports an accepted, winning candidate pair and a full execution trace with no personal data", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-search-success.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-success" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");

    const winner = trace!.triggerFieldPairs.find((p) => p.isWinner);
    assert.ok(winner, "the search button must have won association with the dealer postcode field");
    assert.equal(winner!.accepted, true);
    assert.equal(winner!.rejectionReason, null);

    assert.equal(trace!.execution.eventsDispatched.includes("click_trigger"), true);
    assert.equal(trace!.execution.waitOutcome, "resolved");
    assert.equal(trace!.execution.suggestionsDetected, true);
    assert.ok(trace!.execution.suggestionCount >= 1);
    assert.equal(trace!.execution.dealerSelectionAttempted, true);
    assert.equal(trace!.execution.preSubmitReadinessResult, "passed");
    assert.equal(trace!.diagnosticCompleteness.status, "COMPLETE");
    assert.equal(trace!.diagnosticCompleteness.finalDecision, "submit_allowed");

    // Never a typed/selected value -- only positional identity.
    assert.notEqual(trace!.execution.selectedSuggestionIdentity, "Dealer One");
    assert.notEqual(trace!.execution.selectedSuggestionIdentity, "Dealer Two");
    const serialized = JSON.stringify(trace);
    assert.ok(!serialized.includes("Dealer One"));
    assert.ok(!serialized.includes("Dealer Two"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
