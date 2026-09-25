import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyActionAnalyticsCapture, computeCaptureHealth } from "../../src/capture-modules/analyticsCaptureClassification.js";
import { buildAnalyticsReportingRows, type AnalyticsReportingRow } from "../../src/capture-modules/analyticsReportingRows.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";
import type {
  ActionAnalytics,
  CtaClickCapture,
  DataLayerCapture,
  Ga4NetworkEventCapture,
  PageVisitCapture,
  TaskResponse,
} from "../../src/types/task-response.js";

/**
 * Fixture-driven regression coverage for the engine-owned analytics reporting contract
 * (src/capture-modules/analyticsReportingRows.ts). Every fixture here is synthetic, generic
 * evidence shaped exactly like what capture-modules/{dataLayer,ga4NetworkEvents}.ts already
 * produce -- brand names appearing in a test's own title/fixture data (TEST1/TEST2/TEST13)
 * are historical/style labels only, never production branching logic (see
 * tests/unit/noBrandSpecificLogic.test.ts, which scans src/ for exactly this).
 */

function ga4Event(overrides: Partial<Ga4NetworkEventCapture> = {}): Ga4NetworkEventCapture {
  return {
    stepIndex: 1,
    requestUrl: "https://www.google-analytics.com/g/collect?v=2",
    timestamp: "2026-01-01T00:00:00.000Z",
    method: "GET",
    source: "main_frame",
    ...overrides,
  };
}

