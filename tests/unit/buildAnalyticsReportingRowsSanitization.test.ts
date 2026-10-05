import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnalyticsReportingRowsItems } from "../../n8n/buildAnalyticsReportingRows.js";

/**
 * Owner-reported production defect (follow-up to PR #71): the previous n8n node assumed
 * analyticsReportingRows lived at one fixed top-level path, and its sanitisation missed real
 * visitor/session/linker identifiers in URLs and rawEvidenceJson. These tests are built against
 * the REAL shape of the "Navigation Engine - Get Task Result" node's output (an HTTP-Request-node
 * item: { headers, statusCode, statusMessage, body: { runId, taskId, status, result: {
 * analyticsReportingRows, diagnostics, ... } } }) and the real GA4/GTM evidence shape it carries,
 * using synthetic placeholder domains/ids in place of the real Opel fixture data supplied by the
 * owner (never committing real brand/customer identifiers, per CLAUDE.md).
 */

const SENSITIVE_CLIENT_ID = "1971267898.1790677638";
const SENSITIVE_SESSION_ID = "1790677638";
const SENSITIVE_ECID = "631938511";
const SENSITIVE_FPLC = "Hs5XCtr3mMpJsUVzx7MIu";
const SENSITIVE_GL_LINKER = "1*byyju5*_gcl_au*MTQ0MzUwODgwNi4xNzkwNjc3NjM4*_ga*MTk3MTI2Nzg5OC4xNzkwNjc3NjM4";
const SENSITIVE_GCLID = "EAIaIQobChMI-sensitive-gclid-value";
const SENSITIVE_SST_RND = "485039171.1790677638";
const MEASUREMENT_ID = "G-EXAMPLE123";
const COLLECTION_ENDPOINT = "https://sst.example-automotive-oem.com/g/collect";

function makeGa4RequestUrl(): string {
  const params = new URLSearchParams({
    v: "2",
    tid: MEASUREMENT_ID,
    cid: SENSITIVE_CLIENT_ID,
    sid: SENSITIVE_SESSION_ID,
    ecid: SENSITIVE_ECID,
    _fplc: SENSITIVE_FPLC,
    gtm: "45je69p1v870700086z",
    "sst.rnd": SENSITIVE_SST_RND,
    dl: `https://store.example-automotive-oem.com/summary?xUpstream=alternative&customBackUrl=${encodeURIComponent(
      `https://www.example-automotive-oem.com/vehicles?selected-trim=edition&gclid=${SENSITIVE_GCLID}`,
    )}`,
    dr: "https://www.example-automotive-oem.com/",
  });
  return `${COLLECTION_ENDPOINT}?${params.toString()}`;
}

function makePostDataRaw(): string {
  const doubleEncodedNestedUrl = encodeURIComponent(
    encodeURIComponent(`https://www.example-automotive-oem.com/back?gclid=${SENSITIVE_GCLID}&utm_source=paid`),
  );
  return [
    "en=page_view",
    "ep.vehicle_id=EX-1",
    `ep.full_url=${encodeURIComponent("https://store.example-automotive-oem.com/summary?xUpstream=alt")}`,
    `customBackUrl=${doubleEncodedNestedUrl}`,
    "evnid=undefined.3",
    "_fplc=" + SENSITIVE_FPLC,
  ].join("&");
}

function makeRawEvidenceJson(): string {
  return JSON.stringify({
    method: "POST",
    params: {
      cid: SENSITIVE_CLIENT_ID,
      sid: SENSITIVE_SESSION_ID,
      ecid: SENSITIVE_ECID,
      _fplc: SENSITIVE_FPLC,
      "sst.rnd": SENSITIVE_SST_RND,
      tid: MEASUREMENT_ID,
      gtm: "45je69p1v870700086z",
      dl: `https://store.example-automotive-oem.com/summary?customBackUrl=${encodeURIComponent(
        `https://www.example-automotive-oem.com/back?_gl=${SENSITIVE_GL_LINKER}`,
      )}`,
      dr: "https://www.example-automotive-oem.com/",
    },
    postDataParams: [
      {
        "ep.full_url": "https://store.example-automotive-oem.com/summary?xUpstream=alt",
        "ep.vehicle_id": "EX-1",
        "gtm.elementUrl": `https://www.example-automotive-oem.com/configure?gclid=${SENSITIVE_GCLID}`,
        evnid: "undefined.3",
      },
    ],
    postDataRaw: makePostDataRaw(),
    requestUrl: makeGa4RequestUrl(),
  });
}

