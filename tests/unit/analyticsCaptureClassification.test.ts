import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyActionAnalyticsCapture,
  computeCaptureHealth,
  computeUrlRelationship,
  extractGa4PageLocation,
} from "../../src/capture-modules/analyticsCaptureClassification.js";
import { readConsentStorageEvidence } from "../../src/capture-modules/consentEvidence.js";
import type { DataLayerCapture, Ga4NetworkEventCapture } from "../../src/types/task-response.js";

/**
 * Deterministic, fixture-free coverage for the analytics-capture reliability fix's
 * classification layer (analyticsCaptureClassification.ts/consentEvidence.ts) -- the
 * generic decision tree that turns raw capture evidence into one of the five
 * AnalyticsCaptureStatus values. No browser needed: every input here is synthetic
 * evidence shaped exactly like what capture-modules/{dataLayer,ga4NetworkEvents}.ts
 * already produce.
 *
 * URL-gate correction: resulting browser URL equality is no longer a mandatory
 * confirmation gate (see the CLICK EVENT / PHYSICAL PAGE ANALYTICS / VIRTUAL PAGE OR FORM
 * STATE rules) -- window/segment ownership, an analytics event destination URL, or virtual-
 * page/form-state metadata each independently confirm evidence; only a genuinely different,
 * unrelated destination (urlRelationship DIFFERENT_DESTINATION) with none of those signals
 * still excludes an event.
 */

function ga4Event(overrides: Partial<Ga4NetworkEventCapture> = {}): Ga4NetworkEventCapture {
  return {
    stepIndex: 1,
    requestUrl: "https://www.google-analytics.com/g/collect?v=2",
    timestamp: new Date().toISOString(),
    method: "GET",
    source: "main_frame",
    ...overrides,
  };
}

function dataLayerPush(overrides: Partial<DataLayerCapture> = {}): DataLayerCapture {
  return {
    stepIndex: 1,
    url: "https://example.com/destination",
    timestamp: new Date().toISOString(),
    raw: [{ event: "click" }],
    source: "main_frame",
    ...overrides,
  };
}

const healthyCaptureHealth = computeCaptureHealth({
  isClick: true,
  dataLayerReplaced: false,
  dataLayerPushListenerActive: true,
  networkListenerActive: true,
  dataLayerPushesObservedInWindowCount: 0,
  dataLayerModuleRequested: true,
  ga4ModuleRequested: true,
});

function classify(overrides: Partial<Parameters<typeof classifyActionAnalyticsCapture>[0]> = {}) {
  return classifyActionAnalyticsCapture({
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [],
    dataLayerPushesInWindow: [],
    ga4EventsBeforeMid: [],
    dataLayerPushesBeforeMid: [],
    captureHealth: healthyCaptureHealth,
    consentRequired: false,
    consentEvidence: { observed: false },
    ...overrides,
  });
}

test("extractGa4PageLocation reads dl from query params first, then from a POST-batched param entry", () => {
  const fromQuery = ga4Event({ params: { dl: "https://example.com/a" } });
  assert.equal(extractGa4PageLocation(fromQuery), "https://example.com/a");

  const fromBody = ga4Event({ params: undefined, postDataParams: [{ dl: "https://example.com/b" }] });
  assert.equal(extractGa4PageLocation(fromBody), "https://example.com/b");

  const absent = ga4Event({ params: { tid: "G-X" } });
  assert.equal(extractGa4PageLocation(absent), undefined);
});

test("CAPTURED: a GA4 event whose dl exactly matches browserResultingUrl is confirmed, not left unresolved", () => {
  const event = ga4Event({ params: { dl: "https://example.com/destination", tid: "G-ABC" }, measurementId: "G-ABC" });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [event],
    ga4EventsBeforeMid: [event],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.confirmedGa4Events.length, 1);
  assert.equal(result.unresolvedGa4Candidates.length, 0);
  assert.deepEqual(result.measurementIds, ["G-ABC"]);
  assert.equal(result.urlRelationship, "EXACT_MATCH");
});