function dataLayerPush(overrides: Partial<DataLayerCapture> = {}): DataLayerCapture {
  return {
    stepIndex: 1,
    url: "https://example.com/destination",
    timestamp: "2026-01-01T00:00:00.000Z",
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

/**
 * Builds a real ActionAnalytics by calling the actual classifyActionAnalyticsCapture (never
 * a hand-constructed AnalyticsCaptureSummary) so classifiedEvidence's ga4Event/dataLayerPush
 * entries are reference-equal to the window arrays passed in -- required for
 * analyticsReportingRows.ts's own triggerSegment reuse-by-reference to find matches.
 */
function buildAction(params: {
  actionId?: string;
  ctaElementDestinationUrl?: string;
  browserResultingUrl?: string;
  ctaText?: string;
  ctaAccessibleName?: string;
  ga4Events?: Ga4NetworkEventCapture[];
  dataLayerPushes?: DataLayerCapture[];
}): ActionAnalytics {
  const ga4EventsInWindow = params.ga4Events ?? [];
  const dataLayerPushesInWindow = params.dataLayerPushes ?? [];
  const analyticsCapture = classifyActionAnalyticsCapture({
    ctaElementDestinationUrl: params.ctaElementDestinationUrl,
    browserResultingUrl: params.browserResultingUrl,
    ctaText: params.ctaText,
    ctaAccessibleName: params.ctaAccessibleName,
    dataLayerReplaced: false,
    dataLayerHasNewEntries: dataLayerPushesInWindow.length > 0,
    ga4EventsInWindow,
    dataLayerPushesInWindow,
    ga4EventsBeforeMid: ga4EventsInWindow,
    dataLayerPushesBeforeMid: dataLayerPushesInWindow,
    captureHealth: healthyCaptureHealth,
    consentRequired: false,
    consentEvidence: { observed: false },
  });
  return {
    actionId: params.actionId ?? "task-1:action:1",
    ga4RequestsObservedDuringActionWindow: ga4EventsInWindow,
    dataLayerPushesObservedDuringActionWindow: dataLayerPushesInWindow,
    captureHealth: healthyCaptureHealth,
    analyticsCapture,
    advancedJourney: true,
  };
}

function ctaClick(overrides: Partial<CtaClickCapture> = {}): CtaClickCapture {
  return {
    stepIndex: 1,
    timestamp: "2026-01-01T00:00:01.000Z",
    actionId: "task-1:action:1",
    sourcePageUrl: "https://example.com/source",
    ctaText: "Discover",
    elementType: "a",
    destinationUrl: "https://example.com/destination",
    resultingUrl: "https://example.com/destination",
    navigationSucceeded: true,
    actionSucceeded: true,
    ...overrides,
  };
}

function analyticsEventRows(rows: AnalyticsReportingRow[]): AnalyticsReportingRow[] {
  return rows.filter((row) => row.recordType === "ANALYTICS_EVENT");
}

// TEST1: bundled dataLayer evidence -- a single dataLayer.push() argument that is itself an
// array genuinely wrapping two distinct event objects must expand into two distinct rows,
// each with its own rawEntryIndex, neither dropped nor coalesced.
test("TEST1 [fixture label: Vauxhall-style bundled configurator push]: a genuine 2-event dataLayer bundle expands into two distinct rows with increasing rawEntryIndex, never dropped", () => {
  const bundledPush = dataLayerPush({
    raw: [
      [
        { event: "virtual_page_view", virtualPageUrl: "/config/step-a", pageName: "Configurator Step A" },
        { event: "virtual_page_view", virtualPageUrl: "/config/step-b", pageName: "Configurator Step B" },
      ],
    ] as unknown as Record<string, unknown>[],
  });
  const action = buildAction({ dataLayerPushes: [bundledPush] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 2);
  assert.equal(eventRows[0]!.eventRole, "ASSOCIATED_RESULT");
  assert.equal(eventRows[0]!.eventClassification, "VIRTUAL_PAGE_CHANGE");
  assert.equal(eventRows[0]!.analyticsVirtualPageUrl, "/config/step-a");
  assert.equal(eventRows[1]!.analyticsVirtualPageUrl, "/config/step-b");
  assert.notEqual(eventRows[0]!.eventId, eventRows[1]!.eventId);
  assert.equal(eventRows[0]!.correlationStatus, "CONFIRMED");
  assert.equal(eventRows[1]!.correlationStatus, "CONFIRMED");

  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "WEBSITE_NO_OBSERVED_CLICK_TAG");
  assert.equal(ctaRow.correlationStatus, "WEBSITE_NO_OBSERVED_TAG");
});

// TEST2: the SAME logical virtual-page event captured twice in one action's window -- once as
// raw:[event] (wrapped), once as raw:event (direct) -- must dedupe to exactly one row.
test("TEST2 [fixture label: Nissan-style duplicate virtual-page capture]: raw:[event] and raw:event representations of the same logical push dedupe to one confirmed row", () => {
  const wrapped = dataLayerPush({
    stepIndex: 2,
    timestamp: "2026-01-01T00:00:02.000Z",
    raw: [[{ event: "virtual_page_view", virtualPageUrl: "/config/step2", pageName: "Configurator Step 2" }]] as unknown as Record<
      string,
      unknown
    >[],
  });
  const direct = dataLayerPush({
    stepIndex: 2,
    timestamp: "2026-01-01T00:00:02.000Z",
    raw: [{ event: "virtual_page_view", virtualPageUrl: "/config/step2", pageName: "Configurator Step 2" }],
  });
  const action = buildAction({ dataLayerPushes: [wrapped, direct] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]!.eventClassification, "VIRTUAL_PAGE_CHANGE");
  assert.equal(eventRows[0]!.correlationStatus, "CONFIRMED");
});

// TEST3: two CLICK_EVENT candidates in one action window naming genuinely different
// destinations must never be arbitrarily resolved to one primary -- both are reported as
// CLICK_CANDIDATE rows and the CTA_CLICK row carries no eventId.
test("TEST3: two click candidates with genuinely different destinations leave the CTA_CLICK row unresolved, emitting both as CLICK_CANDIDATE rows", () => {
  const candidateA = dataLayerPush({
    timestamp: "2026-01-01T00:00:03.000Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/option-a", eventLabel: "Option A" }],
  });
  const candidateB = dataLayerPush({
    timestamp: "2026-01-01T00:00:03.500Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/option-b", eventLabel: "Option B" }],
  });
  const action = buildAction({ dataLayerPushes: [candidateA, candidateB] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "CORRELATION_UNRESOLVED");
  assert.equal(ctaRow.correlationStatus, "UNRESOLVED");
  assert.equal(ctaRow.eventId, undefined);

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 2);
  assert.ok(eventRows.every((row) => row.eventRole === "CLICK_CANDIDATE" && row.correlationStatus === "UNRESOLVED"));
  assert.deepEqual(
    eventRows.map((row) => row.eventLabel).sort(),
    ["Option A", "Option B"],
  );
});

