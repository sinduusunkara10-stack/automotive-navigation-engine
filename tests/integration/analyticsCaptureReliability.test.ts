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
 * Coverage for the analytics-capture reliability fix (see the real-site CTA-click
 * investigation): actionId, real physicalClickDispatchedAt/captureWindow timestamps, the
 * dataLayer-push-window recovery of a click event a full-navigation-replaced dataLayerDelta
 * would otherwise lose, and the classifyActionAnalyticsCapture status this all feeds.
 */

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
    schemaVersion: "1.26.0",
    taskId: "analytics-capture-reliability",
    objective: "Exercise the analytics-capture reliability fix.",
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
    outputSchemaVersion: "1.27.0",
    ...overrides,
  };
}

test("actionId is present, stable, and joinable between the CtaClickCapture record and its own actionAnalytics", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/start.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/continue/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    assert.equal(click.actionId, `${task.taskId}:action:${click.stepIndex}`);
    assert.equal(click.actionAnalytics?.actionId, click.actionId, "actionId must match between the parent record and actionAnalytics");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("real timestamps: physicalClickDispatchedAt precedes captureWindowEndedAt, both precede the final (serialisation-time) timestamp", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/start.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/continue/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    const analytics = click.actionAnalytics;
    assert.ok(analytics?.physicalClickDispatchedAt, "expected a real physical click-dispatch timestamp");
    assert.ok(analytics?.captureWindowStartedAt);
    assert.ok(analytics?.captureWindowEndedAt);

    const dispatchedAt = Date.parse(analytics!.physicalClickDispatchedAt!);
    const windowStartedAt = Date.parse(analytics!.captureWindowStartedAt!);
    const windowEndedAt = Date.parse(analytics!.captureWindowEndedAt!);
    const serialisedAt = Date.parse(click.timestamp);

    assert.ok(windowStartedAt <= dispatchedAt, "capture window must open before or at the moment of physical dispatch");
    assert.ok(dispatchedAt <= windowEndedAt, "physical dispatch must fall inside its own capture window");
    assert.ok(
      windowEndedAt <= serialisedAt,
      "the record's own final timestamp (action-serialisation time, read last) must never be earlier than when its capture window closed",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("healthy end-to-end click: analyticsCapture.status is CAPTURED with a URL-matched GA4 event, and captureHealth reports a complete window", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/start.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/continue/i) });

    const click = response.captures.cta_clicks?.[0];
    const analytics = click?.actionAnalytics;
    assert.ok(analytics?.captureHealth);
    assert.equal(analytics?.captureHealth?.captureComplete, true);
    assert.equal(analytics?.captureHealth?.dataLayerPushListenerActive, true);

    assert.ok(analytics?.analyticsCapture);
    assert.equal(analytics?.analyticsCapture?.status, "CAPTURED");
    assert.ok(
      analytics?.analyticsCapture?.confirmedGa4Events.some((e) => e.requestUrl.includes("/g/collect")),
      "expected step2.html's own GA4 beacon (dl matching resultingUrl exactly) to be a confirmed event, not merely 'observed nearby'",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("click-before-navigation race (analytics-race-start.html): the click handler's own dataLayer.push is lost from dataLayerDelta (replaced=true) but recovered by dataLayerPushesObservedDuringActionWindow", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-race-start.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/request a quote/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    const analytics = click.actionAnalytics;
    assert.ok(analytics);

    assert.equal(analytics?.dataLayerDelta?.replaced, true, "a full navigation resets the JS context/dataLayer");
    assert.ok(
      !analytics?.dataLayerDelta?.newEntries.some((e) => e.event === "generate_lead"),
      "the before/after diff alone must NOT see the click's own push -- it only reflects the destination page's fresh dataLayer",
    );

    assert.ok(analytics?.dataLayerPushesObservedDuringActionWindow, "expected the real-time push-observer window to be present");
    const recovered = analytics!.dataLayerPushesObservedDuringActionWindow!.flatMap((entry) => entry.raw);
    assert.ok(
      recovered.some((e) => e.event === "generate_lead" && e.fictionalId === "FIX-RACE-001"),
      "the click handler's own dataLayer.push (fired immediately before the synchronous navigation) must be recovered here even though dataLayerDelta lost it",
    );

    // URL-gate correction: this recovered push carries no page_location/full_url field at
    // all (its raw payload is just {event, cta, fictionalId}), so it is never excluded as
    // "a genuinely different destination" -- window ownership (PHYSICAL_CLICK segment,
    // observed before the click's own actionResult resolved) is itself sufficient
    // confirming evidence, exactly per the CLICK EVENT rule ("do not require the browser
    // resulting URL to match the analytics destination URL"). CAPTURED, never left
    // unresolved and never WEBSITE_NO_OBSERVED_TAG.
    assert.ok(analytics?.analyticsCapture);
    assert.equal(analytics?.analyticsCapture?.status, "CAPTURED");
    assert.equal(analytics?.analyticsCapture?.triggerSegment, "PHYSICAL_CLICK");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("URL-gate correction: a linker/tracking parameter on the browser's own resulting URL never overwrites the destination page's own analyticsPageLocation/analyticsFullUrl, and both original URLs are preserved unchanged", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-linker-source.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/continue/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    const analytics = click.actionAnalytics;
    const capture = analytics?.analyticsCapture;
    assert.ok(capture);
    assert.equal(capture?.status, "CAPTURED");

    const canonicalDestination = `${baseUrl}/analytics-linker-destination.html`;
    const browserResultingUrl = `${canonicalDestination}?_gl=1*abc123*_ga*fictionalClientId`;

    // The analytics-emitted values are the primary reporting evidence -- never overwritten
    // by the browser's own resulting URL, even though that URL still carries the CTA's own
    // _gl linker parameter.
    assert.equal(capture?.analyticsPageLocation, canonicalDestination);
    assert.equal(capture?.analyticsFullUrl, canonicalDestination);

    // Original URL values are always preserved, byte-for-byte, on both the classification
    // summary and the parent CtaClickCapture record.
    assert.equal(capture?.browserResultingUrl, browserResultingUrl);
    assert.equal(capture?.ctaElementDestinationUrl, browserResultingUrl);
    assert.equal(click.destinationUrl, browserResultingUrl);
    assert.equal(click.resultingUrl, browserResultingUrl);

    // Diagnostic-only: the two forms of the same destination differ only by a known
    // tracking parameter -- never treated as a mismatch requiring exclusion.
    assert.equal(capture?.urlRelationship, "TRACKING_PARAMETERS_ONLY_DIFFERENCE");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("VIRTUAL PAGE OR FORM STATE: an SPA virtual-page/step progression is confirmed even though the browser URL never changes", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-virtual-page.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/continue to step 2/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    assert.equal(click.resultingUrl, `${baseUrl}/analytics-virtual-page.html`, "the browser URL never changes for this SPA step");

    const capture = click.actionAnalytics?.analyticsCapture;
    assert.ok(capture);
    assert.equal(capture?.status, "CAPTURED");
    assert.equal(capture?.analyticsVirtualPageUrl, "/configurator/step-2");
    assert.equal(capture?.analyticsVirtualPageMetadata?.pageName, "configurator_step_2");
    assert.equal(capture?.analyticsVirtualPageMetadata?.stepNumber, 2);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a genuinely unrelated analytics destination observed in the click's own window (no navigation, no confirming signal) remains CORRELATION_UNRESOLVED", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/analytics-unrelated-destination.html` });
    const response = await runTask({ page, task, reasoning: new ClickOnceThenStopSuccessProvider(/click me/i) });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    const capture = click.actionAnalytics?.analyticsCapture;
    assert.ok(capture);
    assert.equal(capture?.status, "CORRELATION_UNRESOLVED");
    assert.equal(capture?.confirmedGa4Events.length, 0);
    assert.equal(capture?.unresolvedGa4Candidates.length, 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
