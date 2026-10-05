import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnalyticsReportingRowsItems, sanitizeUrl, sanitizeRawEvidenceJson } from "../../n8n/buildAnalyticsReportingRows.js";

/**
 * n8n reporting-row migration (owner-mandated corrective pass, follow-up to PR #71,
 * BLOCKER 2): fixture-based validation of n8n/buildAnalyticsReportingRows.js, the pure
 * transform behind the "Build Analytics Reporting Rows" Code node replacement. Proves the
 * production defect memory attributes to the OLD node (popup analytics silently dropped on a
 * failed run) cannot recur here, since this replacement never reconstructs or filters
 * evidence -- it passes the engine's own analyticsReportingRows straight through.
 */

function row(overrides: Record<string, unknown>) {
  return {
    runId: "run-1",
    taskId: "task-1",
    schemaVersion: "1.36.0",
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

test("successful same-tab run: all rows pass through unchanged, in journey order", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [
      row({ journeySequence: 2, recordType: "CTA_CLICK", eventRole: "PRIMARY_CLICK", eventClassification: "CLICK_EVENT" }),
      row({ journeySequence: 1 }),
    ],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.json.journeySequence, 1);
  assert.equal(items[1]!.json.journeySequence, 2);
});

test("failed popup run with valid popup analytics: produces more than only START_PAGE, and the popup rows are tagged rejected", () => {
  const response = {
    status: "failed",
    analyticsReportingRows: [
      row({ journeySequence: 1 }),
      row({
        journeySequence: 2,
        recordType: "CTA_CLICK",
        eventRole: "PRIMARY_CLICK",
        eventClassification: "CLICK_EVENT",
        stepIndex: 1,
        navigationSuccessful: false,
        actionSuccessful: true,
      }),
      row({
        journeySequence: 3,
        recordType: "ANALYTICS_EVENT",
        eventRole: "ASSOCIATED_RESULT",
        eventClassification: "CLICK_EVENT",
        evidenceSource: "popup_context",
        contextId: "popup:1",
        stepIndex: 1,
        eventName: "generate_lead",
      }),
    ],
    diagnostics: {
      surfaceAdoption: {
        attempts: [{ stepIndex: 1, surfaceId: "n/a", event: "rejected" }],
        returnAttempts: 0,
      },
    },
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.ok(items.length > 1, "a failed run with valid popup analytics must produce more than only START_PAGE");
  const popupRow = items.find((i) => i.json.evidenceSource === "popup_context");
  assert.ok(popupRow, "expected the popup analytics row to be preserved on a failed run");
  assert.equal(popupRow?.json.adoptionStatus, "rejected");
});

test("adopted-popup run: the popup row is tagged adopted, and later tagged with its terminal event once the surface closes", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [
      row({ journeySequence: 1 }),
      row({
        journeySequence: 2,
        recordType: "ANALYTICS_EVENT",
        eventRole: "ASSOCIATED_RESULT",
        eventClassification: "CLICK_EVENT",
        evidenceSource: "popup_context",
        contextId: "popup:1",
        stepIndex: 1,
        eventName: "config_finished",
      }),
      row({
        journeySequence: 3,
        recordType: "CTA_CLICK",
        eventRole: "PRIMARY_CLICK",
        eventClassification: "CLICK_EVENT",
        evidenceSource: "main_frame",
        contextId: "main",
        stepIndex: 5,
      }),
    ],
    diagnostics: {
      surfaceAdoption: {
        attempts: [
          { stepIndex: 1, surfaceId: "adopted-1", event: "adopted" },
          { stepIndex: 5, surfaceId: "adopted-1", event: "closed_unexpectedly" },
        ],
        returnAttempts: 0,
      },
    },
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  const popupRow = items.find((i) => i.json.evidenceSource === "popup_context");
  const mainRow = items.find((i) => i.json.evidenceSource === "main_frame");
  assert.equal(popupRow?.json.adoptionStatus, "closed_unexpectedly");
  assert.equal(mainRow?.json.adoptionStatus, "not_applicable");
});