// TEST4: exactly one confirmed click candidate merges into the CTA_CLICK row itself -- never a
// separate PRIMARY_CLICK row.
test("TEST4: exactly one confirmed click candidate is merged into the CTA_CLICK row, not emitted as a separate row", () => {
  const click = dataLayerPush({
    timestamp: "2026-01-01T00:00:04.000Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/destination", eventLabel: "Discover" }],
  });
  const action = buildAction({
    ctaElementDestinationUrl: "https://example.com/destination",
    browserResultingUrl: "https://example.com/destination",
    ctaText: "Discover",
    dataLayerPushes: [click],
  });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  assert.equal(analyticsEventRows(rows).length, 0);
  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "CAPTURED");
  assert.equal(ctaRow.correlationStatus, "CONFIRMED");
  assert.ok(ctaRow.eventId);
  assert.equal(ctaRow.eventLabel, "Discover");
});

// TEST5: a confirmed GA4 page_view carrying rich metadata (title, measurement id, vehicle
// year) is preserved on its ASSOCIATED_RESULT row, never dropped or flattened away.
test("TEST5: a confirmed GA4 page_view with rich metadata preserves its fields on the ASSOCIATED_RESULT row", () => {
  const pageView = ga4Event({
    timestamp: "2026-01-01T00:00:05.000Z",
    params: {
      dl: "https://example.com/destination",
      page_title: "New Model Overview",
      tid: "G-XYZ123",
      vehicle_year: "2026",
    },
  });
  const action = buildAction({
    browserResultingUrl: "https://example.com/destination",
    ga4Events: [pageView],
  });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]!.eventClassification, "PHYSICAL_PAGE_CHANGE");
  assert.equal(eventRows[0]!.correlationStatus, "CONFIRMED");
  assert.equal(eventRows[0]!.pageTitle, "New Model Overview");
  assert.equal(eventRows[0]!.measurementId, "G-XYZ123");
  assert.equal(eventRows[0]!.vehicleYear, "2026");
  assert.equal(eventRows[0]!.analyticsPageLocation, "https://example.com/destination");
  assert.ok(eventRows[0]!.collectionEndpoint);
});

// TEST6: a confirmed click alongside a genuinely unresolved, unrelated event in the same
// action window -- the unresolved event must still be reported (never silently discarded)
// even though the click itself resolved cleanly.
test("TEST6: a confirmed click and an unrelated CORRELATION_UNRESOLVED event in the same window both surface, neither silently dropped", () => {
  const click = dataLayerPush({
    timestamp: "2026-01-01T00:00:06.000Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/destination", eventLabel: "Discover" }],
  });
  const unrelated = dataLayerPush({
    timestamp: "2026-01-01T00:00:06.200Z",
    raw: [{ page_location: "https://example.com/totally-unrelated-page" }],
  });
  const action = buildAction({
    ctaElementDestinationUrl: "https://example.com/destination",
    browserResultingUrl: "https://example.com/destination",
    ctaText: "Discover",
    dataLayerPushes: [click, unrelated],
  });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.correlationStatus, "CONFIRMED");
  assert.ok(ctaRow.eventId);

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 1);
  assert.equal(eventRows[0]!.eventRole, "RAW_CAPTURE_IN_ACTION_WINDOW");
  assert.equal(eventRows[0]!.eventClassification, "CORRELATION_UNRESOLVED");
  assert.equal(eventRows[0]!.correlationStatus, "UNRESOLVED");
  assert.equal(eventRows[0]!.correlationSource, "engine_action_window_raw_capture");
});

