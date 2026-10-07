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

test("fill_form: an unresolvable required field fails the pre-submit readiness gate and never clicks submit at all", async () => {
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
    assert.equal(result.formRetriesUsed, 0);
    assert.ok(result.formValidationMissingFields && result.formValidationMissingFields.length > 0);
    assert.equal(result.formPostSubmitDiagnostics?.preSubmitReadinessPassed, false);
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    assert.ok(result.formPostSubmitDiagnostics?.preSubmitReadinessFailures.some((f) => f.startsWith("unresolved_required_fields")));

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
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupFieldDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupControlDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupTriggered, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupOutcome, "dealer_selected");
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
    assert.equal(result.formPostSubmitDiagnostics?.submitCanceled, false);
    assert.equal(result.formRetriesUsed, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a postcode field labelled with no dealer-specific wording is still routed through dealer_search when the form structurally has a search trigger and an accessible result widget", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-widget-generic-postcode-label.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formDiscoveryDiagnostics?.dealerSearchWidgetDetected, true);
    // Never counted among the plain fill_text fields -- it went through dealer_search instead.
    assert.equal(result.formFieldsFilled?.includes("postcode"), false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupFieldDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupControlDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupTriggered, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupOutcome, "dealer_selected");
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
    assert.equal(result.formRetriesUsed, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a plain postcode field with no dealer-search widget on the page is filled as plain text, and formDealerSearchDiagnostics is still always present with false defaults", async () => {
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
    assert.equal(result.formDiscoveryDiagnostics?.dealerSearchWidgetDetected, false);
    assert.equal(result.formFieldsFilled?.includes("postcode"), true);
    // Promised fields must appear even when the dealer_search decision never ran at all --
    // never silently omitted, which previously made "the flow never activated" indistinguishable
    // from "it activated and every step came back false".
    assert.deepEqual(result.formDealerSearchDiagnostics, {
      customerPostcodeFieldDetected: true,
      dealerLookupFieldDetected: false,
      dealerLookupFieldEvidence: "",
      dealerLookupControlDetected: false,
      dealerLookupControlEvidence: "",
      dealerLookupTriggered: false,
      dealerLookupOutcome: "not_applicable",
      locationSuggestionsDetected: false,
      locationSuggestionSelected: false,
      dealerResultsDetected: false,
      dealerAutoPopulated: false,
      dealerSelected: false,
      dealerValueVerified: false,
      dealerVerificationEvidence: "",
    });
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
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
    assert.equal(result.formRetriesUsed, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: no dealer results found retries the lookup bounded, then never clicks submit at all (never submit with an unverified dealer dependency)", async () => {
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
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupTriggered, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, false);
    assert.equal(result.formDealerSearchDiagnostics?.dealerSelected, false);
    assert.equal(result.formPostSubmitDiagnostics?.submitCanceled, true);
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    assert.equal(result.formPostSubmitDiagnostics?.preSubmitReadinessPassed, false);
    assert.ok(result.formPostSubmitDiagnostics?.preSubmitReadinessFailures.includes("dealer_dependency_unresolved"));
    assert.equal(result.formRetriesUsed, 2);
    assert.match(result.formPostSubmitDiagnostics?.retryDecision ?? "", /dealer-lookup retries/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a clicked dealer result the widget never visibly commits is retried bounded, then never clicks submit at all", async () => {
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
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    assert.equal(result.formRetriesUsed, 2);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: two postcode-purpose fields on the same form are judged independently -- only the dealer-locator one (with its own adjacent OK control) triggers the lookup, and it auto-populates generically", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-two-postcode-fields-auto-populate.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    // The plain customer-address postcode was filled as ordinary text ...
    assert.ok(result.formFieldsFilled?.includes("postcode"));
    // ... while the dealer-locator postcode/city went through dealer_search instead, even
    // though neither field's own label carries any dealer-specific vocabulary.
    assert.equal(result.formDealerSearchDiagnostics?.customerPostcodeFieldDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupFieldDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupControlDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupOutcome, "auto_populated");
    assert.equal(result.formDealerSearchDiagnostics?.dealerAutoPopulated, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, false);

    const addressPostcode = await page.evaluate(() => (document.getElementById("address-postcode") as HTMLInputElement).value);
    assert.equal(addressPostcode, "SW1A 1AA");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a trigger using only 'select' vocabulary first reveals a location suggestion, then the real dealer list after selecting it", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-suggestion-then-list.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupTriggered, true);
    assert.equal(result.formDealerSearchDiagnostics?.locationSuggestionsDetected, true);
    assert.equal(result.formDealerSearchDiagnostics?.locationSuggestionSelected, true);
    assert.equal(result.formDealerSearchDiagnostics?.dealerLookupOutcome, "dealer_selected");
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: Oui/Non radio consent groups with no matchable label text are discovered generically, resolved, and a conditionally-revealed third group is caught by the rescan", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-consent-groups-conditional.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formConsentDiagnostics?.consentGroupsInitiallyVisible, 2);
    assert.equal(result.formConsentDiagnostics?.consentGroupsCompleted, 3);
    assert.ok((result.formConsentDiagnostics?.conditionalConsentGroupsRevealed ?? 0) >= 1);
    assert.ok(result.formConsentDiagnostics?.consentGroupDiagnostics.every((g) => g.resolved));
    assert.ok(result.formConsentDiagnostics?.consentGroupDiagnostics.every((g) => g.classification === "marketing_consent"));

    const checked = await page.evaluate(() => ({
      a: (document.querySelector('input[name="consentA"]:checked') as HTMLInputElement | null)?.value,
      b: (document.querySelector('input[name="consentB"]:checked') as HTMLInputElement | null)?.value,
      c: (document.querySelector('input[name="consentC"]:checked') as HTMLInputElement | null)?.value,
    }));
    assert.equal(checked.a, "no");
    assert.equal(checked.b, "no");
    assert.equal(checked.c, "no");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a journey_intent radio group is resolved against the task's own workflow journey context, never defaulted", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-journey-intent.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      journeyContext: { objective: "Get a price quote for the new model" },
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "intent");
    assert.equal(group?.classification, "journey_intent");
    assert.equal(group?.resolved, true);
    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("intent"), "quote");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a journey_intent radio group with no usable workflow journey context is left unresolved and blocks submit", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-journey-intent.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "intent");
    assert.equal(group?.classification, "journey_intent");
    assert.equal(group?.resolved, false);
    assert.ok(group?.unresolvedReason);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a customer_qualification radio group always resolves to the private-customer option, independent of the field's own document order", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-customer-qualification.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "customerType");
    assert.equal(group?.classification, "customer_qualification");
    assert.equal(group?.resolved, true);
    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("customerType"), "private");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a customer_qualification radio group with no option matching private-customer vocabulary is left unresolved and blocks submit", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-qualification-unresolved.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "customerType");
    assert.equal(group?.classification, "customer_qualification");
    assert.equal(group?.resolved, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a radio group with no classifiable vocabulary at all is ambiguous, left unresolved, and blocks submit rather than guessed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-ambiguous.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "miscChoice");
    assert.equal(group?.classification, "ambiguous");
    assert.equal(group?.resolved, false);
    assert.ok(group?.unresolvedReason);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: marketing_consent, journey_intent, and customer_qualification groups on the same form are each resolved by their own rule, independently", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-radio-mixed-groups.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      journeyContext: { objective: "Book a test drive at a local dealer" },
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    const byGroup = new Map(result.formConsentDiagnostics?.consentGroupDiagnostics.map((g) => [g.groupId, g]));
    assert.equal(byGroup.get("intent")?.classification, "journey_intent");
    assert.equal(byGroup.get("customerType")?.classification, "customer_qualification");
    assert.equal(byGroup.get("marketingOptIn")?.classification, "marketing_consent");

    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("intent"), "test_drive");
    assert.equal(url.searchParams.get("customerType"), "private");
    assert.equal(url.searchParams.get("marketingOptIn"), "no");
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
