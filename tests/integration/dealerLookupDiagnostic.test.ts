import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { buildDealerLookupTrace, DEALER_TRACE_MAX_FIELDS, DEALER_TRACE_MAX_TRIGGER_FIELD_PAIRS } from "../../src/diagnostics/dealerLookupDiagnostic.js";
import type { TriggerFieldPairDebug, RawLookupTriggerCandidate } from "../../src/actions/dealerLookup.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

async function validateAgainstResponseSchema(response: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(response);
  assert.ok(valid, ajv.errorsText(validate.errors));
}

/** Always proposes fill_form once, then stop_failure -- exercises the real engine/runTask path (not executeFillForm directly), which is what the HTTP API layer serializes verbatim as result/steps[].actionResult (see src/api/server.ts: no field-by-field reconstruction between TaskResponse and the response body). */
class FillFormOnceProvider implements ReasoningProvider {
  private filled = false;
  async decide(_context: ReasoningContext): Promise<Decision> {
    if (!this.filled) {
      this.filled = true;
      return { action: { type: "fill_form" }, rationale: "Fill the lead-capture form." };
    }
    return { action: { type: "stop_failure" }, rationale: "Nothing left to do." };
  }
}

function fillFormTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl">): TaskRequest {
  return {
    schemaVersion: "1.45.0",
    taskId: "dealer-lookup-trace-engine-level",
    objective: "Submit the lead-capture form.",
    allowedDomains: ["127.0.0.1"],
    successCriteria: [],
    captureModules: [],
    limits: { maxSteps: 4, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["fill_form", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    outputSchemaVersion: "1.47.0",
    ...overrides,
  };
}

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

test("dealerLookupTrace: survives unmodified into the final TaskResponse (steps[].actionResult.dealerLookupTrace), which validates against the schema the HTTP API enforces", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = fillFormTask({ startUrl: `${baseUrl}/lead-form-dealer-search-success.html` });
    const response = await withDiagnosticFlag(true, () => runTask({ page, task, reasoning: new FillFormOnceProvider() }));

    await validateAgainstResponseSchema(response);

    const fillFormStep = response.steps.find((s) => s.selectedAction.type === "fill_form");
    assert.ok(fillFormStep, "a fill_form step must exist");
    const trace = fillFormStep!.actionResult.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must reach the final TaskResponse, not just executeFillForm's own return value");
    assert.equal(trace!.enabled, true);
    assert.equal(trace!.diagnosticCompleteness.status, "COMPLETE");
    assert.equal(trace!.truncated, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: absent from the final TaskResponse when FORM_DISCOVERY_DIAGNOSTIC is unset, even via the full engine/runTask path", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = fillFormTask({ startUrl: `${baseUrl}/lead-form-dealer-search-success.html` });
    const response = await withDiagnosticFlag(false, () => runTask({ page, task, reasoning: new FillFormOnceProvider() }));

    await validateAgainstResponseSchema(response);
    const fillFormStep = response.steps.find((s) => s.selectedAction.type === "fill_form");
    assert.ok(fillFormStep);
    assert.equal(fillFormStep!.actionResult.dealerLookupTrace, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: payload safeguards truncate an oversized trigger-field-pair count deterministically, and diagnosticCompleteness reflects the truncation instead of falsely reporting COMPLETE", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-search-success.html`);
    const form = page.locator("form").first();

    const oversizedPairDebug: TriggerFieldPairDebug[] = Array.from({ length: DEALER_TRACE_MAX_TRIGGER_FIELD_PAIRS + 50 }, (_, i) => ({
      triggerIndex: `t${i}`,
      triggerText: "Search",
      fieldIndex: `f${i}`,
      ariaMatch: false,
      nearestCommonAncestorHops: 1,
      ancestorHopCutoff: 20,
      pixelDistance: 10,
      pixelDistanceCutoff: 600,
      domOrderDelta: 0,
      ancestorHopScoreComponent: 40,
      pixelDistanceScoreComponent: 10,
      finalScore: 50,
      passedAncestorCutoff: true,
      passedPixelCutoff: true,
      accepted: false,
      isWinner: false,
      rejectionReason: "synthetic pair for truncation test",
    }));

    const trace = await withDiagnosticFlag(true, () =>
      buildDealerLookupTrace({
        page,
        form,
        taskId: "truncation-test",
        captureStage: "pre_submit_readiness_failed",
        plan: [],
        triggerCandidates: [],
        pairDebug: oversizedPairDebug,
        dealerLookupOutcome: undefined,
        preSubmitReadinessPassed: false,
        preSubmitReadinessFailures: ["synthetic_failure"],
      }),
    );

    assert.ok(trace, "dealerLookupTrace must be built");
    assert.equal(trace!.triggerFieldPairs.length, DEALER_TRACE_MAX_TRIGGER_FIELD_PAIRS, "triggerFieldPairs must be capped at the documented limit");
    assert.equal(trace!.truncated, true);
    assert.equal(trace!.omittedCandidateCount, 50);
    assert.equal(trace!.omittedFieldCount, 0);
    // Deterministic: the first N entries are kept, in original order, never a random subset.
    assert.equal(trace!.triggerFieldPairs[0]?.triggerIndex, "t0");
    assert.equal(trace!.triggerFieldPairs[trace!.triggerFieldPairs.length - 1]?.triggerIndex, `t${DEALER_TRACE_MAX_TRIGGER_FIELD_PAIRS - 1}`);

    assert.equal(trace!.diagnosticCompleteness.status, "INCOMPLETE", "truncated evidence must never be reported as COMPLETE");
    assert.ok(
      trace!.diagnosticCompleteness.missingEvidence.some((m) => m.includes("truncated")),
      "diagnosticCompleteness.missingEvidence must explain the truncation",
    );
    assert.equal(trace!.diagnosticCompleteness.evaluatedCandidateCount, DEALER_TRACE_MAX_TRIGGER_FIELD_PAIRS);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: a trigger that is also tagged as its own field (the real DS/Peugeot regression's own signature) is reported as a rejected self-match, never an accepted/winning pair", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-trigger-self-field-duplicate.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-self-match" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");

    const selfMatchPairs = trace!.triggerFieldPairs.filter((p) => p.pixelDistance === 0 && p.nearestCommonAncestorHops === 0 && !p.accepted);
    assert.ok(selfMatchPairs.length > 0, "the off-screen proxy's self-pair must be reported, rejected");
    for (const pair of selfMatchPairs) {
      assert.equal(pair.accepted, false);
      assert.equal(pair.isWinner, false);
      assert.ok(pair.rejectionReason?.includes("same DOM element"), `expected a self-match rejection reason, got: ${pair.rejectionReason}`);
    }

    // The real dealer-search button must still win its own, genuine pair -- the self-match
    // guard must never prevent a legitimate structural association elsewhere on the form.
    const winner = trace!.triggerFieldPairs.find((p) => p.isWinner);
    assert.ok(winner, "the real dealer-search button must still win association with the postcode field");
    assert.equal(winner!.accepted, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: a dealer result resolved via the generic-candidate fallback (no ARIA role match) reports genericCandidateFallbackUsed=true, while an authoritative ARIA-role resolution reports it false", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-generic-result-list.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-generic-candidate" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.genericCandidateFallbackUsed, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: an authoritative role=\"radio\"/role=\"option\" resolution reports genericCandidateFallbackUsed=false", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-search-success.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-aria-not-generic" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.genericCandidateFallbackUsed, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: Pattern A -- a suggestion dropdown that appears entirely on its own, with no lookup/search button at all, is detected before any activation is attempted and resolved by selecting it", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-auto-dropdown-no-button.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-pattern-a" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.autoDropdownDetected, true);
    assert.equal(trace!.execution.eventsDispatched.includes("click_trigger"), false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: Pattern C -- an auto-appearing dropdown still requires a distinct OK/confirm control after a suggestion is selected before dealer results appear, and the engine never clicks it before the suggestion is picked", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-auto-dropdown-then-confirm.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-pattern-c" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.autoDropdownDetected, true);
    assert.equal(trace!.execution.confirmControlClicked, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: Pattern D -- an auto-appearing dropdown whose selected suggestion auto-populates the dealer directly, with no further selectable dealer-results stage, is recognised without ever submitting unverified", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-auto-dropdown-autopopulate.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-pattern-d" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.autoDropdownDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: Pattern E -- a widget with no lookup button and no reaction to typing is only opened by ArrowDown, never mistaken for an unresolved dead end", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-keyboard-only.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-pattern-e" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.eventsDispatched.includes("press_arrowdown"), true);
    assert.equal(trace!.execution.autoDropdownDetected, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: a result that only arrives past the base 6-second stage timeout, with a generic loading indicator still visibly active, is caught by the stage's one bounded extension rather than timing out", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-loading-indicator-extension.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-loading-extension" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.stageWaitExtended, true);
    assert.equal(trace!.execution.loadingIndicatorObservedAtTimeout, true);
    assert.equal(trace!.execution.timedOutStage, null);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: location suggestions resolving almost instantly never starve, or get conflated with, an independently-timed slow dealer-results stage that itself needs its own bounded extension", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-fast-suggestions-slow-dealer.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-independent-stage-timing" }),
    );

    assert.equal(result.success, true);
    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.suggestionsDetected, true);
    assert.equal(trace!.execution.stageWaitExtended, true);
    assert.equal(trace!.execution.timedOutStage, null);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dealerLookupTrace: a lookup that never reveals anything selectable, with no loading indicator either, reports a genuinely unresolved outcome and blocks submit rather than hanging or submitting unverified", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-suggestions-never-appear.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-never-appear" }),
    );

    const trace = result.dealerLookupTrace;
    assert.ok(trace, "dealerLookupTrace must be present");
    assert.equal(trace!.execution.timedOutStage, "location_suggestions");
    assert.equal(trace!.execution.loadingIndicatorObservedAtTimeout, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
    assert.equal(result.success, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