test("a genuinely unrelated analytics destination (DIFFERENT_DESTINATION, no confirming signal) is left as an unresolved candidate, never silently attributed [test 6]", () => {
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [ga4Event({ params: { dl: "https://example.com/SOME-OTHER-PAGE" } })],
  });
  assert.equal(result.status, "CORRELATION_UNRESOLVED");
  assert.equal(result.confirmedGa4Events.length, 0);
  assert.equal(result.unresolvedGa4Candidates.length, 1);
});

test("CLICK EVENT: a click-tracking GA4 event whose dl still names the SOURCE page is confirmed via its own analyticsEventDestinationUrl (link_url), even though it never matches browserResultingUrl [test 1]", () => {
  const clickEvent = ga4Event({
    params: { dl: "https://example.com/source", link_url: "https://example.com/destination", tid: "G-ABC" },
  });
  const result = classify({
    ctaElementDestinationUrl: "https://example.com/destination",
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [clickEvent],
    ga4EventsBeforeMid: [clickEvent],
  });
  assert.equal(result.status, "CAPTURED", "the browser resulting URL never had to match dl for this to confirm");
  assert.equal(result.confirmedGa4Events.length, 1);
  assert.equal(result.unresolvedGa4Candidates.length, 0);
  assert.equal(result.analyticsEventDestinationUrl, "https://example.com/destination");
  assert.equal(result.triggerSegment, "PHYSICAL_CLICK");
});

test("PHYSICAL PAGE ANALYTICS: analyticsPageLocation is retained exactly as emitted, never overwritten by a differing browserResultingUrl [test 2]", () => {
  const push = dataLayerPush({
    raw: [{ event: "page_view", page_location: "https://example.com/destination" }],
  });
  const result = classify({
    browserResultingUrl: "https://example.com/destination?session=abc123",
    dataLayerPushesInWindow: [push],
    dataLayerPushesBeforeMid: [],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.analyticsPageLocation, "https://example.com/destination");
  assert.equal(result.browserResultingUrl, "https://example.com/destination?session=abc123");
});

test("URL RELATIONSHIP: a browser URL carrying a linker/tracking parameter never overwrites analyticsFullUrl, and the relationship is reported as TRACKING_PARAMETERS_ONLY_DIFFERENCE, not a mismatch [test 3, test 7]", () => {
  const canonical = "https://example.com/destination";
  const push = dataLayerPush({ raw: [{ event: "page_view", full_url: canonical }] });
  const browserResultingUrl = `${canonical}?_gl=1*abc123*_ga*fictional`;
  const result = classify({
    ctaElementDestinationUrl: `${canonical}?_gl=1*abc123*_ga*fictional`,
    browserResultingUrl,
    dataLayerPushesInWindow: [push],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.analyticsFullUrl, canonical, "the analytics-emitted full_url must survive unmodified");
  assert.equal(result.urlRelationship, "TRACKING_PARAMETERS_ONLY_DIFFERENCE");
  // Original values preserved unchanged -- never normalised in place.
  assert.equal(result.browserResultingUrl, browserResultingUrl);
  assert.equal(result.ctaElementDestinationUrl, `${canonical}?_gl=1*abc123*_ga*fictional`);
});

test("VIRTUAL PAGE OR FORM STATE: a dataLayer push naming a virtual page/step is confirmed even though the browser URL never changed, and even though it doesn't resemble the physical URL at all [test 4]", () => {
  const push = dataLayerPush({
    url: "https://example.com/configurator",
    raw: [
      {
        event: "virtual_page_view",
        virtualpage_url: "/configurator/step-2",
        page_name: "configurator_step_2",
        page_category: "configurator",
        step_name: "trim_selection",
        step_number: 2,
      },
    ],
  });
  const result = classify({
    browserResultingUrl: "https://example.com/configurator",
    dataLayerPushesInWindow: [push],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.analyticsVirtualPageUrl, "/configurator/step-2");
  assert.deepEqual(result.analyticsVirtualPageMetadata, {
    virtualPageUrl: "/configurator/step-2",
    pageName: "configurator_step_2",
    pageCategory: "configurator",
    stepName: "trim_selection",
    stepNumber: 2,
  });
  assert.equal(result.confirmedDataLayerPushes.length, 1);
  assert.equal(result.unresolvedDataLayerPushes.length, 0);
});

test("SEGMENT ATTRIBUTION: evidence observed before the mid-index is PHYSICAL_CLICK; evidence observed after is DESTINATION_SETTLEMENT, or FALLBACK_NAVIGATION when the destinationUrl fallback was used [test 5]", () => {
  const afterMidEvent = ga4Event({ params: { dl: "https://example.com/destination" } });

  const settlement = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [afterMidEvent],
    ga4EventsBeforeMid: [],
  });
  assert.equal(settlement.triggerSegment, "DESTINATION_SETTLEMENT");

  const fallback = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [afterMidEvent],
    ga4EventsBeforeMid: [],
    fallbackVerified: true,
  });
  assert.equal(fallback.triggerSegment, "FALLBACK_NAVIGATION");

  const beforeMidEvent = ga4Event({ params: { dl: "https://example.com/destination" } });
  const physicalClick = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [beforeMidEvent],
    ga4EventsBeforeMid: [beforeMidEvent],
    fallbackVerified: true,
  });
  assert.equal(
    physicalClick.triggerSegment,
    "PHYSICAL_CLICK",
    "evidence owned by the physical-click segment takes precedence over a fallback that happened later in the same window",
  );

  const popup = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [afterMidEvent],
    openedNewContext: true,
  });
  assert.equal(popup.triggerSegment, "POPUP_OR_NEW_TAB");
});