// TEST7: two objects that are semantically equivalent but serialised with different key order
// (including a nested object) canonicalise to the same eventId and dedupe to one row.
test("TEST7: equivalent objects with different (including nested) key order produce the same eventId", () => {
  const a = dataLayerPush({
    stepIndex: 3,
    timestamp: "2026-01-01T00:00:07.000Z",
    raw: [{ event: "virtual_page_view", virtualPageUrl: "/config/step3", extra: { b: 2, a: 1 } }],
  });
  const b = dataLayerPush({
    stepIndex: 3,
    timestamp: "2026-01-01T00:00:07.000Z",
    raw: [{ extra: { a: 1, b: 2 }, virtualPageUrl: "/config/step3", event: "virtual_page_view" }],
  });
  const action = buildAction({ dataLayerPushes: [a, b] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  assert.equal(analyticsEventRows(rows).length, 1);
});

// TEST8: same stepIndex/timestamp but genuinely different payloads must never collide -- the
// engine must never use event-name+timestamp alone as identity.
test("TEST8: same timestamp but different payloads produce different eventIds, both rows kept", () => {
  const a = dataLayerPush({
    timestamp: "2026-01-01T00:00:08.000Z",
    raw: [{ event: "virtual_page_view", virtualPageUrl: "/step/1", pageName: "Step 1" }],
  });
  const b = dataLayerPush({
    timestamp: "2026-01-01T00:00:08.000Z",
    raw: [{ event: "virtual_page_view", virtualPageUrl: "/step/2", pageName: "Step 2" }],
  });
  const action = buildAction({ dataLayerPushes: [a, b] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 2);
  assert.notEqual(eventRows[0]!.eventId, eventRows[1]!.eventId);
  // Same timestamp -> ordering falls back to eventId, so compare as a set, not a sequence.
  assert.deepEqual(
    eventRows.map((row) => row.analyticsVirtualPageUrl).sort(),
    ["/step/1", "/step/2"],
  );
});

// TEST9: raw:[singleEvent] (wrapped) and raw:singleEvent (direct) are the same event -- run the
// contract twice, identically except for that one shape difference, and confirm identical
// eventIds are produced independent of the shape.
test("TEST9: raw:[event] and raw:event produce identical eventIds for the same logical event", () => {
  const buildFor = (raw: Record<string, unknown>[]) => {
    const push = dataLayerPush({ stepIndex: 4, timestamp: "2026-01-01T00:00:09.000Z", raw });
    const action = buildAction({ dataLayerPushes: [push] });
    return buildAnalyticsReportingRows({
      taskId: "task-1",
      startUrl: "https://example.com/source",
      schemaVersion: "1.27.0",
      pageVisits: [],
      ctaClicks: [ctaClick({ actionAnalytics: action })],
    });
  };

  const wrappedRows = buildFor([[{ event: "virtual_page_view", virtualPageUrl: "/config/step4" }]] as unknown as Record<
    string,
    unknown
  >[]);
  const directRows = buildFor([{ event: "virtual_page_view", virtualPageUrl: "/config/step4" }]);

  const wrappedEvent = analyticsEventRows(wrappedRows)[0];
  const directEvent = analyticsEventRows(directRows)[0];
  assert.ok(wrappedEvent && directEvent);
  assert.equal(wrappedEvent.eventId, directEvent.eventId);
});

// TEST10: a genuine multi-entry array (three independent events pushed together) expands into
// three distinct rows in array order, none dropped or coalesced.
test("TEST10: a genuine 3-event dataLayer array expands into three distinct rows in order", () => {
  const bundle = dataLayerPush({
    raw: [
      [
        { event: "virtual_page_view", virtualPageUrl: "/config/a" },
        { event: "virtual_page_view", virtualPageUrl: "/config/b" },
        { event: "virtual_page_view", virtualPageUrl: "/config/c" },
      ],
    ] as unknown as Record<string, unknown>[],
  });
  const action = buildAction({ dataLayerPushes: [bundle] });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action })],
  });

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 3);
  assert.deepEqual(
    eventRows.map((row) => row.analyticsVirtualPageUrl),
    ["/config/a", "/config/b", "/config/c"],
  );
  assert.equal(new Set(eventRows.map((row) => row.eventId)).size, 3);
});

// TEST11: a website that emits no observed analytics tag at all must never be mislabeled as a
// failure and must never have a row fabricated for it.
test("TEST11: no observed analytics evidence produces WEBSITE_NO_OBSERVED_TAG, never a fabricated row or a failure label", () => {
  const action = buildAction({
    ctaElementDestinationUrl: "https://example.com/destination",
    browserResultingUrl: "https://example.com/destination",
  });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ actionAnalytics: action, actionSucceeded: true })],
  });

  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.recordType, "START_PAGE");
  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "WEBSITE_NO_OBSERVED_CLICK_TAG");
  assert.equal(ctaRow.correlationStatus, "WEBSITE_NO_OBSERVED_TAG");
  assert.equal(ctaRow.actionSuccessful, true);
});

