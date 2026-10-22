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

function captureConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return {
    logs,
    restore: () => {
      console.log = original;
    },
  };
}

test("formDiscoveryDebug: present with FORM_DISCOVERY_DIAGNOSTIC=1, absent when unset -- fill_form behaviour and response shape otherwise unchanged", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const resultEnabled = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-diag-1" }),
    );
    assert.ok(resultEnabled.formDiscoveryDebug, "formDiscoveryDebug must be present when the flag is enabled");
    assert.equal(resultEnabled.formDiscoveryDebug?.enabled, true);
    assert.equal(resultEnabled.formDiscoveryDebug?.taskId, "task-diag-1");
    assert.equal(resultEnabled.formDiscoveryDebug?.runId, "task-diag-1");
    assert.ok(Array.isArray(resultEnabled.formDiscoveryDebug?.candidates));

    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const resultDisabled = await withDiagnosticFlag(false, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-diag-2" }),
    );
    assert.equal(resultDisabled.formDiscoveryDebug, undefined, "formDiscoveryDebug must be absent when the flag is unset");

    // Behaviour itself (success, outcome, filled values) is identical regardless of the flag.
    assert.equal(resultEnabled.success, resultDisabled.success);
    assert.equal(resultEnabled.formFillOutcome, resultDisabled.formFillOutcome);
    assert.deepEqual(resultEnabled.formFieldsFilled, resultDisabled.formFieldsFilled);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("formDiscoveryDebug: ENABLED/EMITTED log markers are produced only when the flag is set", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const capturedEnabled = captureConsoleLog();
    await withDiagnosticFlag(true, () => executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-log-1" }));
    capturedEnabled.restore();
    assert.ok(capturedEnabled.logs.some((l) => l.startsWith("FORM_DISCOVERY_DIAGNOSTIC_ENABLED") && l.includes("task-log-1")));
    assert.ok(capturedEnabled.logs.some((l) => l.startsWith("FORM_DISCOVERY_DIAGNOSTIC_EMITTED") && l.includes("task-log-1")));

    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const capturedDisabled = captureConsoleLog();
    await withDiagnosticFlag(false, () => executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-log-2" }));
    capturedDisabled.restore();
    assert.ok(!capturedDisabled.logs.some((l) => l.includes("FORM_DISCOVERY_DIAGNOSTIC")));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("formDiscoveryDebug: EMITTED log marker never includes submitted field values or personal data", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const captured = captureConsoleLog();
    await withDiagnosticFlag(true, () => executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-pii" }));
    captured.restore();
    const joined = captured.logs.join("\n");
    assert.ok(!joined.includes("test@test.com"), "log markers must never contain the test email value");
    assert.ok(!joined.includes("+44 7700 900123"), "log markers must never contain the test phone value");
    assert.ok(!joined.includes("+447700900123"), "log markers must never contain the normalised test phone value");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("formDiscoveryDebug: a rejected single-candidate form reports its real discovered/required field count, never a hard-coded 0", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-low-confidence-single.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-reject-1" }),
    );

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_discovery_failed");
    // The fixture's single form has exactly one real, required field -- the pre-fix code
    // always reported 0 here regardless of the candidate's real content.
    assert.equal(result.formDiscoveryDiagnostics?.fieldsDiscovered, 1);
    assert.equal(result.formDiscoveryDiagnostics?.requiredFieldsDetected, 1);

    // The new debug payload exposes the same real count for the same candidate.
    const candidate = result.formDiscoveryDebug?.candidates.find((c) => c.index === result.formDiscoveryDebug?.selection.selectedFormIndex);
    assert.ok(candidate);
    assert.ok(candidate!.totalEffectiveFieldCount >= 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("formDiscoveryDebug: a rejected multi-candidate selection exposes every candidate's score breakdown and a non-empty rejection reason", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // No journeyContext supplied -- two equally visible, equally plausible forms with no CTA/
    // objective anchor to break the tie, matching this fixture's own "two equally visible
    // forms" design (see "uses the previous CTA/objective to pick between two equally visible
    // forms" above, which supplies journeyContext precisely to avoid this outcome).
    await page.goto(`${baseUrl}/lead-form-cta-relevance.html`);
    const result = await withDiagnosticFlag(true, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "task-ambiguous-1" }),
    );

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_discovery_failed");
    assert.ok(result.formDiscoveryDebug, "formDiscoveryDebug must be present");
    assert.ok(result.formDiscoveryDebug!.candidates.length >= 2, "every candidate form must be exposed, not only the selected one");
    for (const candidate of result.formDiscoveryDebug!.candidates) {
      assert.equal(typeof candidate.totalFormScore, "number");
      assert.equal(typeof candidate.journeyRelevanceScore, "number");
      assert.equal(typeof candidate.visibilityProminenceScore, "number");
      assert.equal(typeof candidate.fieldActionabilityScore, "number");
    }
    assert.ok(result.formDiscoveryDebug!.selection.rejectionReason.length > 0);
    assert.ok(result.formDiscoveryDebug!.selection.belowConfidenceThreshold || result.formDiscoveryDebug!.selection.ambiguous);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
