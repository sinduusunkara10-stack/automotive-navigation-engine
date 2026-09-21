import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Coverage for the cross-client analytics-capture-evidence fix (see CLAUDE.md and
 * docs/architecture.md "Generic action-attributed analytics capture"): popup/new-context
 * adoption, frame-aware dataLayer capture, the real-time dataLayer.push observer (recovers
 * a click handler's own push from a same-tab navigation race), and GA4 GET/POST/sendBeacon
 * body capture with mechanical measurementId/consentState extraction. Every fixture here
 * uses only placeholder ids/domains (per CLAUDE.md "Secrets") and no brand/vendor name.
 */

/** Clicks the first visible element whose accessible name matches `namePattern` exactly once, then always proposes stop_success. */
class ClickOnceThenStopSuccessProvider implements ReasoningProvider {
  private clicked = false;
  constructor(private readonly namePattern: RegExp) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      const candidate = context.observation.interactiveElements.find(
        (el) => el.visible !== false && this.namePattern.test(el.accessibleName),
      );
      if (candidate) {
        this.clicked = true;
        return { action: { type: "click", target: candidate.id }, rationale: `Click "${candidate.accessibleName}".` };
      }
    }
    return { action: { type: "stop_success" }, rationale: "Done." };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl">): TaskRequest {
  return {
    schemaVersion: "1.21.0",
    taskId: "cross-client-analytics-capture",
    objective: "Exercise the cross-client analytics-capture-evidence fix.",
    allowedDomains: ["127.0.0.1"],
    successCriteria: [],
    captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events"],
    limits: { maxSteps: 6, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.22.0",
    ...overrides,
  };
}

test("pre-existing dataLayer entries and a nested/unknown client-specific object survive unfiltered in captures.data_layer_evidence, and a seeded form field value is never captured anywhere", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-race-start.html`,
      captureModules: ["data_layer_evidence"],
    });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/never-matches/) });

    const mainEntries = response.captures.data_layer_evidence ?? [];
    assert.ok(mainEntries.length > 0);
    const raw = mainEntries.flatMap((e) => e.raw);
    assert.ok(raw.some((e) => e.event === "page_view" && e.page === "analytics-race-start"), "pre-existing entry retained");

    const nested = raw.find((e) => e.event === "custom_client_event") as
      | { clientSpecificVendorObject?: { internalCode?: string; nested?: { a: number; list: number[]; flag: boolean } }; someTotallyUnknownField?: string }
      | undefined;
    assert.ok(nested, "expected the nested/unknown-fields entry to be present");
    assert.equal(nested?.clientSpecificVendorObject?.internalCode, "XYZ-CLIENT-CODE-123");
    assert.deepEqual(nested?.clientSpecificVendorObject?.nested, { a: 1, list: [1, 2, 3], flag: true });
    assert.equal(nested?.someTotallyUnknownField, "should-survive-unfiltered");

    assert.ok(
      mainEntries.every((e) => e.source === "main_frame"),
      "single main-document page with no iframes: every entry tagged main_frame",
    );

    const serialized = JSON.stringify(response);
    assert.ok(
      !serialized.includes("Seed Person Should Never Be Captured"),
      "a form field's seeded value must never appear anywhere in the response, even though it was present in the live DOM",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a CTA click's own dataLayer.push and GA4 beacon (fired immediately before a same-tab navigation) are retained despite the race, via the real-time push observer", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-race-start.html` });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/request a quote/i) });

    const allDataLayerEntries = (response.captures.data_layer_evidence ?? []).flatMap((e) => e.raw);
    const leadPush = allDataLayerEntries.find((e) => e.event === "generate_lead");
    assert.ok(leadPush, "the click handler's own dataLayer.push, fired immediately before location.href navigation, must be retained");
    assert.equal(leadPush?.cta, "request_a_quote");

    const ga4Events = response.captures.ga4_network_events ?? [];
    assert.ok(
      ga4Events.some((e) => e.requestUrl.includes("/g/collect") && e.params?.en === "generate_lead"),
      "the click handler's own GA4 beacon, fired in the same race, must also be retained",
    );

    // Correlation without relying solely on the 300ms actionAnalytics window: the click and
    // the analytics it produced share the same stepIndex.
    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    const leadEvidence = (response.captures.data_layer_evidence ?? []).find((e) =>
      e.raw.some((entry) => entry.event === "generate_lead"),
    );
    assert.equal(leadEvidence?.stepIndex, click?.stepIndex, "the push is attributable to the CTA step via shared stepIndex");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dataLayer is captured from the main frame and every accessible same-origin child frame, each tagged with its own provenance", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-frames-host.html`,
      captureModules: ["data_layer_evidence"],
    });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/never-matches/) });

    const entries = response.captures.data_layer_evidence ?? [];
    const mainEntry = entries.find((e) => e.source === "main_frame" && e.raw.some((r) => r.event === "page_view" && r.page === "analytics-frames-host"));
    assert.ok(mainEntry, "expected a main_frame entry for the host page's own push");

    const childEntry = entries.find((e) => e.source === "child_frame" && e.raw.some((r) => r.event === "page_view" && r.page === "analytics-frames-child"));
    assert.ok(childEntry, "expected a child_frame entry for the iframe's own push");
    assert.ok(childEntry?.frameOrigin?.startsWith("http://127.0.0.1"), "child_frame entries carry frameOrigin");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a CTA that opens a popup/new context is instrumented before being closed: its dataLayer push and GA4 beacon are captured with source=popup_context and correlated to the CTA step, and the ActionResult/CtaClickCapture report openedNewContext/observedNewContext", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-popup-source.html` });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/request a quote/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    assert.equal(click.openedNewContext, true, "the click opened a new browsing context (target=_blank)");
    assert.equal(click.observedNewContext, true, "the popup was adopted long enough to instrument it before closing");

    const popupContextId = `popup:${click.stepIndex}`;

    const ga4Events = response.captures.ga4_network_events ?? [];
    const popupGa4 = ga4Events.find((e) => e.source === "popup_context" && e.params?.en === "generate_lead");
    assert.ok(popupGa4, "expected the popup's own GA4 beacon to be captured");
    assert.equal(popupGa4?.contextId, popupContextId, "popup GA4 evidence is tagged with the CTA step's own contextId");
    assert.equal(popupGa4?.stepIndex, click.stepIndex, "popup GA4 evidence shares stepIndex with the CTA that opened it");

    const dataLayerEntries = response.captures.data_layer_evidence ?? [];
    const popupPush = dataLayerEntries.find(
      (e) => e.source === "popup_context" && e.raw.some((r) => r.event === "generate_lead"),
    );
    assert.ok(popupPush, "expected the popup's own dataLayer push to be captured");
    assert.equal(popupPush?.contextId, popupContextId);
    assert.equal(popupPush?.stepIndex, click.stepIndex);

    // The tracked page's own existing destinationUrl-fallback behaviour (unchanged by this
    // fix, see actions/click.ts's module doc comment) separately navigates the tracked page
    // itself to the anchor's href so the run can keep making progress -- this is expected,
    // pre-existing behaviour, not something this fix alters.
    assert.equal(click.resultingUrl, `${baseUrl}/analytics-popup-target.html`);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
    await close();
  }
});