test("CONFIRMED-EVENT SAFETY: an unrelated meaningful event inside a valid click window is not confirmed as the CTA tag", () => {
  const unrelatedPush = dataLayerPush({ raw: [{ event: "newsletter_signup", email_capture: true }] });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    dataLayerPushesInWindow: [unrelatedPush],
    dataLayerPushesBeforeMid: [unrelatedPush],
  });
  assert.equal(result.status, "CORRELATION_UNRESOLVED");
  assert.equal(result.confirmedDataLayerPushes.length, 0, "window ownership alone must never confirm an unrelated business event as the CTA tag");
  assert.equal(result.unresolvedDataLayerPushes.length, 1);
  const entry = result.classifiedEvidence.find((e) => e.dataLayerPush === unrelatedPush);
  assert.equal(entry?.classification, "OTHER_MEANINGFUL_EVENT", "it has its own clear identity, so it's not merely ambiguous either");
});

test("CONFIRMED-EVENT SAFETY: a direct CTA event inside PHYSICAL_CLICK is confirmed as CLICK_EVENT", () => {
  const ctaEvent = ga4Event({ params: { en: "click", link_id: "hero-cta", link_url: "https://example.com/destination" } });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [ctaEvent],
    ga4EventsBeforeMid: [ctaEvent],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.confirmedGa4Events.length, 1);
  assert.equal(result.triggerSegment, "PHYSICAL_CLICK");
  const entry = result.classifiedEvidence.find((e) => e.ga4Event === ctaEvent);
  assert.equal(entry?.classification, "CLICK_EVENT");
});

test("CONFIRMED-EVENT SAFETY: a page_view observed in DESTINATION_SETTLEMENT is classified as PHYSICAL_PAGE_CHANGE (physical page evidence)", () => {
  const pageViewEvent = ga4Event({ params: { en: "page_view", dl: "https://example.com/destination" } });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [pageViewEvent],
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.triggerSegment, "DESTINATION_SETTLEMENT");
  const entry = result.classifiedEvidence.find((e) => e.ga4Event === pageViewEvent);
  assert.equal(entry?.classification, "PHYSICAL_PAGE_CHANGE");
});

