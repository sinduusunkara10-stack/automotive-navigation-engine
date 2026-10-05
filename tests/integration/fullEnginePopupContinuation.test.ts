import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName } from "../helpers/scriptedReasoningProvider.js";
import { buildAnalyticsReportingRowsItems } from "../../n8n/buildAnalyticsReportingRows.js";
import { attachLowMemoryResourceRouting } from "../../src/api/browserResourceRouting.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

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
 * Listener-handoff fix (owner-mandated corrective pass, follow-up to PR #71): a previous
 * version of this test documented a known gap here -- engine.ts's real-time dataLayer/GA4
 * push observer was wired once, at run start, onto the originally-tracked Page only, and
 * never re-attached once surface adoption made a popup the active Page, so a click dispatched
 * inside an adopted popup could never be CONFIRMED via the real-time window (only the coarser
 * per-step snapshot diff). That gap is now closed via popupCapture.ts's
 * attachPopupContextCapture/retagPopupContextCaptureAsMain: GA4/dataLayer listeners are
 * attached to every popup candidate *before* relevance scoring even runs (so destination-load
 * evidence that fires during/at initial load is never lost), then simply retagged in place
 * from "popup_context" to "main" on adoption -- no detach/reattach, so no duplicate listeners
 * and no lost coverage. core/loop.ts's attachAdoptedSurfaceListeners
 * (src/capture-modules/adoptedSurfaceListeners.ts) remains only as a defensive fallback for a
 * surface adopted without pre-attached handles; both paths reuse the same
 * attachGa4NetworkCapture/attachDataLayerPushCapture/attachErrorCapture functions the main page
 * already used (never a second analytics mechanism), deduplicated per-Page via
 * RunState.hasAttachedListeners/markListenersAttached and detached at run end via
 * RunState.detachAllAdoptedSurfaceListeners. dataLayer.ts additionally wraps the *current*
 * document synchronously via page.evaluate() (not just addInitScript, which only covers
 * documents that haven't started running scripts yet at registration time), seeded from any
 * pre-existing window.dataLayer entries, so a same-origin popup whose destination document is
 * already executing by attach time (the nested-popup case below) doesn't lose pushes either.
 *
 * The first test below proves a click dispatched *inside* the adopted popup (Submit
 * Application, on full-engine-financing.html) reaches CONFIRMED/CAPTURED via the real-time
 * window, for both a dataLayer push and a GA4 beacon, with no duplicate evidence, and that the
 * popup's own page-load evidence and the n8n-facing analyticsReportingRows row both survive;
 * the nested-popup test proves the same pipeline applies recursively to a popup opened from an
 * already-adopted popup; the recovery-case test proves the opener's own original listener
 * keeps working, un-duplicated, after the popup closes.
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
    schemaVersion: "1.34.0",
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
    captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events"],
    limits: { maxSteps: 12, maxBacktracks: 3 },
    safety: {
      allowedActions: ["click", "capture", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
      surfaceAdoptionDomainPolicy: "require_allowed_domain",
    },
    outputSchemaVersion: "1.36.0",
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

    // 14 (listener-handoff fix): the popup's OWN click (Submit Application) fires a
    // dataLayer.push AND a GA4 beacon *inside the adopted popup*, immediately before a
    // same-window navigation -- the exact click-vs-navigation race the main page's own
    // real-time push observer already solves. Proves: listener attachment occurred on
    // adoption (captureHealth reports it active), both events are observed in real time
    // under the popup's own click action (never lost to the coarser per-step diff), both
    // reach CONFIRMED/CAPTURED classification, and neither is duplicated.
    const ctaClicks = response.captures?.cta_clicks ?? [];
    const submitClick = ctaClicks.find((c) => c.ctaText === "Submit Application");
    assert.ok(submitClick, "expected a recorded click for the popup's own 'Submit Application' button");
    const submitAnalytics = submitClick!.actionAnalytics;

    assert.equal(
      submitAnalytics?.captureHealth?.dataLayerPushListenerActive,
      true,
      "listener attachment on adoption: the push observer must be reported active for this click inside the adopted popup",
    );

    const pushesInWindow = submitAnalytics?.dataLayerPushesObservedDuringActionWindow ?? [];
    const submittedPushes = pushesInWindow.flatMap((entry) => entry.raw).filter((r) => r.event === "quote_form_submitted");
    assert.equal(
      submittedPushes.length,
      1,
      "a later click inside the popup must emit exactly one real-time-observed data-layer event, never zero (lost) and never duplicated",
    );
    assert.ok(
      pushesInWindow.every((entry) => entry.source === "main_frame" && entry.contextId === "main"),
      "adopted-popup evidence must be tagged the same way as the currently-active tracked surface",
    );

    const ga4InWindow = submitAnalytics?.ga4RequestsObservedDuringActionWindow ?? [];
    const submittedGa4 = ga4InWindow.filter((e) => e.params?.en === "quote_form_submitted");
    assert.equal(
      submittedGa4.length,
      1,
      "a later click inside the popup must emit exactly one real-time-observed GA4/network event, never zero and never duplicated",
    );

    assert.equal(submitAnalytics?.analyticsCapture?.status, "CAPTURED", "correlation must become CONFIRMED (CAPTURED) for the popup's own click");
    assert.equal(submitAnalytics?.analyticsCapture?.triggerSegment, "PHYSICAL_CLICK");
    assert.ok(
      submitAnalytics?.analyticsCapture?.confirmedDataLayerPushes.some((p) => p.raw.some((r) => r.event === "quote_form_submitted")),
      "expected the popup's own data-layer push to be a CONFIRMED event",
    );
    assert.ok(
      submitAnalytics?.analyticsCapture?.confirmedGa4Events.some((e) => e.params?.en === "quote_form_submitted"),
      "expected the popup's own GA4 beacon to be a CONFIRMED event",
    );

    // n8n confirmation: the engine-owned analyticsReportingRows contract (schema 1.30.0)
    // must surface this now-CONFIRMED popup-action row, and buildAnalyticsReportingRowsItems
    // (n8n/buildAnalyticsReportingRows.ts) must pass it through unfiltered.
    const submitRow = response.analyticsReportingRows?.find((r) => r.stepIndex === submitClick!.stepIndex && r.ctaText === "Submit Application");
    assert.ok(submitRow, "expected the popup click's own row in the engine-owned analyticsReportingRows contract");
    assert.equal(submitRow?.analyticsCaptureStatus, "CAPTURED");

    const n8nItems = buildAnalyticsReportingRowsItems([response as unknown as Parameters<typeof buildAnalyticsReportingRowsItems>[0][number]]);
    assert.ok(
      n8nItems.some((item) => item.json.stepIndex === submitClick!.stepIndex && item.json.ctaText === "Submit Application"),
      "expected the n8n reporting-row module to pass the popup's now-CONFIRMED row through unfiltered",
    );

    // Destination-load evidence: full-engine-overview.html's own page-load dataLayer push and
    // GA4 beacon fire before this popup is ever adopted/instrumented (relevance scoring already
    // read its title/headings by the time adoption completes), so they necessarily predate the
    // real-time observer attach -- still retained via the existing per-step full-snapshot path,
    // never silently dropped just because they arrived before instrumentation was possible.
    const landingPushRetained =
      (response.captures?.data_layer_evidence ?? []).some((c) => c.raw.some((r) => r.event === "promo_page_viewed")) ||
      ctaClicks.some((c) => c.actionAnalytics?.dataLayerDelta?.newEntries.some((r) => r.event === "promo_page_viewed"));
    assert.ok(landingPushRetained, "expected the popup's own page-load dataLayer push to be retained, never silently dropped");
    const ga4Events = response.captures?.ga4_network_events ?? [];
    assert.ok(
      ga4Events.some((e) => e.params?.en === "promo_page_viewed"),
      "expected the popup's own page-load GA4 beacon to be retained",
    );

    // 16: no repeated-popup/stale-target loop -- exactly one adoption for the whole run.
    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.equal(surfaceAdoption?.attempts.filter((a) => a.event === "adopted").length, 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("full-engine nested-popup case: a popup opened FROM an already-adopted popup is itself adopted and instrumented, with its own click reaching CONFIRMED", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const relevanceAmbiguityCalls: unknown[] = [];

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source.html`,
      successPattern: `${crossHostBase(baseUrl)}/full-engine-nested-milestone.html`,
      successCriteria: [
        {
          id: "reviewed_overview",
          type: "semantic_page_match",
          description: "Review the configuration overview summarizing the vehicle and estimated price.",
          required: false,
        },
        {
          id: "reviewed_nested_promo",
          type: "semantic_page_match",
          description: "Review the nested promotional trade-in bonus offer.",
          required: false,
        },
        {
          id: "reached_milestone",
          type: "url_pattern",
          description: "The nested offer confirmation is reached.",
          config: { pattern: `${crossHostBase(baseUrl)}/full-engine-nested-milestone.html` },
        },
      ],
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Continue to Offer"),
      byAccessibleName("Open Nested Promo"),
      byAccessibleName("Confirm Nested"),
    ]);

    const response = await runTask({
      page,
      task,
      reasoning,
      relevanceAmbiguityResolver: { resolve: async (ctx) => (relevanceAmbiguityCalls.push(ctx), { relevant: true, rationale: "unused", confidence: 1 }) },
    });

    assert.equal(relevanceAmbiguityCalls.length, 0, "both nested adoptions must be strong deterministic evidence, never reaching the Claude call");
    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${crossHostBase(baseUrl)}/full-engine-nested-milestone.html`);

    // Two independent adoptions: the first popup, and a second popup opened from inside it --
    // proves the listener handoff (and the whole adoption pipeline) applies recursively, not
    // just to a top-level popup.
    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.equal(surfaceAdoption?.attempts.filter((a) => a.event === "adopted").length, 2);

    const nestedClick = (response.captures?.cta_clicks ?? []).find((c) => c.ctaText === "Confirm Nested");
    assert.ok(nestedClick, "expected a recorded click for the nested popup's own 'Confirm Nested' button");
    const nestedAnalytics = nestedClick!.actionAnalytics;
    assert.equal(
      nestedAnalytics?.captureHealth?.dataLayerPushListenerActive,
      true,
      "the nested popup must have its own listeners attached too, not just the first-level popup",
    );
    assert.equal(nestedAnalytics?.analyticsCapture?.status, "CAPTURED");
    assert.ok(nestedAnalytics?.analyticsCapture?.confirmedGa4Events.some((e) => e.params?.en === "nested_offer_confirmed"));
    assert.ok(nestedAnalytics?.analyticsCapture?.confirmedDataLayerPushes.some((p) => p.raw.some((r) => r.event === "nested_offer_confirmed")));

    // The nested popup's own action row must also survive into the engine-owned
    // analyticsReportingRows contract and the n8n replacement module, combined chronologically
    // with the first-level popup's row -- not just the top-level popup case.
    const nestedRow = response.analyticsReportingRows?.find(
      (r) => r.stepIndex === nestedClick!.stepIndex && r.ctaText === "Confirm Nested",
    );
    assert.ok(nestedRow, "expected the nested popup click's own row in analyticsReportingRows");
    assert.equal(nestedRow?.analyticsCaptureStatus, "CAPTURED");

    const n8nItems = buildAnalyticsReportingRowsItems([response as unknown as Parameters<typeof buildAnalyticsReportingRowsItems>[0][number]]);
    const nestedItem = n8nItems.find((item) => item.json.stepIndex === nestedClick!.stepIndex && item.json.ctaText === "Confirm Nested");
    assert.ok(nestedItem, "expected the n8n reporting-row module to pass the nested popup's row through unfiltered");
    const journeySequences = n8nItems.map((item) => item.json.journeySequence as number);
    assert.deepEqual(
      journeySequences,
      [...journeySequences].sort((a, b) => a - b),
      "expected n8n rows in deterministic chronological (journeySequence) order across both popups",
    );
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

    // Listener-handoff fix, opener side: "Continue After Return" is clicked on the OPENER
    // itself, after the adopted popup already closed and the run resumed there -- proves the
    // opener's own original (run-start-attached) listener is still live and un-duplicated
    // after an adopt-then-close cycle (the adopted-surface listener handoff never touches the
    // opener's own listeners at all, by construction).
    const returnClick = (response.captures?.cta_clicks ?? []).find((c) => c.ctaText === "Continue After Return");
    assert.ok(returnClick, "expected a recorded click for the opener's own 'Continue After Return' button");
    const returnPushes = (returnClick!.actionAnalytics?.dataLayerPushesObservedDuringActionWindow ?? [])
      .flatMap((entry) => entry.raw)
      .filter((r) => r.event === "recovery_continue");
    assert.equal(
      returnPushes.length,
      1,
      "the opener must keep capturing correctly after the popup closes, with exactly one entry for its own post-return click -- never zero and never duplicated",
    );
    assert.equal(returnClick!.actionAnalytics?.captureHealth?.dataLayerPushListenerActive, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("full-engine low-memory resource routing: original page, an adopted popup, and a popup opened from that popup are all protected, with heavy resources blocked and functional/analytics evidence preserved throughout", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const routing = attachLowMemoryResourceRouting(page);

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source.html`,
      successPattern: `${crossHostBase(baseUrl)}/full-engine-nested-milestone.html`,
      captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events", "errors"],
      successCriteria: [
        {
          id: "reviewed_overview",
          type: "semantic_page_match",
          description: "Review the configuration overview summarizing the vehicle and estimated price.",
          required: false,
        },
        {
          id: "reviewed_nested_promo",
          type: "semantic_page_match",
          description: "Review the nested promotional trade-in bonus offer.",
          required: false,
        },
        {
          id: "reached_milestone",
          type: "url_pattern",
          description: "The nested offer confirmation is reached.",
          config: { pattern: `${crossHostBase(baseUrl)}/full-engine-nested-milestone.html` },
        },
      ],
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Continue to Offer"),
      byAccessibleName("Open Nested Promo"),
      byAccessibleName("Confirm Nested"),
    ]);

    const response = await runTask({
      page,
      task,
      reasoning,
      describeRoutedPage: routing.describePage,
      relevanceAmbiguityResolver: { resolve: async () => ({ relevant: true, rationale: "unused", confidence: 1 }) },
    });
    const resourceRouting = routing.diagnostics();
    await routing.detach();

    // 1-4: the whole three-page chain (original, adopted popup, nested popup) reaches the
    // milestone successfully, with routing active on all of them throughout.
    assert.equal(response.status, "success");
    assert.equal(resourceRouting.mode, "low_memory");
    assert.equal(resourceRouting.byPage.length, 3, "expected exactly one routing entry each for the original page, the adopted popup, and the nested popup");

    const original = resourceRouting.byPage.find((p) => p.role === "original");
    const adopted = resourceRouting.byPage.find((p) => p.role === "adopted_popup");
    const nested = resourceRouting.byPage.find((p) => p.role === "nested_popup");
    assert.ok(original && adopted && nested, "expected one page of each role: original, adopted_popup, nested_popup");
    assert.equal(adopted?.contextId, "main");
    assert.equal(nested?.contextId, "main");
    assert.ok(adopted?.surfaceId && nested?.surfaceId && adopted.surfaceId !== nested.surfaceId);

    // 5-7: heavy image/font resources are blocked on every one of the three pages -- the
    // original page's own hero photo/font, the adopted popup's own configuration photo/font,
    // and the nested popup's own trade-in-bonus photo/font (see the <img>/<link preload>
    // tags added to full-engine-source.html/full-engine-overview.html/full-engine-nested-
    // promo.html specifically for this test).
    for (const [label, entry] of [
      ["original", original],
      ["adopted popup", adopted],
      ["nested popup", nested],
    ] as const) {
      const image = entry?.byResourceType.find((e) => e.resourceType === "image");
      assert.ok((image?.blockedCount ?? 0) >= 1, `expected the ${label} page's own heavy image to be blocked`);
      const font = entry?.byResourceType.find((e) => e.resourceType === "font");
      assert.ok((font?.blockedCount ?? 0) >= 1, `expected the ${label} page's own preloaded font to be blocked`);
    }

    // 8: functional/document resources remain allowed -- the run could not have navigated
    // through all three pages otherwise. Checked at the run level rather than strictly per
    // page: a brand-new popup's own very first navigation request can hit a narrow Playwright
    // timing case where the initiating frame isn't attributable yet (see routeHandler's own
    // comment on unattributedTallies) -- blocking is unaffected either way ("document" is
    // never blocked), only which bucket the count lands in.
    const runDocumentAllowed = resourceRouting.byResourceType.find((e) => e.resourceType === "document")?.allowedCount ?? 0;
    assert.ok(runDocumentAllowed >= 3, "expected at least one allowed document request per page (original + adopted popup + nested popup)");

    // 9-10: GA4 and data-layer evidence from both the adopted popup's own landing (promo_page_
    // viewed) and the nested popup's own click (nested_offer_confirmed) are still fully
    // captured, even though their own GA4 beacons are themselves image-type requests and so
    // are blocked at the network layer by the same policy -- capture (page.on("request"))
    // fires regardless of how routing later resolves the request, exactly as it already does
    // for the original page (see lowMemoryBrowserMode.test.ts).
    const ga4Events = response.captures?.ga4_network_events ?? [];
    assert.ok(ga4Events.some((e) => e.params?.en === "promo_page_viewed"), "expected the adopted popup's own landing GA4 beacon to still be captured");
    assert.ok(ga4Events.some((e) => e.params?.en === "nested_offer_confirmed"), "expected the nested popup's own click GA4 beacon to still be captured");
    const dataLayerEvents = (response.captures?.data_layer_evidence ?? []).flatMap((c) => c.raw);
    assert.ok(dataLayerEvents.some((r) => r.event === "nested_offer_confirmed"), "expected the nested popup's own dataLayer push to still be captured");

    // 11: no duplicate registration/route-handler noise -- exactly one entry per page, each
    // registered exactly once.
    for (const entry of [original, adopted, nested]) {
      assert.equal(entry?.duplicateRegistrationPrevented, false);
      assert.equal(entry?.registrationCompleted, true);
    }

    // 12: blocking is fulfilled, never aborted -- no network_request_failed noise attributable
    // to the intentionally-blocked heavy resources specifically (a click handler that fires a
    // beacon and then immediately navigates the very same page, as full-engine-nested-promo.
    // html's own "Confirm Nested" handler does, can independently race a net::ERR_ABORTED from
    // Chromium's own navigation teardown -- a pre-existing property of that pattern, unrelated
    // to whether low-memory routing blocked anything).
    const blockedResourceErrors = (response.captures?.errors ?? []).filter(
      (e) => e.category === "network_request_failed" && (e.message.includes("heavy-photo.jpg") || e.message.includes("heavy-font.woff2")),
    );
    assert.equal(blockedResourceErrors.length, 0);

    // 13: run-level totals equal the sum of the three pages' own totals.
    const runImageBlocked = resourceRouting.byResourceType.find((e) => e.resourceType === "image")?.blockedCount ?? 0;
    const perPageImageBlocked = [original, adopted, nested].reduce(
      (sum, e) => sum + (e?.byResourceType.find((t) => t.resourceType === "image")?.blockedCount ?? 0),
      0,
    );
    assert.equal(runImageBlocked, perPageImageBlocked);

    // 14: neither popup was ever closed during this journey (the milestone is reached via an
    // ordinary same-page navigation inside the nested popup, not a window.close()) -- their
    // routing state is released instead by detach() above, exactly as it is for the original
    // page (see the "detach() ... preserves still-open pages' diagnostics" unit test);
    // popup-close release is covered separately (the "rejected popup" test below, and the
    // existing recovery-case test's own listener-handoff closure assertions).
    assert.equal(adopted?.registrationCompleted, true);
    assert.equal(nested?.registrationCompleted, true);

    // 15: the response actually returned to a caller -- with diagnostics.resourceRouting
    // populated exactly as src/api/runner.ts populates it -- validates against the real
    // task-response.schema.json, byPage included.
    const validation = await validateAgainstTaskResponseSchema({ ...response, diagnostics: { ...response.diagnostics, resourceRouting } });
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("full-engine low-memory resource routing: an unrelated rejected popup is still protected while observed, and releases its routing state when closed", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const routing = attachLowMemoryResourceRouting(page);

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/full-engine-source-unrelated.html`,
      successPattern: `${crossHostBase(baseUrl)}/full-engine-milestone.html`,
      captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events", "errors"],
    });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Continue to Offer")]);
    const relevanceAmbiguityCalls: unknown[] = [];

    await runTask({
      page,
      task,
      reasoning,
      relevanceAmbiguityResolver: { resolve: async (ctx) => (relevanceAmbiguityCalls.push(ctx), { relevant: true, rationale: "unused", confidence: 1 }) },
      describeRoutedPage: routing.describePage,
    });
    const resourceRouting = routing.diagnostics();
    await routing.detach();

    assert.equal(relevanceAmbiguityCalls.length, 0, "expected the unrelated popup to be deterministically rejected, never reaching the Claude call");
    const rejectedPopup = resourceRouting.byPage.find((p) => p.role === "popup");
    assert.ok(rejectedPopup, "expected the rejected popup to still have its own routing diagnostics entry, never discarded");
    assert.equal(rejectedPopup?.registrationCompleted, true);
    assert.equal(rejectedPopup?.routingReleasedOnClose, true, "expected its routing state to be released once it was closed unadopted");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
