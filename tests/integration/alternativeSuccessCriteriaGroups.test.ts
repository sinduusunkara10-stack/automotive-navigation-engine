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
 * REGRESSION: reproduces the reported "goal-recognition bug" (run_ce264464-...) end to
 * end through the real engine loop -- a configurator-style run that unambiguously
 * completed the journey (navigated to the destination page, and an analytics event
 * confirming completion genuinely fired) but every step's satisfiedCriteriaIds stayed
 * empty, so a rejected stop_success eventually terminated the run with
 * status "failure" / finishReason "no_progress_required_criteria_unmet" despite correct
 * navigation.
 *
 * Root cause (see docs/n8n-integration.md "Alternative (OR) success criteria groups" and
 * "Generic success criteria"): (1) data_layer_event/network_event were declared, schema-
 * valid successCriteria.type enum values that src/core/successEvaluator.ts's
 * evaluateSingle never actually evaluated (always `false`, regardless of config), so a
 * criterion built around "a specific analytics event was observed" -- exactly the caller's
 * "config_finished event is observed" condition -- could never be satisfied by any task,
 * ever; and (2) even once that's fixed, the caller's desired semantics ("the objective is
 * reached when A is true OR B is true OR C is true") had no way to be expressed at all --
 * every successCriteria entry with required !== false is AND-ed together
 * (getMissingRequiredCriteriaIds), so three independent alternative signals modelled as
 * three required criteria can only ever *all* have to fire, not *any one* of them.
 *
 * The three tests below use the existing local fixture chain (start.html --Continue-->
 * step2.html --Continue--> success.html, unmodified) exactly as tests/integration/
 * actionAttributedAnalytics.test.ts already does: success.html's own inline script pushes
 * `{ event: "journey_complete", ... }` to window.dataLayer and fires a GA4-style
 * `/g/collect?...&en=journey_complete...` beacon on load -- real, already-existing analytics
 * evidence, not something added for this test.
 */

class ClickTwiceThenStopSuccessProvider implements ReasoningProvider {
  private clickCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (this.clickCount < 2) {
      const candidate = context.observation.interactiveElements.find(
        (el) => el.visible !== false && /continue/i.test(el.accessibleName),
      );
      if (candidate) {
        this.clickCount += 1;
        return { action: { type: "click", target: candidate.id }, rationale: `Click "${candidate.accessibleName}".` };
      }
    }
    return { action: { type: "stop_success" }, rationale: "The journey looks complete; proposing stop_success." };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.7.0",
    taskId: "alternative-success-criteria-groups",
    objective:
      "Complete the fixture journey: reach the destination page, or click its completion control, or have its " +
      "completion analytics event fire -- any one of these confirms the objective.",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events", "errors"],
    limits: { maxSteps: 8, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.6.0",
    ...overrides,
  };
}

// Deliberately impossible under this fixture -- a wrong/never-matching alternative, exactly
// the shape of a misconfigured or structurally-unsatisfiable criterion the real run's other
// two criteria are suspected to have been (see the investigation this test accompanies).
const NEVER_MATCHES_SEMANTIC = {
  id: "wrong-control-clicked",
  type: "semantic_page_match" as const,
  description: "A control that does not exist on this fixture, in a vocabulary this page never uses, was activated.",
  config: { minScore: 1.1 }, // above the maximum possible deterministic score, and no semanticVerifier is supplied
};
// A plausible-looking but subtly wrong url_pattern -- missing the ".html" suffix, so it can
// never match "/success.html" under matchesUrlPattern's full-string-match semantics. Mirrors
// the trailing-wildcard/exact-suffix footgun identified while investigating the real run.
const NEVER_MATCHES_URL = {
  id: "malformed-destination-pattern",
  type: "url_pattern" as const,
  description: "The destination page was reached.",
  config: { pattern: "**/success" },
};
const JOURNEY_COMPLETE_DATA_LAYER_EVENT = {
  id: "journey-complete-event",
  type: "data_layer_event" as const,
  description: "The journey_complete analytics event fired.",
  config: { match: { event: "journey_complete" } },
};
const JOURNEY_COMPLETE_NETWORK_EVENT = {
  id: "journey-complete-network-event",
  type: "network_event" as const,
  description: "A GA4-style journey_complete request was observed.",
  config: { match: { en: "journey_complete" } },
};

test("REGRESSION: an OR-group of alternatives is satisfied by data_layer_event alone, even though every other member of the group is unsatisfiable -- objectiveAchieved is true and status is success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        { ...NEVER_MATCHES_SEMANTIC, group: "objective-reached" },
        { ...NEVER_MATCHES_URL, group: "objective-reached" },
        { ...JOURNEY_COMPLETE_DATA_LAYER_EVENT, group: "objective-reached" },
      ],
    });

    const response = await runTask({ page, task, reasoning: new ClickTwiceThenStopSuccessProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.deepEqual(response.engineAssessment.satisfiedSuccessCriteriaIds, ["journey-complete-event"]);
    assert.equal(response.diagnostics.missingRequiredCriteriaIds, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: an OR-group of alternatives is satisfied by network_event alone (GA4-style request evidence, no data_layer_evidence capture requested)", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      captureModules: ["cta_clicks", "ga4_network_events", "errors"],
      successCriteria: [
        { ...NEVER_MATCHES_SEMANTIC, group: "objective-reached" },
        { ...NEVER_MATCHES_URL, group: "objective-reached" },
        { ...JOURNEY_COMPLETE_NETWORK_EVENT, group: "objective-reached" },
      ],
    });

    const response = await runTask({ page, task, reasoning: new ClickTwiceThenStopSuccessProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.deepEqual(response.engineAssessment.satisfiedSuccessCriteriaIds, ["journey-complete-network-event"]);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION (documents the exact reported failure mode): the SAME three criteria WITHOUT `group` are AND-ed, not OR-ed -- two unsatisfiable required criteria block stop_success forever even though the working data_layer_event criterion is satisfied on every step from the destination page onward", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      limits: { maxSteps: 8, maxBacktracks: 0, maxRepeatedActions: 3 },
      successCriteria: [NEVER_MATCHES_SEMANTIC, NEVER_MATCHES_URL, JOURNEY_COMPLETE_DATA_LAYER_EVENT],
    });

    const response = await runTask({ page, task, reasoning: new ClickTwiceThenStopSuccessProvider() });

    assert.equal(response.status, "failure");
    assert.equal(response.statusReason, "no_progress_required_criteria_unmet");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    // The working criterion genuinely did fire and is recorded as satisfied -- this is not
    // a navigation failure or a data_layer_event regression, it is specifically the missing
    // OR semantics: satisfiedSuccessCriteriaIds is non-empty, but two required criteria the
    // task can structurally never satisfy still block stop_success under plain AND.
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("journey-complete-event"));
    assert.deepEqual(
      response.diagnostics.missingRequiredCriteriaIds?.sort(),
      ["malformed-destination-pattern", "wrong-control-clicked"],
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
