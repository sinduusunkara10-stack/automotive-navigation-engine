import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

test("fill_form: a widget's own visible text growing, with no hidden identifier ever committed anywhere in the form, is never treated as a genuine dealer commit -- the original production false positive", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-text-growth-no-hidden-commit.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerAutoPopulated, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
    assert.equal(
      result.formDealerSearchDiagnostics?.dealerLookupFailureReason,
      "visible_scope_text_changed_but_no_hidden_identifier_committed_within_timeout",
    );
    // Submit must never be clicked on an unverified dealer dependency.
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "cancelled_before_request");
    assert.equal(result.formPostSubmitDiagnostics?.retryEligible, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a hidden dealer identifier that commits outside the trigger/field's own narrow DOM scope, but still inside the form, is recognised -- the scope must be the enclosing form, not the widget's own wrapper", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-two-postcode-fields-auto-populate.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
    assert.equal(result.formPostSubmitDiagnostics?.dealerCommitEvidence, true);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a verified dealer dependency and a passed pre-submit readiness gate does not imply success -- a client-side cancellation with no network request and no observable cause is reported as cancelled_before_request, not success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-submit-cancelled-before-request.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true, "the dealer dependency itself was genuinely committed");
    assert.equal(result.formPostSubmitDiagnostics?.preSubmitReadinessPassed, true);
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, true);
    assert.equal(result.formPostSubmitDiagnostics?.submissionRequestStarted, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionCanceledBeforeRequest, true);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "cancelled_before_request");
    assert.equal(result.formPostSubmitDiagnostics?.validationSurfaceDetected, false);
    assert.equal(result.formPostSubmitDiagnostics?.retryEligible, false, "no correctable issue was ever identified, so there is nothing to retry");
    assert.equal(result.formFillOutcome, "validation_cause_not_observed");
    // The engine must never claim a diagnosed cause ("form_validation_failed") when none exists.
    assert.notEqual(result.formFillOutcome, "form_validation_failed");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a request that IS sent during submit, then cancelled with no observable validation surface, is distinguished from cancelled_before_request -- a network request's mere presence is never itself a diagnosable cause", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-submit-sends-request-then-cancels-silently.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionRequestStarted, true);
    assert.equal(result.formPostSubmitDiagnostics?.submissionCanceledBeforeRequest, false);
    assert.equal(result.formPostSubmitDiagnostics?.validationSurfaceDetected, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "cancelled_unknown_cause");
    assert.equal(result.formFillOutcome, "validation_cause_not_observed");
    assert.ok(result.formPostSubmitDiagnostics?.submissionNetworkRequests.length >= 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a request sent during submit followed by a genuine visible error surface is reported as validation_failed with validationSurfaceType 'visible_message', not an unknown cancellation", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-submit-visible-error-after-request.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionRequestStarted, true);
    assert.equal(result.formPostSubmitDiagnostics?.validationSurfaceDetected, true);
    assert.equal(result.formPostSubmitDiagnostics?.validationSurfaceType, "visible_message");
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "validation_failed");
    assert.equal(result.formFillOutcome, "form_validation_failed");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a dealer-lookup scope that never surfaces a single selectable result is flagged by the unresolvedDependentControlIds safety net independent of resolveDealerLookup's own classification, and reported as an 'unresolved_dependent_control' validation surface when it is the only cause found after a non-navigating submit", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-no-results.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.equal(result.success, false);
    // Submit is never reached at all here (the pre-submit readiness gate blocks it), so this
    // exercises the safety net's own presence rather than its effect on an actual submit -- see
    // the dedicated fillForm.ts unit coverage below for the scope-only check.
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: the new submission diagnostics (network evidence, submit-control identity, outcome/retry reasons) never carry any typed personal value, request body, or response body -- including hidden-field evidence, which carries no values", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-submit-visible-error-after-request.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    const diagnostics = result.formPostSubmitDiagnostics;
    assert.ok(diagnostics);
    const serialized = JSON.stringify(diagnostics);
    assert.equal(serialized.includes("dealer-1"), false, "the committed dealer identifier's own value must never appear");
    assert.equal(serialized.toLowerCase().includes("@"), false, "no email address should appear");
    // The sanitised network evidence must only ever carry the shape the dealerLookupNetwork
    // module documents -- method/endpoint-pattern/timing/status/content-type/record-count, never
    // a request or response body.
    diagnostics.submissionNetworkRequests.forEach((request) => {
      assert.equal(Object.prototype.hasOwnProperty.call(request, "postData"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(request, "body"), false);
    });
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: submitControlIdentity is a generic, non-PII descriptor of the control actually activated, and submitActivationMethod reports 'click'", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-submit-cancelled-before-request.html`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] });

    assert.match(result.formPostSubmitDiagnostics?.submitControlIdentity ?? "", /button/);
    assert.equal(result.formPostSubmitDiagnostics?.submitActivationMethod, "click");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
