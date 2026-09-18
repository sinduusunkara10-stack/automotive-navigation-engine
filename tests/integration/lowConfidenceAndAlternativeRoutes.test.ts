import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * PR 1C (low-confidence recovery, alternative route exploration, exhausted-candidate
 * protection -- see CLAUDE.md and docs/architecture.md §20). Generic reproductions of the
 * diagnosed Nissan-investigation failure path (View Offer Details -> low_confidence ->
 * go_back -> go_back -> stop_blocked) and the requested "CTA fails -> go_back -> try sibling
 * CTA -> continue" shape. Nothing here is specific to any website, brand, market, or CTA
 * label -- every route is synthetic, served from 127.0.0.1 on an ephemeral port (mirrors
 * tests/integration/journeyReplanning.test.ts's own convention).
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/start.html") {
      return void page("Start", '<a href="/listing.html">Enter Listing</a>');
    }

    if (path === "/listing.html") {
      // Two sibling CTAs, offering different paths toward a related objective -- exactly
      // the "Request a Quote" / "Finance Calculator"-shaped choice the task requirements
      // describe, kept fully generic. "Request a Quote" is a real, distinct navigation (so
      // a later go_back lands back on *this* page with both siblings visible again, unlike
      // a same-document drawer/panel -- see docs/architecture.md §20's own documented
      // limitation on why this mechanism is deliberately not fingerprint-gated).
      return void page(
        "Listing",
        '<a href="/quote-dead-end.html">Request a Quote</a> ' + '<a href="/finance-success.html">Finance Calculator</a>',
      );
    }

    if (path === "/quote-dead-end.html") {
      return void page("Dead End", "<p>Nothing reachable from here.</p>");
    }

    if (path === "/finance-success.html") {
      return void page("Finance Calculator", '<h1 id="finance-success">Calculator complete</h1>');
    }

    if (path === "/drawer-start.html") {
      // The success criterion below checks for #goal-control-clicked, not the mere
      // presence of #goal-control itself -- the drawer opening (and its own controls
      // existing in the DOM) must never by itself satisfy the objective; only actually
      // clicking the goal control may.
      return void page(
        "Offer listing",
        '<button type="button" id="trigger">View Offer Details</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'drawer';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;';" +
          "  d.innerHTML = '<h2>Offer details</h2>' +" +
          "    '<button type=\"button\" id=\"goal-control\">Goal Control</button>' +" +
          "    '<button type=\"button\" id=\"close-drawer\">Close</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('close-drawer').addEventListener('click', function () { d.remove(); });" +
          "  document.getElementById('goal-control').addEventListener('click', function () {" +
          "    var marker = document.createElement('div');" +
          "    marker.id = 'goal-control-clicked';" +
          "    document.body.appendChild(marker);" +
          "  });" +
          "});" +
          "</script>",
      );
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine fixture server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function isSatisfied(context: ReasoningContext): boolean {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  return requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.20.0",
    taskId: "low-confidence-and-alternative-routes",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors"],
    limits: { maxSteps: 12, maxBacktracks: 4, maxRepeatedActions: 8 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.19.0",
    ...overrides,
  };
}

/**
 * Simulates a real ClaudeReasoningProvider falling back to stop_blocked purely on
 * confidence (Decision.fallbackReason === "low_confidence") the *first* time it sees the
 * drawer's own goal control, then a normal, confident decision on whatever the engine asks
 * next -- letting core/loop.ts's low-confidence recovery (docs/architecture.md §20) do its
 * job: a settle wait, a fresh observation, and one more decide() call, entirely within the
 * same step.
 */
class LowConfidenceThenRecoversProvider implements ReasoningProvider {
  decisionCallCount = 0;
  private returnedLowConfidenceOnce = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.decisionCallCount += 1;
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    const goalControl = context.observation.interactiveElements.find((el) => el.accessibleName === "Goal Control");
    if (goalControl) {
      if (!this.returnedLowConfidenceOnce) {
        this.returnedLowConfidenceOnce = true;
        return { action: { type: "stop_blocked" }, rationale: "Confidence too low.", fallbackReason: "low_confidence" };
      }
      return { action: { type: "click", target: goalControl.id }, rationale: "Click the drawer's own goal control." };
    }
    const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "View Offer Details");
    if (trigger) {
      return { action: { type: "click", target: trigger.id }, rationale: "Open the drawer." };
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

/** Never recovers -- always reports low confidence for the drawer's goal control, proving the recovery is bounded to exactly one retry per decision-point fingerprint rather than looping. */
class NeverRecoversLowConfidenceProvider implements ReasoningProvider {
  decisionCallCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.decisionCallCount += 1;
    const goalControl = context.observation.interactiveElements.find((el) => el.accessibleName === "Goal Control");
    if (goalControl) {
      return { action: { type: "stop_blocked" }, rationale: "Confidence too low.", fallbackReason: "low_confidence" };
    }
    const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "View Offer Details");
    if (trigger) {
      return { action: { type: "click", target: trigger.id }, rationale: "Open the drawer." };
    }
    return { action: { type: "stop_blocked" }, rationale: "Nothing else to try." };
  }
}

