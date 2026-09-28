import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName } from "../helpers/scriptedReasoningProvider.js";

/**
 * Full-engine active-tab continuation (owner-mandated corrective pass, follow-up to PR #71):
 * the previously-missing production-shaped integration test proving the *whole* three-tier
 * surface-adoption path end to end through the real runTask()->loop.ts->popupCapture.ts->
 * click.ts chain -- not a unit test of any one function. A source configurator page opens a
 * popup on a genuinely different, legitimate hostname whose content is semantically equivalent
 * (not identical wording) to a later milestone; the engine must adopt it deterministically,
 * make the popup its active surface, rebuild observation/candidates from it, execute later
 * actions inside it (never the opener), verify a milestone from its live content, continue a
 * second milestone inside it, and preserve its analytics -- while the opener itself is never
 * touched again and no opener element is ever replayed against the popup's own document.
 *
 * Known, pre-existing limitation surfaced while building this test (not introduced or fixed
 * here -- see the corrective pass's final report): engine.ts's real-time dataLayer/GA4 push
 * observer (attachDataLayerPushCapture/attachGa4NetworkCapture) is wired once, at run start,
 * onto the originally-tracked Page only -- it is never re-attached once surface adoption makes
 * a popup the active Page. A click dispatched inside an adopted popup therefore always sees an
 * empty dataLayerPushesObservedDuringActionWindow/ga4 window, so any analytics fired by a click
 * handler immediately before a same-tab navigation *inside an adopted popup* can only ever
 * reach the coarser, less-confident dataLayerDelta path (correctly conservative:
 * ENGINE_CAPTURE_INCOMPLETE, never silently promoted to CONFIRMED) -- the exact race the
 * main-page path already solves via that observer. This does not lose the evidence (it is
 * still retained in captures.*, proven below), but it does mean it can never be confirmed as
 * click-correlated for an adopted surface today.
 *
 * Two static-server hostnames ("127.0.0.1" and "localhost") both resolve to the same local
 * server -- a genuinely different hostname string for allowedDomains/domain-policy purposes,
 * without needing real DNS or a second port.
 */

function crossHostBase(baseUrl: string): string {
  return baseUrl.replace("127.0.0.1", "localhost");
}

