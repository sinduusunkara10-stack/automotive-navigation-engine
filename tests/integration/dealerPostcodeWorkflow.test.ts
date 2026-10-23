import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { marketDataFor } from "../../src/forms/testData.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

async function withDiagnosticFlag<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
  }
}

async function runFixture(fixture: string, setup?: (page: Page) => Promise<void>) {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    if (setup) await setup(page);
    await page.goto(`${baseUrl}/${fixture}`);
    const result = await withDiagnosticFlag(() =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: `task-${fixture}` }),
    );
    const pageState = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return Object.fromEntries(Object.keys(w).filter((k) => k.startsWith("__") && typeof w[k] === "number").map((k) => [k, w[k] as number]));
    });
    return { result, pageState };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

const DEALERS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><dealers><dealer><name>Garage Alpha Riverside</name><id>DLR-778899</id></dealer><dealer><name>Garage Beta Hillside</name><id>DLR-112233</id></dealer></dealers>';

async function routeDealerSearch(page: Page, response: { status?: number; body: string; delayMs?: number }): Promise<void> {
  await page.route("**/api/dealers/search*", async (route) => {
    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    await route.fulfill({ status: response.status ?? 200, contentType: "text/xml; charset=utf-8", body: response.body }).catch(() => {});
  });
  await page.route("**/api/form/config", (route) =>
    route.fulfill({ status: 200, contentType: "application/xml", body: '<configuration><setting name="a"/><setting name="b"/></configuration>' }),
  );
}

test("dealer workflow: real typing that keeps focus opens a debounced, blur-cancelled autocomplete rendered as plain divs in a body portal -- the textless trigger (a locate-me control) is never needed and never clicked (German market)", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-de-debounced-typing-portal.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  assert.equal(result.success, true);
  assert.equal(execution.inputMethod, "keyboard");
  assert.equal(execution.fieldValueRetainedAfterInput, true);
  assert.equal(execution.eventsDispatched.includes("click_trigger"), false);
  assert.equal(execution.resultFoundOutsideScope, true, "the suggestion lives in a body-level portal");
  assert.equal(execution.genericCandidateFallbackUsed, true, "plain role-less divs");
  assert.equal(pageState.__geoClicks, 0);
  assert.equal(pageState.__formSubmitted, 1, "only the final, verified submit");
  assert.ok(execution.hiddenFieldCommitPurposes.includes("dealer_identifier"));
  assert.equal(execution.lookupStateClassification, "results_appeared_automatically");
});

test("dealer workflow: the live trace's shape -- a textless, type-less button that requests geolocation and a field that never looks anything up -- resolves to a definitive explanation, and the lead form is never submitted during the lookup", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-geolocation-trigger-no-lookup.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.success, false);
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
  assert.equal(execution.triggerClassification, "textless_unknown");
  assert.equal(execution.eventsDispatched.includes("click_trigger"), true);
  const triggerStep = execution.activationSteps.find((s) => s.step === "click_trigger");
  assert.equal(triggerStep?.geolocationRequested, true);
  assert.equal(execution.lookupFailureClassification, "trigger_requested_geolocation_and_nothing_else_reacted");
  assert.ok(execution.implicitSubmitBlockedCount >= 1, "Enter and the type-less button would each have submitted the lead form");
  assert.equal(pageState.__formSubmitted, 0);
  assert.equal(execution.retryRecommendation, "none");
  assert.equal(result.formRetriesUsed, 0);
  assert.deepEqual(
    execution.activationSteps.map((s) => s.step),
    ["keyboard_input", "observe_auto_lookup", "press_arrowdown", "press_enter", "press_tab", "click_trigger", "await_lookup_results"],
  );
  assert.equal(result.dealerLookupTrace?.diagnosticCompleteness.missingEvidence.some((m) => m.includes("activation")), false);
});

test("dealer workflow: a control whose own name/title/class says it locates the device is never clicked as a lookup trigger", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-geolocation-hinted-trigger.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(execution.triggerClassification, "geolocation_control");
  assert.equal(execution.triggerClickSkippedReason, "trigger_matches_geolocation_vocabulary");
  assert.equal(execution.eventsDispatched.includes("click_trigger"), false);
  assert.equal(pageState.__iconClicks, 0);
  assert.equal(execution.lookupFailureClassification, "no_reaction_to_any_activation");
});

