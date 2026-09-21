import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifyActionAnalyticsCapture,
  computeCaptureHealth,
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

test("extractGa4PageLocation reads dl from query params first, then from a POST-batched param entry", () => {
  const fromQuery = ga4Event({ params: { dl: "https://example.com/a" } });
  assert.equal(extractGa4PageLocation(fromQuery), "https://example.com/a");

  const fromBody = ga4Event({ params: undefined, postDataParams: [{ dl: "https://example.com/b" }] });
  assert.equal(extractGa4PageLocation(fromBody), "https://example.com/b");

  const absent = ga4Event({ params: { tid: "G-X" } });
  assert.equal(extractGa4PageLocation(absent), undefined);
});

test("CAPTURED: a GA4 event whose dl exactly matches resultingUrl is confirmed, not left unresolved", () => {
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [ga4Event({ params: { dl: "https://example.com/destination", tid: "G-ABC" }, measurementId: "G-ABC" })],
    dataLayerPushesInWindow: [],
    captureHealth: healthyCaptureHealth,
    consentRequired: false,
    consentEvidence: { observed: false },
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.confirmedGa4Events.length, 1);
  assert.equal(result.unresolvedGa4Candidates.length, 0);
  assert.deepEqual(result.measurementIds, ["G-ABC"]);
});

test("exact URL matching is never fuzzy: a GA4 event naming a different page is left as an unresolved candidate, never silently attributed", () => {
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [ga4Event({ params: { dl: "https://example.com/SOME-OTHER-PAGE" } })],
    dataLayerPushesInWindow: [],
    captureHealth: healthyCaptureHealth,
    consentRequired: false,
    consentEvidence: { observed: false },
  });
  assert.equal(result.status, "CORRELATION_UNRESOLVED");
  assert.equal(result.confirmedGa4Events.length, 0);
  assert.equal(result.unresolvedGa4Candidates.length, 1);
});

test("WEBSITE_NO_OBSERVED_TAG: healthy, complete capture window with no evidence at all", () => {
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [],
    dataLayerPushesInWindow: [],
    captureHealth: healthyCaptureHealth,
    consentRequired: false,
    consentEvidence: { observed: false },
  });
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

  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: true,
    dataLayerHasNewEntries: true,
    ga4EventsInWindow: [],
    dataLayerPushesInWindow: [],
    captureHealth: unhealthy,
    consentRequired: false,
    consentEvidence: { observed: false },
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
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [],
    dataLayerPushesInWindow: [],
    captureHealth: healthyCaptureHealth,
    consentRequired: true,
    consentEvidence: { observed: false },
  });
  assert.equal(result.status, "CAPTURE_UNCERTAIN_CONSENT_STATE");
});

test("consent required and analytics_storage=granted observed: consent gate passes, falls through to ordinary classification", () => {
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: false,
    dataLayerHasNewEntries: false,
    ga4EventsInWindow: [ga4Event({ params: { dl: "https://example.com/destination" } })],
    dataLayerPushesInWindow: [],
    captureHealth: healthyCaptureHealth,
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

test("dataLayer push in the window matching resultingUrl is confirmed even when dataLayerDelta itself was replaced (the click-before-navigation recovery)", () => {
  const health = computeCaptureHealth({
    isClick: true,
    dataLayerReplaced: true,
    dataLayerPushListenerActive: true,
    networkListenerActive: true,
    dataLayerPushesObservedInWindowCount: 1,
    dataLayerModuleRequested: true,
    ga4ModuleRequested: false,
  });
  const result = classifyActionAnalyticsCapture({
    resultingUrl: "https://example.com/destination",
    dataLayerReplaced: true,
    dataLayerHasNewEntries: true,
    ga4EventsInWindow: [],
    dataLayerPushesInWindow: [dataLayerPush({ url: "https://example.com/destination" })],
    captureHealth: health,
    consentRequired: false,
    consentEvidence: { observed: false },
  });
  assert.equal(result.status, "CAPTURED");
  assert.equal(result.confirmedDataLayerPushes.length, 1);
});