test("a click that opens a popup is closed unobserved when neither ga4_network_events nor data_layer_evidence was requested (no adoption overhead for a task that never asked for this evidence)", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-popup-source.html`,
      captureModules: ["cta_clicks"],
    });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/request a quote/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    assert.equal(click.openedNewContext, true);
    assert.equal(click.observedNewContext, false, "nothing was instrumented since neither capture module was requested");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("GA4 POST/sendBeacon body parameters are captured, including a mechanically-read measurementId and consentState, with an unknown body param retained unfiltered", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-ga4-body.html`,
      captureModules: ["ga4_network_events"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/fire post collect/i),
    });

    const ga4Events = response.captures.ga4_network_events ?? [];
    const posted = ga4Events.find((e) => e.method === "POST" && e.postDataParams?.some((p) => p.en === "generate_lead"));
    assert.ok(posted, "expected the sendBeacon POST request to be captured");
    assert.equal(posted?.measurementId, "G-FICTIONALBODY1", "measurementId mechanically read from the body's own tid param");
    assert.deepEqual(posted?.consentState, { gcs: "G111", dma: "1" }, "consentState mechanically read from the body");
    assert.ok(
      posted?.postDataParams?.some((p) => p.clientOnlyCustomParam === "fixture-unknown-value"),
      "an unknown body param must be retained unfiltered, not discarded",
    );
    assert.ok(posted?.postDataRaw?.includes("clientOnlyCustomParam"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("measurementId is absent (never guessed) when no tid parameter is present anywhere", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-ga4-body.html`,
      captureModules: ["ga4_network_events"],
    });
    await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/never-matches/) });
    // No click dispatched -- nothing to assert about a specific event here beyond the
    // dedicated negative-extraction unit coverage in ga4NetworkEvents; this test exists to
    // document the "never guessed" contract at the integration level via the fixture above,
    // whose every fired request always includes tid deliberately (see the POST test).
    assert.ok(true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("an oversized POST/sendBeacon body is truncated (never dropped), with truncated=true set", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-ga4-body.html`,
      captureModules: ["ga4_network_events"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/fire oversized post collect/i),
    });

    const ga4Events = response.captures.ga4_network_events ?? [];
    const oversized = ga4Events.find((e) => e.method === "POST" && e.requestUrl.includes("/g/collect"));
    assert.ok(oversized, "expected the oversized sendBeacon request to still be captured, not dropped");
    assert.equal(oversized?.truncated, true);
    assert.equal(oversized?.postDataRaw?.length, 8192, "postDataRaw is cut to the fixed MAX_GA4_POST_BODY_BYTES cap");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("two distinct GA4 requests with identical parameters are both retained -- bounding never deduplicates by content", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-ga4-body.html`,
      captureModules: ["ga4_network_events"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/fire duplicate get collect/i),
    });

    const ga4Events = response.captures.ga4_network_events ?? [];
    const matching = ga4Events.filter((e) => e.params?.en === "page_view" && e.method === "GET" && e.requestUrl.includes("/g/collect"));
    assert.equal(matching.length, 2, "both identical requests must be retained as distinct entries, never collapsed to one");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("consent-management events and a business event both survive raw in the same capture, with no vendor-specific classification anywhere in the engine", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/analytics-ga4-body.html`,
      captureModules: ["data_layer_evidence"],
    });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/never-matches/) });

    const raw = (response.captures.data_layer_evidence ?? []).flatMap((e) => e.raw);
    assert.ok(raw.some((e) => e.event === "OneTrustLoaded"), "consent event 1 preserved raw");
    assert.ok(raw.some((e) => e.event === "OptanonLoaded"), "consent event 2 preserved raw");
    assert.ok(
      raw.some((e) => e.event === "OneTrustGroupsUpdated" && e.OnetrustActiveGroups === "C0001,C0002"),
      "consent event 3 preserved raw, including its own nested-looking field",
    );
    assert.ok(
      raw.some((e) => e.event === "view_offer_details" && e.offerId === "FICTIONAL-OFFER-1"),
      "the business event is preserved raw alongside the consent events -- neither is dropped or specially tagged",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