test("CONFIRMED-EVENT SAFETY: virtual-page metadata inside the action window is classified as VIRTUAL_PAGE_CHANGE (virtual-state evidence)", () => {
  const virtualPush = dataLayerPush({ raw: [{ event: "virtual_page_view", virtualpage_url: "/configurator/step-2", page_name: "step_2" }] });
  const result = classify({
    browserResultingUrl: "https://example.com/configurator",
    dataLayerPushesInWindow: [virtualPush],
  });
  assert.equal(result.status, "CAPTURED");
  const entry = result.classifiedEvidence.find((e) => e.dataLayerPush === virtualPush);
  assert.equal(entry?.classification, "VIRTUAL_PAGE_CHANGE");
});

test("CONFIRMED-EVENT SAFETY: an ambiguous candidate (a page-location value naming neither the CTA destination nor the browser result, with no other signal) remains CORRELATION_UNRESOLVED", () => {
  const ambiguousEvent = ga4Event({ params: { dl: "https://example.com/entirely-different-page" } });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [ambiguousEvent],
  });
  assert.equal(result.status, "CORRELATION_UNRESOLVED");
  const entry = result.classifiedEvidence.find((e) => e.ga4Event === ambiguousEvent);
  assert.equal(entry?.classification, "CORRELATION_UNRESOLVED");
});

test("computeUrlRelationship: the full diagnostic vocabulary", () => {
  assert.equal(computeUrlRelationship("https://a.com/x", "https://a.com/x"), "EXACT_MATCH");
  assert.equal(computeUrlRelationship("https://a.com/x?utm_source=y", "https://a.com/x"), "TRACKING_PARAMETERS_ONLY_DIFFERENCE");
  assert.equal(computeUrlRelationship("https://a.com/x?session=1", "https://a.com/x"), "SAME_PHYSICAL_PAGE");
  assert.equal(computeUrlRelationship("/virtual/step-2", "https://a.com/x"), "DIFFERENT_ANALYTICS_VIRTUAL_STATE");
  assert.equal(computeUrlRelationship("https://a.com/y", "https://a.com/x"), "DIFFERENT_DESTINATION");
  assert.equal(computeUrlRelationship(undefined, "https://a.com/x"), "UNAVAILABLE");
});

test("WEBSITE_NO_OBSERVED_TAG: healthy, complete capture window with no evidence at all", () => {
  const result = classify({ browserResultingUrl: "https://example.com/destination" });
  assert.equal(result.status, "WEBSITE_NO_OBSERVED_TAG");
});

test("ENGINE_CAPTURE_INCOMPLETE: dataLayer was replaced by a navigation and no push-observer entry landed in the window -- a possible lost click event, never silently reported as no-observed-tag", () => {
  const unhealthy = computeCaptureHealth({
    isClick: true,
    dataLayerReplaced: true,
    dataLayerPushListenerActive: true,
    networkListenerActive: true,
    dataLayerPushesObservedInWindowCount: 0,
    dataLayerModuleRequested: true,
    ga4ModuleRequested: true,
  });
  assert.equal(unhealthy.captureComplete, false);
  assert.equal(unhealthy.unobservedDataLayerGapPossible, true);

  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    dataLayerReplaced: true,
    dataLayerHasNewEntries: true,
    captureHealth: unhealthy,
  });
  assert.equal(result.status, "ENGINE_CAPTURE_INCOMPLETE");
  assert.match(result.classificationReason, /dataLayer was replaced/);
});

test("ENGINE_CAPTURE_INCOMPLETE: the dataLayer push listener failed to attach for this page", () => {
  const unhealthy = computeCaptureHealth({
    isClick: true,
    dataLayerReplaced: false,
    dataLayerPushListenerActive: false,
    networkListenerActive: true,
    dataLayerPushesObservedInWindowCount: 0,
    dataLayerModuleRequested: true,
    ga4ModuleRequested: false,
  });
  assert.equal(unhealthy.captureComplete, false);
  assert.match(unhealthy.issues.join(), /push listener failed to attach/);
});