function row(overrides: Record<string, unknown>) {
  return {
    runId: "run-1",
    taskId: "task-1",
    schemaVersion: "1.38.0",
    journeySequence: 1,
    recordType: "START_PAGE",
    stepIndex: 0,
    timestamp: "2026-09-28T00:00:00.000Z",
    eventRole: "START_PAGE",
    eventClassification: "JOURNEY_MARKER",
    correlationStatus: "NOT_APPLICABLE",
    ...overrides,
  };
}

function buildFullFixtureRows() {
  return [
    row({
      journeySequence: 1,
      sourcePageUrl: "https://www.example-automotive-oem.com/vehicles/model-x/overview.html",
    }),
    row({
      journeySequence: 2,
      recordType: "CTA_CLICK",
      eventRole: "PRIMARY_CLICK",
      eventClassification: "CLICK_EVENT",
      stepIndex: 1,
      eventId: "evt_click_1",
      evidenceSource: "main_frame",
      contextId: "main",
      ctaText: "Configure",
      sourcePageUrl: "https://www.example-automotive-oem.com/vehicles/model-x/overview.html",
      browserResultingUrl: `https://store.example-automotive-oem.com/summary?_gl=${SENSITIVE_GL_LINKER}&utm_source=organic`,
      actionSuccessful: true,
      navigationSuccessful: true,
    }),
    row({
      journeySequence: 3,
      recordType: "ANALYTICS_EVENT",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "PHYSICAL_PAGE_CHANGE",
      stepIndex: 1,
      eventId: "evt_analytics_main",
      evidenceSource: "main_frame",
      contextId: "main",
      eventName: "page_view",
      eventCategory: "Content::Configurator",
      eventAction: "Redirection::Summary",
      eventLabel: "Configure",
      pageName: "Retail/Summary",
      pageCategory: "basket page",
      formName: "quote-form",
      formCategory: "lead",
      stepName: "summary",
      stepNumber: 2,
      vehicleYear: "2026",
      measurementId: MEASUREMENT_ID,
      collectionEndpoint: COLLECTION_ENDPOINT,
      analyticsPageLocation: makeGa4RequestUrl(),
      analyticsReferrer: "https://www.example-automotive-oem.com/",
      analyticsFullUrl: makeGa4RequestUrl(),
      rawEvidenceJson: makeRawEvidenceJson(),
    }),
    row({
      journeySequence: 4,
      recordType: "ANALYTICS_EVENT",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "CLICK_EVENT",
      stepIndex: 2,
      eventId: "evt_popup_adopted",
      evidenceSource: "popup_context",
      contextId: "popup:2",
      eventName: "generate_lead",
      measurementId: MEASUREMENT_ID,
      rawEvidenceJson: makeRawEvidenceJson(),
    }),
    row({
      journeySequence: 5,
      recordType: "ANALYTICS_EVENT",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "CLICK_EVENT",
      stepIndex: 3,
      eventId: "evt_popup_rejected",
      evidenceSource: "popup_context",
      contextId: "popup:3",
      eventName: "view_offer",
    }),
    row({
      journeySequence: 6,
      recordType: "ANALYTICS_EVENT",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "VIRTUAL_PAGE_CHANGE",
      stepIndex: 4,
      eventId: "evt_nested_popup",
      evidenceSource: "popup_context",
      contextId: "popup:4",
      eventName: "config_finished",
      requestUrl: makeGa4RequestUrl(),
    }),
  ];
}