function drawerTask(startUrl: string): TaskRequest {
  return baseTask({
    objective: "Reach the drawer's own goal control.",
    startUrl,
    successCriteria: [
      {
        id: "goal_control_present",
        type: "element_present",
        description: "The drawer's own goal control is present.",
        config: { selector: "#goal-control-clicked" },
      },
    ],
  });
}

test("low-confidence recovery: a drawer-triggered low_confidence fallback gets one fresh-observation retry within the same step, reaching success without ever going through journey replanning", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new LowConfidenceThenRecoversProvider();
    const response = await runTask({ page, task: drawerTask(`${baseUrl}/drawer-start.html`), reasoning: provider });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    assert.equal(response.status, "success");
    // The low-confidence attempt and its recovery retry both happen within the SAME step
    // (dispatching the goal-control click directly, never a separate stop_blocked/go_back
    // step) -- so this reaches success in exactly three dispatched steps (open drawer,
    // click the goal control, stop_success), never touching go_back at all.
    assert.equal(response.steps.length, 3);
    assert.ok(response.steps.every((s) => s.selectedAction.type !== "go_back"), "must never have needed journey replanning");
    assert.equal(
      provider.decisionCallCount,
      4,
      "open-drawer decide + low-confidence decide + recovery decide (dispatches the click) + stop_success decide",
    );

    assert.equal(response.steps[0]?.actionResult.surfaceChangeDetected, true);
    assert.equal(response.steps[0]?.actionResult.surfaceChangeType, "layer_panel_appeared");

    const recoveryDiagnostic = response.captures.errors?.find((e) => /re-observed and asked the reasoning layer again/.test(e.message));
    assert.ok(recoveryDiagnostic, "expected a diagnostic recording the low-confidence recovery attempt");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("low-confidence recovery is bounded to one retry per decision point: a provider that never recovers falls through to ordinary journey replanning rather than looping", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new NeverRecoversLowConfidenceProvider();
    const response = await runTask({
      page,
      task: baseTask({
        objective: "Reach the drawer's own goal control.",
        startUrl: `${baseUrl}/drawer-start.html`,
        successCriteria: [
          { id: "unreachable", type: "element_present", description: "never satisfied", config: { selector: "#never" } },
        ],
        safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
        limits: { maxSteps: 6, maxBacktracks: 2, maxRepeatedActions: 8 },
      }),
      reasoning: provider,
    });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    // Step 0: open the drawer. Step 1: low_confidence -> exactly one bounded recovery retry
    // (both calls happen within this one step) -> still stop_blocked -> falls through to
    // journey replanning's own go_back substitution (distinctVisitedUrls is only 1 here --
    // a same-document drawer never navigates -- so journey replanning is NOT eligible, and
    // the run stops blocked immediately). This proves the recovery cost is exactly one
    // extra decide() call, never repeated for the same fingerprint.
    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 2);
    assert.equal(provider.decisionCallCount, 3, "open-drawer decide + initial low-confidence decide + one bounded retry, never more");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

function siblingRouteTask(startUrl: string, provider: "success" | "stubborn"): TaskRequest {
  return baseTask({
    objective: "Reach the finance calculator's completion state.",
    startUrl,
    successCriteria: [
      {
        id: "finance_complete",
        type: "element_present",
        description: "The finance calculator's own completion element is present.",
        config: { selector: "#finance-success" },
      },
    ],
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    limits: { maxSteps: 10, maxBacktracks: 3, maxRepeatedActions: 8 },
  });
}

/**
 * Tries "Request a Quote" first (a plausible, but here deliberately dead-ended, primary
 * CTA), proposes stop_blocked once it reaches the dead end, and -- once journey replanning
 * has substituted go_back and returned it to the listing page -- reads the resulting
 * ReasoningContext.alternativeExploration nudge and switches to the sibling "Finance
 * Calculator" CTA instead, reaching the objective. Directly exercises both the nudge
 * (justFailedLabels) and the natural, un-forced alternative-route path.
 */
class TriesSiblingAfterDeadEndProvider implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    if (context.observation.url.includes("quote-dead-end")) {
      return { action: { type: "stop_blocked" }, rationale: "Nothing reachable from this dead end." };
    }
    const quoteWasFlagged = (context.alternativeExploration?.justFailedLabels ?? []).some((l) => l.includes("Request a Quote"));
    const financeCta = context.observation.interactiveElements.find((el) => el.accessibleName === "Finance Calculator");
    if (quoteWasFlagged && financeCta) {
      return { action: { type: "click", target: financeCta.id }, rationale: "Try the sibling CTA instead." };
    }
    const quoteCta = context.observation.interactiveElements.find((el) => el.accessibleName === "Request a Quote");
    if (!quoteWasFlagged && quoteCta) {
      return { action: { type: "click", target: quoteCta.id }, rationale: "Try Request a Quote first." };
    }
    const enter = context.observation.interactiveElements.find((el) => el.accessibleName === "Enter Listing");
    if (enter) {
      return { action: { type: "click", target: enter.id }, rationale: "Enter the listing." };
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

/** Never learns -- always re-proposes "Request a Quote" regardless of the alternativeExploration nudge, proving the exhausted-candidate guard's bounded termination (never an infinite loop). */
class StubbornlyRepeatsFailedCandidateProvider implements ReasoningProvider {
  decisionCallCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.decisionCallCount += 1;
    if (context.observation.url.includes("quote-dead-end")) {
      return { action: { type: "stop_blocked" }, rationale: "Nothing reachable from this dead end." };
    }
    const quoteCta = context.observation.interactiveElements.find((el) => el.accessibleName === "Request a Quote");
    if (quoteCta) {
      return { action: { type: "click", target: quoteCta.id }, rationale: "Always try Request a Quote." };
    }
    const enter = context.observation.interactiveElements.find((el) => el.accessibleName === "Enter Listing");
    if (enter) {
      return { action: { type: "click", target: enter.id }, rationale: "Enter the listing." };
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("alternative route exploration: a dead-ended primary CTA leads, via journey replanning's nudge, to a sibling CTA that reaches the objective", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const response = await runTask({
      page,
      task: siblingRouteTask(`${baseUrl}/start.html`, "success"),
      reasoning: new TriesSiblingAfterDeadEndProvider(),
    });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    assert.equal(response.status, "success");
    const goBackSteps = response.steps.filter((s) => s.selectedAction.type === "go_back");
    assert.equal(goBackSteps.length, 1, "expected exactly one journey-replanning go_back before the sibling CTA was tried");
    const financeClick = response.steps.find(
      (s) => s.selectedAction.type === "click" && s.observation.url.includes("listing") && s.decision.includes("sibling"),
    );
    assert.ok(financeClick, "expected a step whose decision explicitly credits the sibling-CTA nudge");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("exhausted-candidate protection: a provider that keeps re-proposing the same failed candidate is bounded to the existing journey-replanning ceiling, never loops indefinitely", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new StubbornlyRepeatsFailedCandidateProvider();
    const response = await runTask({
      page,
      task: siblingRouteTask(`${baseUrl}/start.html`, "stubborn"),
      reasoning: provider,
    });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    // Bounded termination is the property under test: the run must end (this test would
    // simply hang/timeout if it did not), and it must end exactly when
    // MAX_JOURNEY_REPLANNING_ATTEMPTS (2) is exhausted, having gone through the
    // exhausted-candidate guard's one-retry-then-hard-block cycle each time.
    assert.equal(response.status, "blocked");
    const goBackSteps = response.steps.filter((s) => s.selectedAction.type === "go_back");
    assert.equal(goBackSteps.length, 2, "expected exactly MAX_JOURNEY_REPLANNING_ATTEMPTS (2) go_back substitutions, never more");
    // Bounded termination is the actual safety property under test -- this run must stop
    // within a small, fixed number of steps, never hang or loop indefinitely, regardless of
    // how stubbornly the reasoning layer keeps re-proposing the same failed candidate.
    assert.ok(response.steps.length <= 8, `expected bounded termination, got ${response.steps.length} steps`);

    const guardDiagnostics = response.captures.errors?.filter((e) => /repeated_exhausted_candidate|already failed to advance/.test(e.message));
    assert.ok((guardDiagnostics?.length ?? 0) >= 1, "expected the exhausted-candidate guard to have fired at least once");

    // "Request a Quote" is dispatched at most twice in this fixture -- once directly, and
    // (per docs/architecture.md §20's own documented limitation) potentially once more if a
    // *second* go_back substitution overshoots past the listing page back to an earlier
    // page with no "Request a Quote" control at all, consuming the one-shot guard on an
    // unrelated decision before the reasoning layer returns to the listing page and
    // re-proposes it with no guard left to catch it. What must never happen is a third,
    // fourth, or unbounded repeat -- which the overall step-count bound above already rules
    // out.
    const quoteClicks = response.steps.filter(
      (s) =>
        s.selectedAction.type === "click" &&
        s.observation.interactiveElements.some((el) => el.id === s.selectedAction.target && el.accessibleName === "Request a Quote"),
    );
    assert.ok(quoteClicks.length <= 2, `expected at most two real dispatches of the exhausted candidate, got ${quoteClicks.length}`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