test("dealer workflow: Enter is required to search, and the implicit lead-form submission that Enter triggers is swallowed (Dutch market)", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-nl-enter-required.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.success, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  assert.ok(execution.eventsDispatched.includes("press_enter"));
  assert.ok(execution.implicitSubmitBlockedCount >= 1);
  assert.equal(pageState.__prematureSubmits, 0, "the lead form's submit button must never fire before the dealer committed");
  assert.equal(pageState.__submitClicks, 1);
  assert.equal(pageState.__formSubmitted, 1);
});

test("dealer workflow: XML dealer results are classified from structure only, survive a burst of tracking requests, and select through native radios -- no record content or typed value ever reaches the evidence", async () => {
  const { result } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { body: DEALERS_XML }));
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.success, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  const lookup = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"));
  assert.ok(lookup, "the lookup request must never be crowded out by tracking beacons");
  assert.equal(lookup.purpose, "dealer_results");
  assert.equal(lookup.xmlRootElement, "dealers");
  assert.equal(lookup.recordCount, 2);
  assert.equal(lookup.activationStep, "click_trigger");
  assert.ok(execution.trackingRequestCount >= 8);
  const config = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/form/config"));
  assert.equal(config?.purpose, "form_configuration");
  const serialized = JSON.stringify(result.dealerLookupTrace) + JSON.stringify(result.formPostSubmitDiagnostics?.submissionNetworkRequests);
  const postcode = marketDataFor("UK").postcode;
  assert.equal(serialized.includes(postcode), false);
  assert.equal(serialized.includes(postcode.replace(/\s+/g, "")), false);
  assert.equal(serialized.includes(encodeURIComponent(postcode)), false);
  assert.equal(serialized.includes("Garage Alpha"), false);
  assert.equal(serialized.includes("DLR-778899"), false);
});

test("dealer workflow: an empty XML result is reported as a lookup that returned no results, not retried, and never submitted", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { body: '<?xml version="1.0"?><dealers/>' }));
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
  assert.equal(execution.lookupFailureClassification, "lookup_request_returned_empty_results");
  assert.equal(execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"))?.purpose, "empty_results");
  assert.equal(result.formRetriesUsed, 0);
  assert.equal(pageState.__lookupRequests, 1);
});

test("dealer workflow: an XML error body is classified as a validation error from its structure, even with HTTP 200", async () => {
  const { result } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { body: '<?xml version="1.0"?><response><error code="E42"/></response>' }));
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  const lookup = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"));
  assert.equal(lookup?.status, 200);
  assert.equal(lookup?.resultCategory, "error");
  assert.equal(lookup?.purpose, "validation_error");
  assert.equal(execution.lookupFailureClassification, "lookup_request_returned_empty_results");
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
});

test("dealer workflow: a lookup server error is reported as a failed lookup request", async () => {
  const { result } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { status: 500, body: "<oops/>" }));
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"))?.purpose, "server_error");
  assert.equal(execution.lookupFailureClassification, "lookup_request_failed");
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
});

test("dealer workflow: a lookup still in flight at the bounded wait is re-polled without re-entering the value or re-triggering the lookup, and completes", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { body: DEALERS_XML, delayMs: 11_000 }));
  assert.equal(result.success, true);
  assert.equal(result.formRetriesUsed, 1);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  assert.equal(pageState.__lookupRequests, 1, "the retry must never send a second lookup that would reset the first");
  assert.equal(result.dealerLookupTrace?.execution.eventsDispatched.includes("type_with_keyboard"), false, "the final (retry) call never re-types");
  assert.equal(result.dealerLookupTrace?.execution.lateResultObservation ?? null, null, "a lookup re-polled by the retry is never also watched passively");
});

test("dealer workflow: a lookup whose result renders only after the stage gave up is watched (never acted on) and the late result is recorded with request/step timing", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-xml-lookup.html", async (page) => {
    await routeDealerSearch(page, { body: DEALERS_XML });
    await page.addInitScript(() => {
      (window as unknown as { __resultRenderDelayMs: number }).__resultRenderDelayMs = 10_000;
    });
  });
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false, "the late result is never selected");
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
  assert.equal(pageState.__lookupRequests, 1);
  assert.equal(execution.retryRecommendation, "none");
  const late = execution.lateResultObservation;
  assert.ok(late, "an unresolved timeout with nothing in flight is watched");
  assert.equal(late.resultAppeared, true);
  assert.ok(late.resultAppearedAtMs !== null && late.resultAppearedAtMs > late.observationStartedAtMs);
  assert.ok(late.domMutationCount > 0);
  const lookup = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"));
  assert.ok(lookup && typeof lookup.bodyFinishedAtMs === "number" && lookup.bodyFinishedAtMs >= lookup.startedAtMs);
  assert.ok(late.resultAppearedAtMs! > lookup.bodyFinishedAtMs!, "the result rendered after the body had fully arrived");
  assert.ok(execution.activationSteps.every((s) => typeof s.startedAtMs === "number"));
  assert.equal(execution.lookupStateClassification, "results_appeared_after_timeout");
});