function buildDiagnostics() {
  return {
    surfaceAdoption: {
      attempts: [
        { stepIndex: 2, surfaceId: "adopted-1", event: "adopted" },
        { stepIndex: 3, surfaceId: "n/a", event: "rejected" },
        { stepIndex: 4, surfaceId: "adopted-2", event: "adopted" },
      ],
    },
  };
}

test("discovers analyticsReportingRows at every supported wrapper depth", () => {
  const rows = buildFullFixtureRows();
  const diagnostics = buildDiagnostics();
  const wrappers: Record<string, unknown>[] = [
    { analyticsReportingRows: rows, diagnostics },
    { body: { analyticsReportingRows: rows, diagnostics } },
    { result: { analyticsReportingRows: rows, diagnostics } },
    { body: { result: { analyticsReportingRows: rows, diagnostics } } },
    { body: { result: { result: { analyticsReportingRows: rows, diagnostics } } } },
    { data: { analyticsReportingRows: rows, diagnostics } },
    { response: { analyticsReportingRows: rows, diagnostics } },
    { taskResult: { analyticsReportingRows: rows, diagnostics } },
    { taskResponse: { analyticsReportingRows: rows, diagnostics } },
    { output: { analyticsReportingRows: rows, diagnostics } },
    // an unlisted, arbitrarily-nested shape -- only found via the bounded recursive fallback
    { payload: { taskOutput: { nested: { analyticsReportingRows: rows, diagnostics } } } },
    // the real "Get Task Result" HTTP-Request-node shape reported by the owner
    {
      headers: { "content-type": "application/json" },
      statusCode: 200,
      statusMessage: "OK",
      body: { runId: "run-1", taskId: "task-1", status: "completed", result: { analyticsReportingRows: rows, diagnostics } },
    },
  ];

  for (const wrapper of wrappers) {
    const items = buildAnalyticsReportingRowsItems([wrapper]);
    assert.equal(items.length, rows.length, `expected all rows discovered for wrapper shape ${JSON.stringify(Object.keys(wrapper))}`);
  }
});

test("missing analyticsReportingRows throws a descriptive error instead of silently returning no rows", () => {
  const badItem = { status: "completed", someOtherField: 1 };
  assert.throws(
    () => buildAnalyticsReportingRowsItems([badItem]),
    (err: Error) => {
      assert.match(err.message, /analyticsReportingRows/);
      assert.match(err.message, /item 1 of 1/);
      assert.match(err.message, /someOtherField/);
      assert.match(err.message, /status/);
      assert.match(err.message, /body\.result/);
      return true;
    },
  );
});

test("an empty analyticsReportingRows array is a valid (not missing) result", () => {
  const items = buildAnalyticsReportingRowsItems([{ body: { result: { analyticsReportingRows: [], diagnostics: {} } } }]);
  assert.deepEqual(items, []);
});

test("empty input array produces zero rows without throwing", () => {
  assert.deepEqual(buildAnalyticsReportingRowsItems([]), []);
});

test("preserves row count, journey order, record types, and evidence sources; only dedup changes count", () => {
  const rows = buildFullFixtureRows();
  const diagnostics = buildDiagnostics();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics } } },
  ]);

  assert.equal(items.length, rows.length);
  assert.deepEqual(
    items.map((i) => i.json.journeySequence),
    [1, 2, 3, 4, 5, 6],
  );
  const recordTypes = new Set(items.map((i) => i.json.recordType));
  assert.ok(recordTypes.has("START_PAGE"));
  assert.ok(recordTypes.has("CTA_CLICK"));
  assert.ok(recordTypes.has("ANALYTICS_EVENT"));

  const evidenceSources = items.map((i) => i.json.evidenceSource);
  assert.ok(evidenceSources.includes("main_frame"));
  assert.ok(evidenceSources.filter((s) => s === "popup_context").length === 3);

  const adopted = items.find((i) => i.json.eventId === "evt_popup_adopted");
  const rejected = items.find((i) => i.json.eventId === "evt_popup_rejected");
  const nested = items.find((i) => i.json.eventId === "evt_nested_popup");
  assert.equal(adopted?.json.adoptionStatus, "adopted");
  assert.equal(rejected?.json.adoptionStatus, "rejected");
  assert.equal(nested?.json.adoptionStatus, "adopted");

  // dedup: a duplicate eventId is the only thing allowed to change row count
  const dupItems = buildAnalyticsReportingRowsItems([
    {
      body: {
        result: {
          analyticsReportingRows: [...rows, row({ journeySequence: 7, eventId: "evt_popup_adopted" })],
          diagnostics,
        },
      },
    },
  ]);
  assert.equal(dupItems.length, rows.length, "duplicate eventId must be dropped, nothing else");
});