// TEST12: exactly one START_PAGE row per run, built from the actual journey start (the first
// page visit), never from a later page_view.
test("TEST12: exactly one START_PAGE row is built from the actual journey start, never a later page_view", () => {
  const pageVisits: PageVisitCapture[] = [
    { stepIndex: 0, url: "https://example.com/start", title: "Start", timestamp: "2026-01-01T00:00:00.000Z" },
    { stepIndex: 5, url: "https://example.com/later-page", title: "Later Page", timestamp: "2026-01-01T00:05:00.000Z" },
  ];
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/start",
    schemaVersion: "1.27.0",
    pageVisits,
    ctaClicks: [],
  });

  const startRows = rows.filter((row) => row.recordType === "START_PAGE");
  assert.equal(startRows.length, 1);
  assert.equal(startRows[0]!.sourcePageUrl, "https://example.com/start");
  assert.equal(startRows[0]!.destinationPageTitle, "Start");
  assert.equal(rows[0]!.recordType, "START_PAGE");
});

// TEST13: an existing GA4-style rich CTA-click fixture (style reused from
// analyticsCaptureClassification.test.ts's own "DÉCOUVREZ-LA" fixture) attributes correctly.
test("TEST13 [fixture label: Stellantis-style GA4 CTA fixture]: a rich GA4 click-tag event is attributed as the confirmed primary click", () => {
  const clickEvent = ga4Event({
    timestamp: "2026-01-01T00:00:13.000Z",
    params: {
      dl: "https://example.com/source",
      link_url: "https://example.com/destination",
      eventLabel: "DÉCOUVREZ-LA",
      tid: "G-ABC",
    },
  });
  const action = buildAction({
    ctaElementDestinationUrl: "https://example.com/destination",
    browserResultingUrl: "https://example.com/destination",
    ctaText: "DÉCOUVREZ-LA",
    ga4Events: [clickEvent],
  });
  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/source",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [ctaClick({ ctaText: "DÉCOUVREZ-LA", actionAnalytics: action })],
  });

  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "CAPTURED");
  assert.equal(ctaRow.correlationStatus, "CONFIRMED");
  assert.equal(ctaRow.eventLabel, "DÉCOUVREZ-LA");
  assert.equal(ctaRow.measurementId, "G-ABC");
});

