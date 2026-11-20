import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnalyticsReportingRows } from "../../src/capture-modules/analyticsReportingRows.js";
import type { CtaClickCapture, DataLayerCapture, StepLog } from "../../src/types/task-response.js";

/**
 * Action markers: an adopted tab (keyed to the click that opened it) and a fill_form step each
 * get their own PAGE_VISIT marker with actionId `<taskId>:action:<step>`, so their evidence no
 * longer falls back to the start window. Journeys with neither are unchanged.
 */

const LANDING = "https://example.com/landing";
const FORM = "https://partner.example.com/form?x=1";
const CONFIRMATION = "https://partner.example.com/form/thank-you";

function step(stepIndex: number, type: StepLog["selectedAction"]["type"], currentUrl: string, actionResult: Partial<StepLog["actionResult"]> = {}): StepLog {
  return {
    stepIndex,
    timestamp: `2026-01-01T00:00:0${stepIndex}.000Z`,
    currentUrl,
    observation: { url: currentUrl, title: "", interactiveElements: [] },
    decision: type,
    selectedAction: { type },
    actionResult: { success: true, interactionOutcome: "IN_PAGE_STATE_CHANGE", ...actionResult },
    progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
  };
}

function push(stepIndex: number, url: string, event: string): DataLayerCapture {
  return { stepIndex, url, timestamp: `2026-01-01T00:00:0${stepIndex}.500Z`, raw: [{ event }], source: "main_frame" };
}

const openingClick: CtaClickCapture = {
  stepIndex: 0,
  timestamp: "2026-01-01T00:00:00.000Z",
  actionId: "task-1:action:0",
  sourcePageUrl: LANDING,
  ctaText: "Request a quote",
  elementType: "button",
  resultingUrl: FORM,
  resultingTitle: "Quote request form",
  navigationSucceeded: true,
  actionSucceeded: true,
};

function rowsFor(events: DataLayerCapture[], steps: StepLog[], ctaClicks: CtaClickCapture[] = [openingClick]) {
  return buildAnalyticsReportingRows({
    taskId: "task-1",
    startUrl: LANDING,
    schemaVersion: "1.53.0",
    pageVisits: [],
    ctaClicks,
    steps,
    startPageUrl: LANDING,
    startPageTitle: "Landing",
    dataLayerEvidence: events,
  });
}

function actionIdOf(rows: ReturnType<typeof rowsFor>, event: string): string | undefined {
  return rows.find((row) => row.recordType === "ANALYTICS_EVENT" && JSON.stringify(row).includes(event))?.actionId;
}

const adoptedJourney: StepLog[] = [
  step(0, "click", LANDING, { surfaceAdopted: true, resultingUrl: FORM, verifiedSuccessType: "new_context_adopted" }),
  step(1, "scroll", FORM),
  step(2, "scroll", FORM),
  step(3, "fill_form", FORM),
];

test("adopted tab: form evidence reports under the opening click's marker, not :start", () => {
  const rows = rowsFor([push(1, FORM, "form_view"), push(2, FORM, "form_scrolled")], adoptedJourney);
  assert.equal(actionIdOf(rows, "form_view"), "task-1:action:0");
  assert.equal(actionIdOf(rows, "form_scrolled"), "task-1:action:0", "earlier evidence is not pulled forward into the later fill_form marker");

  const marker = rows.find((row) => row.recordType === "PAGE_VISIT" && row.actionId === "task-1:action:0");
  assert.equal(marker?.sourcePageUrl, FORM);
  assert.equal(marker?.destinationPageTitle, "Quote request form");
  assert.ok(!rows.some((row) => row.actionId === "task-1:start"));
});

test("fill_form: its own submit and confirmation evidence get their own marker", () => {
  const rows = rowsFor([push(3, FORM, "form_submit"), push(4, CONFIRMATION, "form_confirmation")], adoptedJourney);
  assert.equal(actionIdOf(rows, "form_submit"), "task-1:action:3");
  assert.equal(actionIdOf(rows, "form_confirmation"), "task-1:action:3");

  const marker = rows.find((row) => row.recordType === "PAGE_VISIT" && row.actionId === "task-1:action:3");
  assert.equal(marker?.stepIndex, 3);
  assert.equal(marker?.sourcePageUrl, FORM);
  const evidence = rows.filter((row) => row.recordType === "ANALYTICS_EVENT" && row.actionId === "task-1:action:3");
  assert.ok(evidence.every((row) => row.stepIndex === 3));
});

test("single-tab journey with no adoption and no fill_form is unchanged", () => {
  const sameTabClick: CtaClickCapture = { ...openingClick, stepIndex: 1, actionId: "task-1:action:1", resultingUrl: "https://example.com/next" };
  const steps = [step(0, "scroll", LANDING), step(1, "click", LANDING, { resultingUrl: "https://example.com/next" }), step(2, "scroll", "https://example.com/next")];
  const events = [push(0, LANDING, "landing_view"), push(2, "https://example.com/next", "next_scrolled")];
  assert.deepEqual(rowsFor(events, steps, [sameTabClick]), rowsFor(events, [], [sameTabClick]));
  assert.ok(!rowsFor(events, steps, [sameTabClick]).some((row) => row.recordType === "PAGE_VISIT"));
});