test("no sensitive raw value survives anywhere in the final output", () => {
  const rows = buildFullFixtureRows();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]);
  const serialized = JSON.stringify(items);

  for (const sensitive of [
    SENSITIVE_CLIENT_ID,
    SENSITIVE_SESSION_ID,
    SENSITIVE_ECID,
    SENSITIVE_FPLC,
    SENSITIVE_GL_LINKER,
    SENSITIVE_GCLID,
    SENSITIVE_SST_RND,
  ]) {
    assert.ok(!serialized.includes(sensitive), `sensitive value leaked: ${sensitive}`);
  }
  assert.ok(serialized.includes("[redacted]"));
});

test("top-level URL fields (browserResultingUrl) have sensitive query params redacted, non-sensitive ones kept", () => {
  const rows = buildFullFixtureRows();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]);
  const clickRow = items.find((i) => i.json.eventId === "evt_click_1")!.json as Record<string, unknown>;
  assert.ok(!String(clickRow.browserResultingUrl).includes(SENSITIVE_GL_LINKER));
  assert.ok(String(clickRow.browserResultingUrl).includes("_gl=%5Bredacted%5D") || String(clickRow.browserResultingUrl).includes("_gl=[redacted]"));
  assert.ok(String(clickRow.browserResultingUrl).includes("utm_source=organic"), "non-sensitive params must survive");
});

test("rawEvidenceJson and its raw_evidence_json alias are both sanitized, matching each other", () => {
  const rows = buildFullFixtureRows();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]);
  const analyticsRow = items.find((i) => i.json.eventId === "evt_analytics_main")!.json as Record<string, unknown>;

  assert.equal(analyticsRow.rawEvidenceJson, analyticsRow.raw_evidence_json);
  const parsed = JSON.parse(analyticsRow.rawEvidenceJson as string);
  assert.equal(parsed.params.cid, "[redacted]");
  assert.equal(parsed.params.sid, "[redacted]");
  assert.equal(parsed.params.ecid, "[redacted]");
  assert.equal(parsed.params._fplc, "[redacted]");
  assert.equal(parsed.params["sst.rnd"], "[redacted]");
  assert.equal(parsed.params.tid, MEASUREMENT_ID, "tid must remain");
  assert.equal(parsed.params.gtm, "45je69p1v870700086z", "non-identifier param must remain");
  assert.ok(!String(parsed.params.dl).includes(SENSITIVE_GCLID), "gclid nested inside dl's customBackUrl must be redacted");
  assert.equal(parsed.postDataParams[0].evnid, "[redacted]");
  assert.ok(!String(parsed.postDataParams[0]["gtm.elementUrl"]).includes(SENSITIVE_GCLID));
  assert.ok(!String(parsed.postDataRaw).includes(SENSITIVE_GCLID), "double-encoded gclid inside postDataRaw must be redacted");
  assert.ok(!String(parsed.postDataRaw).includes(SENSITIVE_FPLC));
  assert.ok(!String(parsed.requestUrl).includes(SENSITIVE_CLIENT_ID));
  assert.equal(new URL(parsed.requestUrl).searchParams.get("tid"), MEASUREMENT_ID);
});