// TEST14: whole-contract integrity -- a realistic multi-action run's analyticsReportingRows
// embeds into a full TaskResponse that validates against the updated response schema, ordering
// invariants hold, and an empty analyticsReportingRows array is also schema-valid.
test("TEST14: the whole analytics reporting contract is deterministically ordered and schema-valid, including the empty-array case", async () => {
  const confirmedClick = dataLayerPush({
    stepIndex: 2,
    timestamp: "2026-01-01T00:01:00.000Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/step2", eventLabel: "Continue" }],
  });
  const actionOne = buildAction({
    actionId: "task-1:action:2",
    ctaElementDestinationUrl: "https://example.com/step2",
    browserResultingUrl: "https://example.com/step2",
    ctaText: "Continue",
    dataLayerPushes: [confirmedClick],
  });

  const unresolvedA = dataLayerPush({
    stepIndex: 3,
    timestamp: "2026-01-01T00:02:00.000Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/option-a", eventLabel: "Option A" }],
  });
  const unresolvedB = dataLayerPush({
    stepIndex: 3,
    timestamp: "2026-01-01T00:02:00.500Z",
    raw: [{ event: "gtm.linkClick", link_url: "https://example.com/option-b", eventLabel: "Option B" }],
  });
  const actionTwo = buildAction({
    actionId: "task-1:action:3",
    dataLayerPushes: [unresolvedA, unresolvedB],
  });

  const pageVisits: PageVisitCapture[] = [
    { stepIndex: 0, url: "https://example.com/start", title: "Start", timestamp: "2026-01-01T00:00:00.000Z" },
  ];
  const ctaClicks: CtaClickCapture[] = [
    ctaClick({
      stepIndex: 2,
      timestamp: "2026-01-01T00:01:01.000Z",
      actionId: "task-1:action:2",
      actionAnalytics: actionOne,
      ctaText: "Continue",
    }),
    ctaClick({
      stepIndex: 3,
      timestamp: "2026-01-01T00:02:01.000Z",
      actionId: "task-1:action:3",
      actionAnalytics: actionTwo,
      ctaText: "Pick a trim",
      sourcePageUrl: "https://example.com/step2",
      destinationUrl: undefined,
      resultingUrl: "https://example.com/step2",
    }),
  ];

  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    journeyType: "configurator_completion",
    startUrl: "https://example.com/start",
    schemaVersion: "1.27.0",
    pageVisits,
    ctaClicks,
  });

  // Ordering: START_PAGE first, then per action in step order (CTA_CLICK, candidates,
  // associated, raw), journeySequence contiguous from 1.
  assert.equal(rows[0]!.recordType, "START_PAGE");
  assert.deepEqual(
    rows.map((row) => row.journeySequence),
    rows.map((_, index) => index + 1),
  );
  const firstActionRows = rows.filter((row) => row.actionId === "task-1:action:2");
  assert.equal(firstActionRows.length, 1);
  assert.equal(firstActionRows[0]!.recordType, "CTA_CLICK");
  assert.equal(firstActionRows[0]!.correlationStatus, "CONFIRMED");

  const secondActionRows = rows.filter((row) => row.actionId === "task-1:action:3");
  assert.equal(secondActionRows[0]!.recordType, "CTA_CLICK");
  assert.equal(secondActionRows[0]!.correlationStatus, "UNRESOLVED");
  assert.equal(secondActionRows[1]!.eventRole, "CLICK_CANDIDATE");
  assert.equal(secondActionRows[2]!.eventRole, "CLICK_CANDIDATE");

  const response: TaskResponse = {
    schemaVersion: "1.27.0",
    taskId: "task-1",
    status: "success",
    statusReason: "stop_success_action",
    startUrl: "https://example.com/start",
    finalUrl: "https://example.com/step2",
    steps: [],
    captures: {},
    engineAssessment: { objectiveAchieved: true, confidence: 1, summary: "done" },
    diagnostics: { stepCount: 3, backtrackCount: 0, totalDurationMs: 1000, finishReason: "stop_success_action" },
    analyticsReportingRows: rows,
  };

  const validated = await validateAgainstTaskResponseSchema(response);
  assert.ok(validated.valid, validated.errorsText);

  const emptyResponse: TaskResponse = { ...response, analyticsReportingRows: [] };
  const validatedEmpty = await validateAgainstTaskResponseSchema(emptyResponse);
  assert.ok(validatedEmpty.valid, validatedEmpty.errorsText);
});