test("dealer workflow: a lookup that never renders anything after a timeout is watched for the bounded window and recorded as no late result", async () => {
  const { result } = await runFixture("lead-form-dealer-xml-lookup.html", async (page) => {
    await routeDealerSearch(page, { body: DEALERS_XML });
    await page.addInitScript(() => {
      (window as unknown as { __resultRenderDelayMs: number }).__resultRenderDelayMs = 120_000;
    });
  });
  const late = result.dealerLookupTrace?.execution.lateResultObservation;
  assert.ok(late);
  assert.equal(late.resultAppeared, false);
  assert.equal(late.resultAppearedAtMs, null);
  assert.equal(late.resultAuthoritative, null);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
  assert.equal(result.dealerLookupTrace?.execution.lookupStateClassification, "request_completed_ui_unchanged");
});

for (const [name, staysDisabled, expected] of [
  ["a confirm control that appears only after typing", false, "actionable_control_appeared_not_clicked"],
  ["a confirm control that appears after typing but stays disabled", true, "control_present_but_disabled"],
] as const) {
  test(`dealer workflow diagnostics: ${name} is recorded in the control timeline, never clicked by the diagnostics`, async () => {
    const { result, pageState } = await runFixture("lead-form-dealer-confirm-control.html", async (page) => {
      if (staysDisabled) {
        await page.addInitScript(() => {
          (window as unknown as { __confirmStaysDisabled: boolean }).__confirmStaysDisabled = true;
        });
      }
    });
    const execution = result.dealerLookupTrace?.execution;
    assert.ok(execution);
    const timeline = execution.lookupControlTimeline;
    assert.ok(timeline && timeline.entries.length >= 2);
    assert.equal(execution.lookupStateClassification, expected);
    if (expected === "actionable_control_appeared_not_clicked") {
      assert.equal(pageState.__confirmClicks, 0, "neither the engine nor the diagnostics clicked the control");
      const appeared = timeline.controlsBecameActionable[0];
      assert.ok(appeared && appeared.clickedByEngine === false && appeared.lookupVocabulary === true);
    } else {
      assert.ok(timeline.controlsDisabledAtEnd.length > 0);
    }
    assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
    assert.equal(JSON.stringify(timeline).includes("OK"), false, "control text never leaves the page");
  });
}

test("dealer workflow: a response body that cannot be read as XML or JSON says why its structure is unknown", async () => {
  const { result } = await runFixture("lead-form-dealer-xml-lookup.html", (page) => routeDealerSearch(page, { body: "not a structured body" }));
  const lookup = result.dealerLookupTrace?.execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/search"));
  assert.equal(lookup?.resultCategory, "unknown");
  assert.equal(lookup?.structureUnknownReason, "unparseable");
  const config = result.dealerLookupTrace?.execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/form/config"));
  assert.equal(config?.structureUnknownReason ?? null, null, "a derived structure carries no unknown reason");
});

test("dealer workflow: XML location suggestions in a portal, then XML dealer results after the location is chosen, each committed through hidden identifiers (Polish market, language-neutral widget)", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-xml-location-then-dealer.html", async (page) => {
    await page.route("**/geo/autocomplete*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/xml",
        body: "<localities><locality><label>Warszawa Centrum</label><key>LOC-1</key></locality><locality><label>Warszawa Praga</label><key>LOC-2</key></locality></localities>",
      }),
    );
    await page.route("**/api/dealers/near", (route) =>
      route.fulfill({ status: 200, contentType: "text/xml", body: "<outlets><dealer><name>Salon Wola</name><code>OUT-1</code></dealer><dealer><name>Salon Mokotow</name><code>OUT-2</code></dealer></outlets>" }),
    );
  });
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.success, true);
  assert.equal(result.formDealerSearchDiagnostics?.locationSuggestionsDetected, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerResultsDetected, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  assert.equal(pageState.__locationRequests, 1);
  assert.equal(pageState.__dealerRequests, 1);
  const location = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/geo/autocomplete"));
  const dealers = execution.networkRequests.find((r) => r.endpointPattern.endsWith("/api/dealers/near"));
  assert.equal(location?.purpose, "location_results");
  assert.equal(location?.recordCount, 2);
  assert.equal(dealers?.purpose, "dealer_results");
  assert.equal(dealers?.activationStep, "click_location_suggestion", "the dealer request is correlated with the location selection that caused it");
  assert.equal(JSON.stringify(result.dealerLookupTrace).includes("Warszawa"), false);
});

