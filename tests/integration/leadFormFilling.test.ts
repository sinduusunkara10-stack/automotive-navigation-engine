import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

test("fill_form: fills required fields, skips hidden/optional/prefilled, and succeeds via a URL change", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "url_change");
    assert.equal(result.formMarketDetected, "UK");
    assert.equal(result.formLanguageDetected, "en");
    assert.ok(result.resultingUrl?.includes("lead-form-thank-you.html"));

    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("firstName"), "Test");
    assert.equal(url.searchParams.get("lastName"), "Test");
    assert.equal(url.searchParams.get("email"), "test@test.com");
    assert.equal(url.searchParams.get("mobile"), "+44 7700 900123");
    assert.equal(url.searchParams.get("postcode"), "SW1A 1AA");
    // Optional comments field left blank, honeypot never filled, optional consent left unchecked.
    assert.equal(url.searchParams.get("comments"), "");
    assert.equal(url.searchParams.get("website"), "");
    assert.equal(url.searchParams.get("stayInTouch"), null);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: detects success via an on-screen confirmation message when the URL never changes", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-message-success.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "on_screen_message");
    assert.equal(result.formLanguageDetected, "fr");
    assert.equal(result.formMarketDetected, "FR");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a detected CAPTCHA stops the run without filling or submitting anything", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-captcha.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "blocked_captcha");

    const values = await page.evaluate(() => ({
      firstName: (document.getElementById("first-name") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
    }));
    assert.deepEqual(values, { firstName: "", email: "" });
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: picks the form with actionable fields over the first <form> on the page", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-multiple-forms.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formDiscoveryDiagnostics?.selectedFormIndex, 1);
    assert.equal(result.formDiscoveryDiagnostics?.formsOnPage, 2);
    assert.ok(result.resultingUrl?.includes("lead-form-thank-you.html"));
    assert.ok((result.formDiscoveryDiagnostics?.totalFormScore ?? 0) > 0);
    assert.equal(result.formDiscoveryDiagnostics?.rejectedFormsAndReasons?.length, 1);
    assert.equal(result.formDiscoveryDiagnostics?.rejectedFormsAndReasons?.[0]?.index, 0);

    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.has("q"), false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: prefers a visible, prominent request-a-quote form over an off-screen form with more fields", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-offscreen-vs-prominent.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formDiscoveryDiagnostics?.selectedFormIndex, 1);
    assert.ok((result.formDiscoveryDiagnostics?.visibilityProminenceScore ?? 0) > 0);
    assert.ok(result.resultingUrl?.includes("quote-thank-you.html"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: prefers a request-a-quote form over a newsletter form with more fields", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-newsletter-vs-quote.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formDiscoveryDiagnostics?.selectedFormIndex, 1);
    assert.ok(result.resultingUrl?.includes("quote-thank-you.html"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: uses the previous CTA/objective to pick between two equally visible forms", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-cta-relevance.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      journeyContext: { previousActionLabel: "Take advantage of our electricity offers" },
    });

    assert.equal(result.success, true);
    assert.equal(result.formDiscoveryDiagnostics?.selectedFormIndex, 1);
    assert.ok(result.resultingUrl?.includes("electricity-thank-you.html"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a single low-relevance, low-visibility, low-actionability form stops safely without submitting", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-low-confidence-single.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_discovery_failed");
    assert.ok((result.formDiscoveryDiagnostics?.totalFormScore ?? 1) < 0.4);

    const submitted = await page.evaluate(() => window.location.href);
    assert.ok(!submitted.includes("utility-thank-you.html"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a required field with no mapping and no Claude resolver never clicks submit, and reports form_discovery_failed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-unmappable-required.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_discovery_failed");
    assert.equal(result.formDiscoveryDiagnostics?.requiredFieldsDetected, 1);
    assert.equal(result.formDiscoveryDiagnostics?.requiredFieldsFilled, 0);
    assert.deepEqual(result.formDiscoveryDiagnostics?.unmappedRequiredFieldIds, ["0"]);

    const submitClicked = await page.evaluate(() => (window as unknown as { __submitClicked?: boolean }).__submitClicked ?? false);
    assert.equal(submitClicked, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a cancelled submission (no URL change, no confirmation) is reported as a failure, never success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-cancelled-submission.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formRetriesUsed, 0);
    assert.deepEqual(result.formValidationMissingFields, []);
    assert.ok(result.formFieldsFilled && result.formFieldsFilled.length > 0);

    const canceled = await page.evaluate(() => (window as unknown as { __formCanceled?: boolean }).__formCanceled ?? false);
    assert.equal(canceled, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: an unresolvable required field triggers retries up to the bound, then reports form_validation_failed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-validation-failure.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formRetriesUsed, 2);
    assert.ok(result.formValidationMissingFields && result.formValidationMissingFields.length > 0);

    const values = await page.evaluate(() => ({
      firstName: (document.getElementById("first-name") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
    }));
    assert.equal(values.firstName, "Test");
    assert.equal(values.email, "test@test.com");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a required field marked only by a visible '*' marker (no required/aria-required attribute) is detected, filled, and submitted", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-marker-required.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formDiscoveryDiagnostics?.requiredFieldsDetected, 4);
    assert.equal(result.formDiscoveryDiagnostics?.requiredFieldsFilled, 4);
    assert.ok(result.formDiscoveryDiagnostics?.fieldDiagnostics?.every((f) => f.requiredEvidence === "marker"));
    assert.ok(result.resultingUrl?.includes("lead-form-thank-you.html"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a visible control's hidden same-purpose backing duplicate is never filled or relied on; only the visible control is", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-hidden-backing-duplicate.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");

    const hiddenFields = result.formDiscoveryDiagnostics?.fieldDiagnostics?.filter((f) => !f.visible) ?? [];
    assert.equal(hiddenFields.length, 2);
    assert.ok(hiddenFields.every((f) => f.filled === false));

    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("firstName_display"), "Test");
    assert.equal(url.searchParams.get("email_display"), "test@test.com");
    assert.equal(url.searchParams.get("firstName"), "stale-backing-value");
    assert.equal(url.searchParams.get("email"), "stale@example.com");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: an empty visible field whose value only echoes its own label/placeholder is never treated as prefilled", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-placeholder-mimicry.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    const emailDiagnostic = result.formDiscoveryDiagnostics?.fieldDiagnostics?.find((f) => f.matchedField === "email");
    assert.equal(emailDiagnostic?.valueState, "placeholder_mimicry");
    assert.equal(emailDiagnostic?.filled, true);
    assert.ok(result.formFieldsFilled?.includes("email"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: zero actionable fields never triggers Submit and reports form_discovery_failed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-zero-actionable.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_discovery_failed");
    assert.equal(result.formDiscoveryDiagnostics?.fieldActionabilityScore, 0);

    const submitClicked = await page.evaluate(() => (window as unknown as { __submitClicked?: boolean }).__submitClicked ?? false);
    assert.equal(submitClicked, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: dealer search triggers via a nearby button, waits for results, selects and verifies the first dealer, then submits", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-search-success.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "on_screen_message");
    assert.deepEqual(result.formDealerSearchDiagnostics, {
      postcodeSearchTriggered: true,
      dealerResultsDetected: true,
      dealerSelected: true,
      dealerSelectionVerified: true,
    });
    assert.equal(result.formPostSubmitDiagnostics?.submitCanceled, false);
    assert.equal(result.formRetriesUsed, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a role=\"radio\" dealer widget that commits via aria-checked (not aria-selected or .checked) is recognized as verified", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-aria-checked.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelectionVerified, true);
    assert.equal(result.formRetriesUsed, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: no dealer results found never fabricates a selection, retries the search, and reports form_validation_failed with the site's own error text", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-no-results.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formDealerSearchDiagnostics?.postcodeSearchTriggered, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, false);
    assert.equal(result.formPostSubmitDiagnostics?.submitCanceled, true);
    assert.ok(result.formPostSubmitDiagnostics?.postSubmitValidationMessages.some((m) => m.includes("No dealer selected")));
    assert.equal(result.formRetriesUsed, 2);
    assert.match(result.formPostSubmitDiagnostics?.retryDecision ?? "", /dealer search/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a clicked dealer result the widget never visibly commits is reported unverified, not treated as a successful selection", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-selection-uncommitted.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelectionVerified, false);
    assert.equal(result.formRetriesUsed, 2);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a required field the page only reveals after a cancelled submit is caught by re-reading live validation state and recovered on retry", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-late-required-field.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "url_change");
    assert.equal(result.formRetriesUsed, 1);
    assert.match(result.formPostSubmitDiagnostics?.retryDecision ?? "", /re-read live validation state/);
    assert.ok(result.resultingUrl?.includes("extraPostcode="));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