// TEST15 [fixture label: live Vauxhall-shaped regression]: a real production run reported
// primaryClickTagStatus=CORRELATION_UNRESOLVED for an action while emitting zero CLICK_CANDIDATE
// rows -- root cause was analyticsReportingRows.ts's own alias list missing destination_url/
// click_url (the old classifier's readDataLayerEvidenceFields already recognised both; see this
// module's "Field extraction" section doc comment), so a genuinely click-tagged dataLayer push
// was misclassified CORRELATION_UNRESOLVED instead of CLICK_EVENT and silently dropped from
// resolveClickTag's candidate set. Every distinct click-classified candidate for an unresolved
// action must be preserved as its own CLICK_CANDIDATE row, and a confirmed page-change event in
// the same window must still surface as ASSOCIATED_RESULT -- with a stable eventId and the
// correct correlationStatus everywhere, and no duplicate eventId across the whole action.
test("TEST15 [fixture label: live Vauxhall-shaped regression]: unresolved dataLayer click evidence using destination_url/click_url aliases is preserved as CLICK_CANDIDATE rows alongside a confirmed ASSOCIATED_RESULT, with eventId/correlationStatus present and schema-valid", async () => {
  const candidateA = dataLayerPush({
    stepIndex: 4,
    timestamp: "2026-01-01T00:03:00.000Z",
    raw: [{ event: "gtm.linkClick", destination_url: "https://example.com/model-a", eventLabel: "Model A" }],
  });
  const candidateB = dataLayerPush({
    stepIndex: 4,
    timestamp: "2026-01-01T00:03:00.500Z",
    raw: [{ event: "gtm.linkClick", click_url: "https://example.com/model-b", eventLabel: "Model B" }],
  });
  const confirmedVirtualPage = dataLayerPush({
    stepIndex: 4,
    timestamp: "2026-01-01T00:03:01.000Z",
    raw: [{ event: "virtual_page_view", virtualPageUrl: "/results", pageName: "Search Results" }],
  });
  const action = buildAction({
    actionId: "task-1:action:4",
    dataLayerPushes: [candidateA, candidateB, confirmedVirtualPage],
  });

  const rows = buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: "https://example.com/start",
    schemaVersion: "1.27.0",
    pageVisits: [],
    ctaClicks: [
      ctaClick({
        stepIndex: 4,
        timestamp: "2026-01-01T00:03:00.000Z",
        actionId: "task-1:action:4",
        actionAnalytics: action,
        ctaText: "See results",
        destinationUrl: undefined,
        resultingUrl: "https://example.com/results",
      }),
    ],
  });

  const ctaRow = rows.find((row) => row.recordType === "CTA_CLICK")!;
  assert.equal(ctaRow.primaryClickTagStatus, "CORRELATION_UNRESOLVED");
  assert.equal(ctaRow.correlationStatus, "UNRESOLVED");
  assert.equal(ctaRow.eventId, undefined);

  const eventRows = analyticsEventRows(rows);
  assert.equal(eventRows.length, 3);

  const clickCandidates = eventRows.filter((row) => row.eventRole === "CLICK_CANDIDATE");
  assert.equal(clickCandidates.length, 2);
  assert.ok(
    clickCandidates.every(
      (row) => row.eventClassification === "CLICK_EVENT" && row.correlationStatus === "UNRESOLVED" && Boolean(row.eventId),
    ),
  );
  assert.deepEqual(
    clickCandidates.map((row) => row.eventLabel).sort(),
    ["Model A", "Model B"],
  );

  const associated = eventRows.filter((row) => row.eventRole === "ASSOCIATED_RESULT");
  assert.equal(associated.length, 1);
  assert.equal(associated[0]!.eventClassification, "VIRTUAL_PAGE_CHANGE");
  assert.equal(associated[0]!.correlationStatus, "CONFIRMED");
  assert.ok(associated[0]!.eventId);
  assert.equal(associated[0]!.analyticsVirtualPageUrl, "/results");

  // No suppression of an unresolved candidate merely for appearing in classifiedEvidence, and
  // no duplicate eventId anywhere in the action's rows.
  const allEventIds = eventRows.map((row) => row.eventId);
  assert.equal(new Set(allEventIds).size, allEventIds.length);

  const response: TaskResponse = {
    schemaVersion: "1.27.0",
    taskId: "task-1",
    status: "success",
    statusReason: "stop_success_action",
    startUrl: "https://example.com/start",
    finalUrl: "https://example.com/results",
    steps: [],
    captures: {},
    engineAssessment: { objectiveAchieved: true, confidence: 1, summary: "done" },
    diagnostics: { stepCount: 4, backtrackCount: 0, totalDurationMs: 1000, finishReason: "stop_success_action" },
    analyticsReportingRows: rows,
  };

  const validated = await validateAgainstTaskResponseSchema(response);
  assert.ok(validated.valid, validated.errorsText);

  // event_id/correlation_status (eventId/correlationStatus on the wire, per this contract's
  // established camelCase naming -- see docs/n8n-analytics-reporting-migration.md) are present
  // in the serialised JSON, not merely on the in-memory TS object.
  const serialisedRows = JSON.parse(JSON.stringify(response)).analyticsReportingRows as Array<Record<string, unknown>>;
  for (const row of serialisedRows) {
    assert.ok("correlationStatus" in row, `row ${row.recordType}/${row.eventRole} missing correlationStatus`);
  }
  const serialisedClickCandidates = serialisedRows.filter((row) => row.eventRole === "CLICK_CANDIDATE");
  assert.equal(serialisedClickCandidates.length, 2);
  assert.ok(serialisedClickCandidates.every((row) => typeof row.eventId === "string" && row.eventId.length > 0));
});