test("Google _gl linker value is fully redacted, so no embedded _ga/_gcl_au/FPAU/_fplc value can leak", () => {
  const glUrl = `https://store.example-automotive-oem.com/summary?_gl=${SENSITIVE_GL_LINKER}`;
  const items = buildAnalyticsReportingRowsItems([
    {
      body: {
        result: {
          analyticsReportingRows: [row({ recordType: "CTA_CLICK", browserResultingUrl: glUrl, eventRole: "PRIMARY_CLICK", eventClassification: "CLICK_EVENT" })],
          diagnostics: {},
        },
      },
    },
  ]);
  const out = items[0]!.json as Record<string, unknown>;
  assert.ok(!String(out.browserResultingUrl).includes(SENSITIVE_GL_LINKER));
});

test("measurementId, tid, and business/event/page/form/step/vehicle fields all remain", () => {
  const rows = buildFullFixtureRows();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]);
  const analyticsRow = items.find((i) => i.json.eventId === "evt_analytics_main")!.json as Record<string, unknown>;

  assert.equal(analyticsRow.measurementId, MEASUREMENT_ID);
  assert.equal(analyticsRow.collectionEndpoint, COLLECTION_ENDPOINT);
  assert.equal(analyticsRow.eventName, "page_view");
  assert.equal(analyticsRow.eventCategory, "Content::Configurator");
  assert.equal(analyticsRow.pageName, "Retail/Summary");
  assert.equal(analyticsRow.pageCategory, "basket page");
  assert.equal(analyticsRow.formName, "quote-form");
  assert.equal(analyticsRow.stepName, "summary");
  assert.equal(analyticsRow.vehicleYear, "2026");
  assert.equal(new URL(analyticsRow.analyticsPageLocation as string).searchParams.get("tid"), MEASUREMENT_ID);
});

test("camelCase fields get snake_case aliases carrying the identical (sanitized) value", () => {
  const rows = buildFullFixtureRows();
  const items = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]);
  const clickRow = items.find((i) => i.json.eventId === "evt_click_1")!.json as Record<string, unknown>;
  assert.equal(clickRow.browser_resulting_url, clickRow.browserResultingUrl);
  assert.equal(clickRow.source_page_url, clickRow.sourcePageUrl);
  assert.equal(clickRow.journey_sequence, clickRow.journeySequence);
  assert.equal(clickRow.record_type, clickRow.recordType);
});

test("does not mutate the original input rows", () => {
  const rows = buildFullFixtureRows();
  const before = JSON.parse(JSON.stringify(rows));
  buildAnalyticsReportingRowsItems([{ body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } }]);
  assert.deepEqual(rows, before);
});

test("sanitizing already-sanitized output is idempotent", () => {
  const rows = buildFullFixtureRows();
  const firstPass = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: rows, diagnostics: buildDiagnostics() } } },
  ]).map((i) => i.json);

  const secondPass = buildAnalyticsReportingRowsItems([
    { body: { result: { analyticsReportingRows: firstPass, diagnostics: buildDiagnostics() } } },
  ]).map((i) => i.json);

  assert.deepEqual(secondPass, firstPass);
});

test("never hardcodes a brand, market, or domain: an unrelated brand's placeholder fixture is handled identically", () => {
  const otherBrandRows = [
    row({
      recordType: "ANALYTICS_EVENT",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "CLICK_EVENT",
      eventId: "evt_other_brand",
      browserResultingUrl: `https://config.example-competitor-oem.com/quote?client_id=${SENSITIVE_CLIENT_ID}&gclid=${SENSITIVE_GCLID}`,
    }),
  ];
  const items = buildAnalyticsReportingRowsItems([
    { response: { analyticsReportingRows: otherBrandRows, diagnostics: {} } },
  ]);
  const out = items[0]!.json as Record<string, unknown>;
  assert.ok(!String(out.browserResultingUrl).includes(SENSITIVE_CLIENT_ID));
  assert.ok(!String(out.browserResultingUrl).includes(SENSITIVE_GCLID));
});