test("rejected-popup run: rows are preserved (never discarded because the opener URL did not change or navigation failed)", () => {
  const response = {
    status: "failed",
    analyticsReportingRows: [
      row({ journeySequence: 1 }),
      row({
        journeySequence: 2,
        recordType: "CTA_CLICK",
        eventRole: "PRIMARY_CLICK",
        eventClassification: "CLICK_EVENT",
        stepIndex: 2,
        sourcePageUrl: "http://127.0.0.1/source.html",
        browserResultingUrl: "http://127.0.0.1/source.html", // opener URL unchanged
        navigationSuccessful: false,
        actionSuccessful: true,
      }),
      row({
        journeySequence: 3,
        recordType: "ANALYTICS_EVENT",
        eventRole: "ASSOCIATED_RESULT",
        eventClassification: "CLICK_EVENT",
        evidenceSource: "popup_context",
        contextId: "popup:2",
        stepIndex: 2,
        eventName: "view_offer",
      }),
    ],
    diagnostics: {
      surfaceAdoption: { attempts: [{ stepIndex: 2, surfaceId: "n/a", event: "rejected" }], returnAttempts: 0 },
    },
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.equal(items.length, 3, "no row should be discarded because the opener URL was unchanged or navigation failed");
  const popupRow = items.find((i) => i.json.evidenceSource === "popup_context");
  assert.equal(popupRow?.json.adoptionStatus, "rejected");
});

test("never turns analytics into milestone completion: milestoneIdsCompleted is passed through exactly as given, never derived or added", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [
      row({
        journeySequence: 1,
        recordType: "CTA_CLICK",
        eventRole: "PRIMARY_CLICK",
        eventClassification: "CLICK_EVENT",
        eventName: "config_finished",
        // No milestoneIdsCompleted set by the engine, even though eventName looks milestone-like.
      }),
    ],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.equal(items[0]!.json.milestoneIdsCompleted, undefined);
});

test("deduplicates only truly equivalent records (same eventId), and preserves distinct ones", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [
      row({ journeySequence: 1, eventId: "evt_abc123" }),
      row({ journeySequence: 2, eventId: "evt_abc123" }), // accidental duplicate, same eventId
      row({ journeySequence: 3, eventId: "evt_def456" }),
    ],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.equal(items.length, 2);
  assert.deepEqual(
    items.map((i: { json: Record<string, unknown> }) => i.json.eventId),
    ["evt_abc123", "evt_def456"],
  );
});

test("preserves deterministic journey ordering even when the engine's own array arrives out of order", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [row({ journeySequence: 3 }), row({ journeySequence: 1 }), row({ journeySequence: 2 })],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.deepEqual(
    items.map((i: { json: Record<string, unknown> }) => i.json.journeySequence),
    [1, 2, 3],
  );
});

test("sanitizes sensitive query parameters and rawEvidenceJson keys, never emitting a session token or password", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [
      row({
        journeySequence: 1,
        recordType: "CTA_CLICK",
        eventRole: "PRIMARY_CLICK",
        eventClassification: "CLICK_EVENT",
        sourcePageUrl: "https://example-competitor-oem.test/offer?sessionToken=abc123&utm_source=x",
        rawEvidenceJson: JSON.stringify({ event: "generate_lead", password: "hunter2", cookie: "sid=xyz", vehicle_model: "Electric SUV" }),
      }),
    ],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  const out = items[0]!.json as Record<string, unknown>;
  assert.ok(!String(out.sourcePageUrl).includes("abc123"));
  assert.ok(String(out.sourcePageUrl).includes("utm_source=x"), "non-sensitive params must survive unchanged");
  const raw = JSON.parse(out.rawEvidenceJson as string);
  assert.equal(raw.password, "[redacted]");
  assert.equal(raw.cookie, "[redacted]");
  assert.equal(raw.vehicle_model, "Electric SUV");
});

test("sanitizeUrl/sanitizeRawEvidenceJson are no-ops on already-clean input", () => {
  assert.equal(sanitizeUrl("https://example.test/page?utm_source=x"), "https://example.test/page?utm_source=x");
  assert.equal(sanitizeUrl(undefined as unknown as string), undefined);
  assert.equal(sanitizeRawEvidenceJson("not json"), "not json");
});

test("backward compatible with 1.29.0 inputs: a schemaVersion 1.29.0 response is processed identically", () => {
  const response = {
    status: "success",
    analyticsReportingRows: [row({ journeySequence: 1, schemaVersion: "1.29.0" })],
    diagnostics: {},
  };
  const items = buildAnalyticsReportingRowsItems([response]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.json.schemaVersion, "1.29.0");
});

test("an empty analyticsReportingRows array (e.g. an early stop_blocked) produces zero items, not an error", () => {
  const items = buildAnalyticsReportingRowsItems([{ status: "blocked", analyticsReportingRows: [], diagnostics: {} }]);
  assert.deepEqual(items, []);
});