test("dealer workflow: a pre-rendered, hidden listbox outside the form, reachable only through the field's aria-controls, is found once it becomes visible (Spanish market)", async () => {
  const { result } = await runFixture("lead-form-dealer-es-aria-linked-listbox.html");
  assert.equal(result.success, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
  assert.equal(result.dealerLookupTrace?.execution.resultFoundOutsideScope, true);
});

test("dealer workflow: results rendered inside a same-origin child frame are found and committed", async () => {
  const { result } = await runFixture("lead-form-dealer-iframe-results.html");
  assert.equal(result.success, true);
  assert.equal(result.dealerLookupTrace?.execution.resultFoundInFrame, true);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true);
});

test("dealer workflow: a selection that only rewrites visible text (field value, a 'selected' line) is never a commit, so submit is never clicked", async () => {
  const { result, pageState } = await runFixture("lead-form-dealer-text-only-selection.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false);
  assert.equal(execution.lookupFailureClassification, "location_selected_but_no_dealer_result_or_commit");
  assert.equal(pageState.__formSubmitted, 0);
});

test("submission: a submit control enabled only by the last field's blur is given that commit event, then clicked", async () => {
  const { result } = await runFixture("lead-form-submit-enabled-after-final-blur.html");
  assert.equal(result.success, true);
  assert.equal(result.formPostSubmitDiagnostics?.submitControlEnabled, true);
  assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");
});

test("submission: a permanently disabled submit control is reported promptly, never clicked, never a hang", async () => {
  const started = Date.now();
  const { result } = await runFixture("lead-form-submit-permanently-disabled.html");
  assert.ok(Date.now() - started < 20_000, "must not wait out Playwright's default click timeout");
  assert.equal(result.success, false);
  assert.equal(result.formPostSubmitDiagnostics?.submitControlEnabled, false);
  assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "cancelled_before_request");
  assert.match(result.formPostSubmitDiagnostics?.submissionOutcomeReason ?? "", /disabled/);
  assert.equal(result.formRetriesUsed, 0);
});

test("submission: confirmation vocabulary already on the page plus an accepted (2xx) request is never success -- the outcome stays unconfirmed", async () => {
  const { result } = await runFixture("lead-form-submit-accepted-no-confirmation.html", (page) =>
    page.route("**/lead/submit", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })),
  );
  assert.equal(result.success, false);
  assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "unconfirmed");
  assert.equal(result.formPostSubmitDiagnostics?.submissionServerResponseCategory, "accepted");
  assert.equal(result.formFillOutcome, "validation_cause_not_observed");
});

for (const [status, outcome, category] of [
  [422, "server_rejected", "server_validation_rejected"],
  [429, "blocked_or_rate_limited", "blocked_or_rate_limited"],
  [503, "server_error", "server_error"],
] as const) {
  test(`submission: a ${status} answer to the submission request is reported as ${outcome}, never success and never an unknown cancellation`, async () => {
    const { result } = await runFixture("lead-form-submit-sends-request-then-cancels-silently.html", (page) =>
      page.route("**/submit-check", (route) => route.fulfill({ status, contentType: "application/json", body: "{}" })),
    );
    assert.equal(result.success, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, outcome);
    assert.equal(result.formPostSubmitDiagnostics?.submissionServerResponseCategory, category);
  });
}

test("privacy: no typed postcode, personal value, hidden-field value or response record appears in any new dealer-lookup or submission diagnostic", async () => {
  const { result } = await runFixture("lead-form-dealer-de-debounced-typing-portal.html");
  const execution = result.dealerLookupTrace?.execution;
  assert.ok(execution);
  const newEvidence = JSON.stringify({
    activationSteps: execution.activationSteps,
    networkRequests: execution.networkRequests,
    lookupFailureExplanation: execution.lookupFailureExplanation,
    hiddenFieldCommitPurposes: execution.hiddenFieldCommitPurposes,
    submissionNetworkRequests: result.formPostSubmitDiagnostics?.submissionNetworkRequests,
    submissionOutcomeReason: result.formPostSubmitDiagnostics?.submissionOutcomeReason,
  });
  const postcode = marketDataFor("DE").postcode;
  for (const forbidden of [postcode, "Berlin", "Autohaus", "h-1", "test@test.com", "Test"]) {
    assert.equal(newEvidence.includes(forbidden), false, `"${forbidden}" must never appear`);
  }
});
