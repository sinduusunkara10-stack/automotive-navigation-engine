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
 * Coverage for the generic, journey-agnostic action-attributed analytics capture
 * mechanism (src/core/loop.ts + src/capture-modules/{ctaClicks,dataLayerDelta,
 * ga4NetworkEvents}.ts): for every successful click, captures.cta_clicks[].actionAnalytics
 * records a mechanical dataLayer delta, GA4 requests observed in a bounded post-click
 * window, the resulting page state, whether the click advanced the journey, and any
 * success criteria/semanticVerifier decisions attributable to it. One mechanism, reused
 * unchanged by every journey/fixture below -- no journey-specific branching anywhere in
 * the engine.
 */

/**
 * Clicks the first visible element whose accessible name matches `namePattern` exactly
 * once, then always proposes stop_success. Matches by accessible name, never by the
 * fixture's own HTML id attribute -- the engine assigns its own opaque element ids (see
 * observationBuilder.ts's data-nav-engine-id), so a fixture's id is never a valid lookup
 * key, matching the pattern already established in
 * tests/integration/requiredSuccessCriteriaEnforcement.test.ts's clickByName helper.
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
    schemaVersion: "1.5.0",
    taskId: "action-attributed-analytics",
    objective: "Exercise the generic action-attributed analytics capture mechanism.",
    allowedDomains: ["127.0.0.1"],
    successCriteria: [],
    captureModules: ["cta_clicks"],
    limits: { maxSteps: 6, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.5.0",
    ...overrides,
  };
}

test("a click that navigates: dataLayer delta is reported as replaced (fresh page context), GA4 requests in the post-click window are correlated, resultingTitle is captured, advancedJourney is true", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/continue/i),
    });

    assert.equal(response.status, "success");
    const click = response.captures.cta_clicks?.[0];
    assert.ok(click, "expected exactly one recorded click");
    assert.equal(click.resultingUrl, `${baseUrl}/step2.html`);
    assert.equal(click.resultingTitle, "Step Two");

    const analytics = click.actionAnalytics;
    assert.ok(analytics, "expected actionAnalytics to be present (cta_clicks + data_layer_evidence + ga4_network_events all requested)");
    assert.equal(analytics.advancedJourney, true);

    assert.ok(analytics.dataLayerDelta);
    assert.equal(analytics.dataLayerDelta?.available, true);
    assert.equal(analytics.dataLayerDelta?.replaced, true, "a full navigation starts a fresh JS context, never a valid suffix of the old array");
    assert.ok(
      analytics.dataLayerDelta?.newEntries.some((e) => e.page === "step2"),
      "expected step2.html's own dataLayer push to be reported as a new entry",
    );

    assert.ok(analytics.ga4RequestsObservedDuringActionWindow, "expected GA4 requests observed during the click's window");
    assert.ok(
      analytics.ga4RequestsObservedDuringActionWindow?.some((r) => r.requestUrl.includes("/g/collect")),
      "expected step2.html's own GA4 beacon to be correlated with this click",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("an SPA-style click that does not navigate: dataLayer delta is an appended suffix (not replaced), and a criterion satisfied by the click is attributed to it via newlySatisfiedCriteriaIds", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/spa-toggle.html`,
      captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events"],
      successCriteria: [
        {
          id: "trim-selected",
          type: "semantic_page_match",
          description: "Trim level selected and confirmed.",
          config: { minScore: 0.3 },
          required: false,
        },
      ],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/select trim level/i),
    });

    assert.equal(response.status, "success");
    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    assert.equal(click.navigationSucceeded, false, "an SPA click never navigates to a new URL");
    assert.equal(click.resultingTitle, "SPA Toggle", "the title is unchanged by an in-page toggle");

    const analytics = click.actionAnalytics;
    assert.ok(analytics);
    assert.ok(analytics.dataLayerDelta);
    assert.notEqual(analytics.dataLayerDelta?.replaced, true, "the array was appended to, not replaced");
    assert.equal(analytics.dataLayerDelta?.newEntries.length, 1);
    assert.equal(analytics.dataLayerDelta?.newEntries[0]?.event, "option_selected");

    assert.deepEqual(analytics.newlySatisfiedCriteriaIds, ["trim-selected"]);
    assert.equal(analytics.advancedJourney, true, "advancedJourney must be true via newlySatisfiedCriteriaIds even with no URL/title change");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("actionAnalytics omits dataLayerDelta/ga4RequestsObservedDuringActionWindow when those capture modules were not requested, but still reports advancedJourney", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      captureModules: ["cta_clicks"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/continue/i),
    });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    assert.ok(click.actionAnalytics);
    assert.equal(click.actionAnalytics?.advancedJourney, true);
    assert.equal(click.actionAnalytics?.dataLayerDelta, undefined);
    assert.equal(click.actionAnalytics?.ga4RequestsObservedDuringActionWindow, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("cta_clicks captures with no actionAnalytics-relevant module combination still record the click itself unchanged (backward compatible with pre-existing cta_clicks consumers)", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      captureModules: ["cta_clicks"],
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceThenStopSuccessProvider(/continue/i),
    });

    const click = response.captures.cta_clicks?.[0];
    assert.ok(click);
    assert.equal(click.ctaText, "Continue");
    assert.equal(click.navigationSucceeded, true);
    assert.equal(click.actionSucceeded, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