function baseTask(overrides: Partial<TaskRequest> & { startUrl: string; successPattern: string }): TaskRequest {
  const { startUrl, successPattern, ...rest } = overrides;
  return {
    schemaVersion: "1.28.0",
    taskId: "full-engine-popup-continuation-test",
    objective: "Review the configuration overview, complete the finance application, and reach the submission confirmation.",
    startUrl,
    allowedDomains: ["127.0.0.1", "localhost"],
    successCriteria: [
      {
        id: "reviewed_overview",
        type: "semantic_page_match",
        description: "Review the configuration overview summarizing the vehicle and estimated price.",
        required: false,
      },
      {
        id: "reached_milestone",
        type: "url_pattern",
        description: "The finance application submission confirmation is reached.",
        config: { pattern: successPattern },
      },
    ],
    captureModules: ["page_visits", "cta_clicks", "data_layer_evidence"],
    limits: { maxSteps: 12, maxBacktracks: 3 },
    safety: {
      allowedActions: ["click", "capture", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
      surfaceAdoptionDomainPolicy: "require_allowed_domain",
    },
    outputSchemaVersion: "1.30.0",
    ...rest,
  };
}

test("full-engine active-tab continuation: cross-host popup adopted deterministically, active Page switches, later actions and a second milestone execute inside it, analytics preserved, opener untouched", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const relevanceAmbiguityCalls: unknown[] = [];

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source.html`,
      successPattern: `${crossHostBase(baseUrl)}/full-engine-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Continue to Offer"),
      byAccessibleName("Proceed to Financing"),
      byAccessibleName("Submit Application"),
    ]);

    const response = await runTask({
      page,
      task,
      reasoning,
      relevanceAmbiguityResolver: { resolve: async (ctx) => (relevanceAmbiguityCalls.push(ctx), { relevant: true, rationale: "unused", confidence: 1 }) },
    });

    // 1-6: the CTA opened one new tab on a different legitimate hostname, deterministically
    // adopted (strong evidence -- no Claude call needed) after domain/safety policy passed.
    assert.equal(relevanceAmbiguityCalls.length, 0, "strong deterministic evidence must never need the Tier-3 Claude call");
    const openStep = response.steps.find((s) => s.selectedAction.type === "click" && s.actionResult.surfaceAdopted);
    assert.ok(openStep, "expected exactly one step whose click adopted a popup");
    assert.equal(openStep?.actionResult.relevanceTier, "adopt");
    assert.equal(openStep?.actionResult.adoptionRejectedReason, undefined);

    // 3: the opener's own URL/page is never navigated again after the popup opens.
    const openerSteps = response.steps.filter((s) => s.currentUrl === `${baseUrl}/full-engine-source.html`);
    assert.ok(openerSteps.length >= 1);
    assert.ok(
      !response.steps.some((s) => s.currentUrl.startsWith(baseUrl) && s.currentUrl !== `${baseUrl}/full-engine-source.html`),
      "the opener host must never be navigated to any other page after the popup opens",
    );

    // 7-8: adopted, active Page switched, fresh observation/candidates rebuilt from the popup.
    const adoptedSteps = response.steps.filter((s) => s.observation.activeSurface?.kind === "adopted_context");
    assert.ok(adoptedSteps.length >= 2, "expected multiple steps observed live inside the adopted popup");
    assert.ok(adoptedSteps.some((s) => s.currentUrl === `${crossHostBase(baseUrl)}/full-engine-overview.html`));
    assert.ok(adoptedSteps.some((s) => s.currentUrl === `${crossHostBase(baseUrl)}/full-engine-financing.html`));

    // 11: later actions executed inside the popup, not the opener -- every click dispatched
    // after adoption targeted a candidate that was actually present in that same step's own
    // live observation of the popup (never a stale opener element/handle).
    const stepsAfterAdoption = response.steps.slice(response.steps.indexOf(openStep!) + 1);
    for (const step of stepsAfterAdoption) {
      if (step.selectedAction.type !== "click") continue;
      assert.ok(
        step.observation.interactiveElements.some((el) => el.id === step.selectedAction.target),
        `click target ${step.selectedAction.target} must come from this step's own popup observation, never a replayed opener id/handle`,
      );
      assert.equal(step.observation.activeSurface?.kind, "adopted_context");
    }

    // 12-13: the overview milestone was verified from the popup's own live (paraphrased, not
    // identical) content, and a later quote-form milestone continued inside the same popup.
    const finalProgress = response.steps.at(-1)?.progress;
    assert.ok(
      finalProgress?.satisfiedCriteriaIds.includes("reviewed_overview"),
      `expected the semantic overview milestone to be satisfied from live popup content, got: ${JSON.stringify(finalProgress?.satisfiedCriteriaIds)}`,
    );

    // 2 & 17 (final state): run reaches the real success milestone, on the popup's own host.
    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${crossHostBase(baseUrl)}/full-engine-milestone.html`);

    // 14: popup analytics (dataLayer push on full-engine-financing.html) were preserved --
    // never silently dropped just because the evidence came from an adopted popup rather
    // than the main page. Note: this specific push is a page-load event (not a same-window
    // click-attributed one), so it is correctly retained as raw evidence and surfaced via
    // the action's own dataLayerDelta, without being promoted to a CONFIRMED/click-correlated
    // analyticsReportingRows entry -- see this test's own file-level limitations note.
    const dataLayerEvents = response.captures?.data_layer_evidence ?? [];
    const ctaClicks = response.captures?.cta_clicks ?? [];
    const preserved =
      dataLayerEvents.some((c) => c.raw.some((r) => r.event === "quote_form_started")) ||
      ctaClicks.some((c) => c.actionAnalytics?.dataLayerDelta?.newEntries.some((r) => r.event === "quote_form_started"));
    assert.ok(preserved, "expected the popup's own dataLayer.push evidence to be preserved somewhere in captures, never silently dropped");

    // 16: no repeated-popup/stale-target loop -- exactly one adoption for the whole run.
    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.equal(surfaceAdoption?.attempts.filter((a) => a.event === "adopted").length, 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("full-engine negative case: an unrelated popup on a different hostname is deterministically rejected and never triggers a Claude call", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const relevanceAmbiguityCalls: unknown[] = [];

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source-unrelated.html`,
      successPattern: `${crossHostBase(baseUrl)}/full-engine-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Continue to Offer")]);

    const response = await runTask({
      page,
      task,
      reasoning,
      relevanceAmbiguityResolver: { resolve: async (ctx) => (relevanceAmbiguityCalls.push(ctx), { relevant: true, rationale: "unused", confidence: 1 }) },
    });

    assert.equal(relevanceAmbiguityCalls.length, 0, "a clearly irrelevant candidate must reject deterministically, never reaching the Claude call");
    assert.notEqual(response.status, "success");

    const clickStep = response.steps.find((s) => s.selectedAction.type === "click");
    assert.equal(clickStep?.actionResult.surfaceAdopted, undefined);
    assert.equal(clickStep?.actionResult.adoptionRejectedReason, "relevance_rejected");

    // The engine never switched its active surface to the rejected popup.
    assert.ok(!response.steps.some((s) => s.observation.activeSurface?.kind === "adopted_context"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("full-engine recovery case: closing the adopted popup safely restores the opener as the active surface, which then reaches its own milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source-recovery.html`,
      successPattern: `${baseUrl}/full-engine-recovered-milestone.html`,
      limits: { maxSteps: 12, maxBacktracks: 3 },
    });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Continue to Offer"), byAccessibleName("Continue After Return")]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/full-engine-recovered-milestone.html`);

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "adopted"), "expected the popup to have been adopted before it closed itself");
    assert.ok(
      surfaceAdoption?.attempts.some((a) => a.event === "closed_unexpectedly"),
      `expected a "closed_unexpectedly" event once the adopted popup closed itself, got: ${JSON.stringify(surfaceAdoption?.attempts)}`,
    );

    const mainStepsAfterClose = response.steps.filter(
      (s) => s.observation.activeSurface?.kind === "main" && s.currentUrl === `${baseUrl}/full-engine-source-recovery.html`,
    );
    assert.ok(mainStepsAfterClose.length >= 1, "expected the run to resume observing the opener as 'main' after the popup closed");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
