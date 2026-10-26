import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { ActionResult } from "../../src/types/task-response.js";
import { FIXTURE_DOM_MODE_ENV, OPEN_SHADOW_MODE } from "../helpers/openShadowFixture.js";
import { startStaticServer } from "../helpers/staticServer.js";

// Existing light-DOM lead-form fixtures, re-served with their whole body inside one open shadow
// root (tests/helpers/openShadowFixture.ts), must give the same fill_form outcome as the original:
// one generic form engine for both, covering each component kind the engine handles.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const FIXTURES = [
  "lead-form-url-success.html",
  "lead-form-marker-required.html",
  "lead-form-select-generic-first-valid.html",
  "lead-form-consent-purposes.html",
  "lead-form-radio-customer-qualification.html",
  "lead-form-dealer-search-success.html",
  "lead-form-dealer-auto-dropdown-autopopulate.html",
  "lead-form-validation-failure.html",
  "lead-form-late-required-field.html",
  "location-gate-suggestions.html",
  "location-gate-with-lead-form.html",
];

function outcome(r: ActionResult) {
  return {
    success: r.success,
    error: r.error,
    formFillOutcome: r.formFillOutcome,
    formSuccessDetection: r.formSuccessDetection,
    formFieldsFilled: r.formFieldsFilled,
    formRetriesUsed: r.formRetriesUsed,
    formValidationMissingFields: r.formValidationMissingFields,
    required: [r.formDiscoveryDiagnostics?.requiredFieldsDetected, r.formDiscoveryDiagnostics?.requiredFieldsFilled],
    fields: r.formDiscoveryDiagnostics?.fieldDiagnostics.map((f) => [f.label, f.requiredEvidence, f.matchedField, f.decision, f.filled]),
    dealer: r.formDealerSearchDiagnostics && {
      fieldDetected: r.formDealerSearchDiagnostics.dealerLookupFieldDetected,
      controlDetected: r.formDealerSearchDiagnostics.dealerLookupControlDetected,
      outcome: r.formDealerSearchDiagnostics.dealerLookupOutcome,
      verified: r.formDealerSearchDiagnostics.dealerValueVerified,
    },
    consent: r.formConsentDiagnostics && {
      detected: r.formConsentDiagnostics.consentGroupsDetected,
      actionable: r.formConsentDiagnostics.consentGroupsActionable,
      groups: r.formConsentDiagnostics.consentGroupDiagnostics.map((g) => [g.groupId, g.classification, g.interaction, g.resolved]),
      rejections: r.formConsentDiagnostics.consentGroupRejections.length,
    },
    locationGate: r.formLocationGateDiagnostics,
    submitCanceled: r.formPostSubmitDiagnostics?.submitCanceled,
    submissionOutcome: r.formPostSubmitDiagnostics?.submissionOutcome,
  };
}

async function runIn(browser: Browser, baseUrl: string, fixture: string, mode: string | undefined) {
  const previous = process.env[FIXTURE_DOM_MODE_ENV];
  if (mode) process.env[FIXTURE_DOM_MODE_ENV] = mode;
  else delete process.env[FIXTURE_DOM_MODE_ENV];
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/${fixture}`);
    const shadowHosts = await page.evaluate(() => Array.from(document.querySelectorAll("*")).filter((el) => el.shadowRoot).length);
    const lightForms = await page.evaluate(() => document.querySelectorAll("form, input").length);
    const result = (await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [] })) as ActionResult;
    return { shadowHosts, lightForms, outcome: outcome(result) };
  } finally {
    await page.close();
    if (previous === undefined) delete process.env[FIXTURE_DOM_MODE_ENV];
    else process.env[FIXTURE_DOM_MODE_ENV] = previous;
  }
}

for (const fixture of FIXTURES) {
  test(`open shadow DOM parity: ${fixture} gives the same fill_form outcome inside an open shadow root as in light DOM`, async () => {
    const { baseUrl, close } = await startStaticServer(fixturesDir);
    const browser = await chromium.launch();
    try {
      const light = await runIn(browser, baseUrl, fixture, undefined);
      const shadow = await runIn(browser, baseUrl, fixture, OPEN_SHADOW_MODE);
      assert.equal(light.shadowHosts, 0);
      assert.equal(shadow.shadowHosts, 1);
      assert.equal(shadow.lightForms, 0, "nothing the engine fills is left in the light DOM");
      assert.deepEqual(shadow.outcome, light.outcome);
    } finally {
      await browser.close();
      await close();
    }
  });
}