test("a navigation-replaced dataLayer with a matching push-observer entry inside the window is NOT flagged as an unobserved gap", () => {
  const health = computeCaptureHealth({
    isClick: true,
    dataLayerReplaced: true,
    dataLayerPushListenerActive: true,
    networkListenerActive: true,
    dataLayerPushesObservedInWindowCount: 1,
    dataLayerModuleRequested: true,
    ga4ModuleRequested: true,
  });
  assert.equal(health.unobservedDataLayerGapPossible, false);
  assert.equal(health.captureComplete, true);
});

test("CAPTURE_UNCERTAIN_CONSENT_STATE: accept_optional policy but no analytics_storage=granted evidence observed -- never WEBSITE_NO_OBSERVED_TAG in this case", () => {
  const result = classify({ browserResultingUrl: "https://example.com/destination", consentRequired: true });
  assert.equal(result.status, "CAPTURE_UNCERTAIN_CONSENT_STATE");
});

test("consent required and analytics_storage=granted observed: consent gate passes, falls through to ordinary classification", () => {
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    ga4EventsInWindow: [ga4Event({ params: { dl: "https://example.com/destination" } })],
    consentRequired: true,
    consentEvidence: { analyticsStorageGranted: true, observed: true },
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.consent.verified, true);
});

test("readConsentStorageEvidence: parses a gtag-style consent update pushed to dataLayer (numeric-key arguments shape)", () => {
  const evidence = readConsentStorageEvidence({
    dataLayerEntries: [
      { "0": "consent", "1": "default", "2": { analytics_storage: "denied", ad_storage: "denied" } },
      { "0": "consent", "1": "update", "2": { analytics_storage: "granted", ad_storage: "granted" } },
    ],
    ga4Events: [],
  });
  assert.equal(evidence.observed, true);
  assert.equal(evidence.analyticsStorageGranted, true);
  assert.equal(evidence.adStorageGranted, true);
});

test("readConsentStorageEvidence: falls back to GA4 gcs param decoding when no gtag consent entry is present", () => {
  const evidence = readConsentStorageEvidence({
    dataLayerEntries: [{ event: "unrelated_event" }],
    ga4Events: [ga4Event({ consentState: { gcs: "G111" } })],
  });
  assert.equal(evidence.observed, true);
  assert.equal(evidence.adStorageGranted, true);
  assert.equal(evidence.analyticsStorageGranted, true);
});

test("readConsentStorageEvidence: gcs denied for both is decoded correctly, and an unrelated gcs shape is never guessed at", () => {
  const denied = readConsentStorageEvidence({
    dataLayerEntries: [],
    ga4Events: [ga4Event({ consentState: { gcs: "G100" } })],
  });
  assert.equal(denied.adStorageGranted, false);
  assert.equal(denied.analyticsStorageGranted, false);

  const noSignal = readConsentStorageEvidence({ dataLayerEntries: [], ga4Events: [ga4Event({})] });
  assert.equal(noSignal.observed, false);
});

test("dataLayer push in the window is confirmed via window ownership even when dataLayerDelta itself was replaced (the click-before-navigation recovery), with no URL match required", () => {
  const health = computeCaptureHealth({
    isClick: true,
    dataLayerReplaced: true,
    dataLayerPushListenerActive: true,
    networkListenerActive: true,
    dataLayerPushesObservedInWindowCount: 1,
    dataLayerModuleRequested: true,
    ga4ModuleRequested: false,
  });
  const result = classify({
    browserResultingUrl: "https://example.com/destination",
    dataLayerReplaced: true,
    dataLayerHasNewEntries: true,
    dataLayerPushesInWindow: [dataLayerPush({ url: "https://example.com/source-before-navigation" })],
    captureHealth: health,
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.confirmedDataLayerPushes.length, 1);
});
