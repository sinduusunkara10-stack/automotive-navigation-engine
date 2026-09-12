import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Bounded journey replanning (Option A, Phase 1): before a `stop_blocked` action -- proposed
 * directly by the reasoning layer, or substituted by the safety layer for a rejected decision
 * -- actually ends a run, src/core/loop.ts now gives the run a small, fixed number of chances
 * (MAX_JOURNEY_REPLANNING_ATTEMPTS, currently 2) to substitute the existing `go_back` action
 * instead and let the reasoning layer try an alternate route, before finally honouring
 * stop_blocked. See docs/architecture.md "Bounded journey replanning". Every fixture below is
 * synthetic, served from 127.0.0.1, with generic English labels -- no brand/vendor wording.
 */

const OBJECTIVE_BUTTON =
  '<button id="objective">Objective control</button>' +
  "<script>document.getElementById('objective').addEventListener('click', function () {" +
  "var reached = document.createElement('div'); reached.id = 'objective-reached'; document.body.appendChild(reached);});</script>";

const REACHED_OBJECTIVE_CRITERION = {
  id: "objective-clicked",
  type: "element_present" as const,
  description: "The objective control's own click handler confirms it was activated.",
  config: { selector: "#objective-reached" },
  required: true,
};

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "journey-replanning",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 10, maxBacktracks: 5, maxRepeatedActions: 8 },
    safety: { allowedActions: ["click", "go_back", "navigate", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
    ...overrides,
  };
}

function isSatisfied(context: ReasoningContext): boolean {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  return requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
}

/**
 * Explores a dead-end link first (deliberately, to reach a page with nothing reachable and
 * propose stop_blocked itself), then -- once the engine has substituted go_back and returned
 * it to the previous page -- clicks the objective control instead. A well-behaved model would
 * probably never explore the dead end at all, but this deterministically exercises the engine
 * substituting go_back for a *reasoning-layer-proposed* stop_blocked, as distinct from one the
 * safety layer substitutes for a rejected decision (covered by a separate provider below).
 */
class ExploresDeadEndThenObjectiveProvider implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  private callCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return this.record({ action: { type: "stop_success" }, rationale: "Required criteria satisfied." });
    }
    this.callCount += 1;
    const elements = context.observation.interactiveElements;

    if (this.callCount === 1) {
      const deadEnd = elements.find((el) => /enter dead end/i.test(el.accessibleName));
      if (deadEnd && context.allowedActions.includes("click")) {
        return this.record({ action: { type: "click", target: deadEnd.id }, rationale: "Exploring the dead-end link first." });
      }
    }

    const objective = elements.find((el) => /objective control/i.test(el.accessibleName));
    if (objective && context.allowedActions.includes("click")) {
      return this.record({ action: { type: "click", target: objective.id }, rationale: "Objective control is reachable here." });
    }

    if (context.allowedActions.includes("stop_blocked")) {
      return this.record({ action: { type: "stop_blocked" }, rationale: "Nothing reachable on this page." });
    }
    return this.record({ action: { type: "stop_failure" }, rationale: "No permitted action available." });
  }

  private record(decision: Decision): Decision {
    this.decisions.push(decision);
    return decision;
  }
}

/**
 * Deliberately never finds anything reachable, repeatedly: from the start page it always
 * navigates to a *freshly, uniquely* query-suffixed dead-end URL (never the same URL twice --
 * see startJourneyReplanningFixtureServer's own comment on why an exact-URL A-B-A-B pattern
 * would trip the unrelated, pre-existing generic loop detector instead of the bound under
 * test here), and once there always proposes stop_blocked. Used only to deterministically
 * exhaust the bounded replanning allowance itself, the same role
 * tests/integration/blockerRecovery.test.ts's AlwaysSameTargetProvider plays for the
 * stale-target recovery bound.
 */
class StubbornDeadEndProvider implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  private attempt = 0;

  constructor(private readonly deadEndBaseUrl: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return this.record({ action: { type: "stop_success" }, rationale: "Required criteria satisfied." });
    }
    const onDeadEnd = context.observation.url.startsWith(this.deadEndBaseUrl);
    if (!onDeadEnd && context.allowedActions.includes("navigate")) {
      this.attempt += 1;
      return this.record({
        action: { type: "navigate", target: `${this.deadEndBaseUrl}?attempt=${this.attempt}` },
        rationale: "Deliberately exploring another dead end.",
      });
    }
    if (context.allowedActions.includes("stop_blocked")) {
      return this.record({ action: { type: "stop_blocked" }, rationale: "Nothing reachable on this page." });
    }
    return this.record({ action: { type: "stop_failure" }, rationale: "No permitted action available." });
  }

  private record(decision: Decision): Decision {
    this.decisions.push(decision);
    return decision;
  }
}

/**
 * Always proposes stop_blocked immediately, on the very first call -- used to exercise the
 * "no previous page to go back to" case (the run's first ever step).
 */
class ImmediateStopBlockedProvider implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  async decide(): Promise<Decision> {
    const decision: Decision = { action: { type: "stop_blocked" }, rationale: "Blocked immediately." };
    this.decisions.push(decision);
    return decision;
  }
}

/**
 * Clicks a "Continue" link onto a second page, then proposes a `navigate` to a domain outside
 * allowedDomains -- rejected by the safety layer (domain_blocked), which substitutes
 * stop_blocked itself. Once the engine substitutes go_back for that in turn and the run is
 * back on the first page, clicks the objective control. Exercises replanning for a
 * *safety-substituted* stop_blocked, as distinct from one the reasoning layer proposes
 * directly (ExploresDeadEndThenObjectiveProvider above).
 */
class DomainBlockedReplanningProvider implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  private callCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return this.record({ action: { type: "stop_success" }, rationale: "Required criteria satisfied." });
    }
    this.callCount += 1;
    const elements = context.observation.interactiveElements;

    if (this.callCount === 1) {
      const cont = elements.find((el) => /continue/i.test(el.accessibleName));
      if (cont && context.allowedActions.includes("click")) {
        return this.record({ action: { type: "click", target: cont.id }, rationale: "Continuing to the next page." });
      }
    }
    if (this.callCount === 2 && context.allowedActions.includes("navigate")) {
      return this.record({
        action: { type: "navigate", target: "https://example-disallowed-site.test/" },
        rationale: "Attempting a navigation outside allowedDomains.",
      });
    }

    const objective = elements.find((el) => /objective control/i.test(el.accessibleName));
    if (objective && context.allowedActions.includes("click")) {
      return this.record({ action: { type: "click", target: objective.id }, rationale: "Objective control is reachable here." });
    }
    if (context.allowedActions.includes("stop_blocked")) {
      return this.record({ action: { type: "stop_blocked" }, rationale: "Nothing reachable on this page." });
    }
    return this.record({ action: { type: "stop_failure" }, rationale: "No permitted action available." });
  }

  private record(decision: Decision): Decision {
    this.decisions.push(decision);
    return decision;
  }
}

async function startJourneyReplanningFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  // "Cache-Control: no-store" ensures a real back navigation always re-requests the server
  // rather than being served from bfcache/heuristic caching, so every fixture below behaves
  // the same way regardless of browser caching behaviour.
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);

    if (path === "/start.html") {
      return void page(OBJECTIVE_BUTTON + '<a id="dead-end-link" href="/dead-end.html">Enter dead end</a>');
    }
    if (path === "/dead-end.html") {
      // Query strings (?attempt=N, used by StubbornDeadEndProvider to keep each dead-end
      // visit's URL unique -- see that class's own comment) are stripped from `path` above,
      // so every /dead-end.html?... request is served the same content regardless.
      return void page("<p>Nothing to do here.</p>");
    }
    if (path === "/continue-start.html") {
      return void page(OBJECTIVE_BUTTON + '<a id="continue-link" href="/page-two.html">Continue</a>');
    }
    if (path === "/page-two.html") {
      return void page("<p>A second page with nothing else reachable.</p>");
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

test("bounded journey replanning: a reasoning-layer-proposed stop_blocked is replaced with go_back, and the run then succeeds via the alternate path", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      objective: "Explore, then activate the objective control.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
    });
    const reasoning = new ExploresDeadEndThenObjectiveProvider();
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const replanningSteps = response.steps.filter((s) => s.safetyFlags?.includes("journey_replanning_attempted"));
    assert.equal(replanningSteps.length, 1, "expected exactly one bounded replanning attempt");
    assert.equal(replanningSteps[0]?.selectedAction.type, "go_back");
    assert.match(replanningSteps[0]?.decision ?? "", /Bounded journey replanning \(attempt 1\/2\)/);
    assert.match(replanningSteps[0]?.decision ?? "", /proposed by the reasoning layer/);

    // The go_back must be recorded through the ordinary backtrack accounting, not a
    // separate mechanism.
    assert.equal(response.diagnostics.backtrackCount, 1);

    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 2, "expected the dead-end link, then the objective control");
    assert.match(clicks[0]?.ctaText ?? "", /enter dead end/i);
    assert.match(clicks[1]?.ctaText ?? "", /objective control/i);

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("bounded journey replanning: exhausts after MAX_JOURNEY_REPLANNING_ATTEMPTS (2) and then honours stop_blocked, never exceeding the bound", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      objective: "Explore the dead end repeatedly.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
      limits: { maxSteps: 20, maxBacktracks: 5, maxRepeatedActions: 10 },
    });
    const reasoning = new StubbornDeadEndProvider(`${baseUrl}/dead-end.html`);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "blocked", `expected blocked, got ${response.status}/${response.statusReason}`);
    assert.equal(response.diagnostics.finishReason, "stop_blocked_action");

    const replanningSteps = response.steps.filter((s) => s.safetyFlags?.includes("journey_replanning_attempted"));
    assert.equal(replanningSteps.length, 2, "replanning must never exceed MAX_JOURNEY_REPLANNING_ATTEMPTS (2)");
    assert.ok(replanningSteps.every((s) => s.selectedAction.type === "go_back"));

    // Two bounded replanning attempts means exactly two go_backs -- well under the
    // generous maxBacktracks (5) configured for this task, proving the dedicated bound,
    // not maxBacktracks, is what actually stopped the replanning.
    assert.equal(response.diagnostics.backtrackCount, 2);

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("bounded journey replanning: never engages when go_back is not in the task's allowedActions", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      objective: "Explore the dead end.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
      safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    });
    // Reaches a reasoning-layer-proposed stop_blocked at step 1 (after exploring the single
    // dead end) exactly like the first test above -- the only difference is go_back's
    // absence from allowedActions, isolating that specific eligibility condition rather
    // than conflating it with "no previous page yet" (see the first-step test below).
    const reasoning = new ExploresDeadEndThenObjectiveProvider();
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "blocked");
    assert.equal(response.diagnostics.backtrackCount, 0, "go_back must never be substituted when it isn't an allowed action");
    assert.ok(
      !response.steps.some((s) => s.safetyFlags?.includes("journey_replanning_attempted")),
      "no step may claim a replanning attempt when go_back was never actually available",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("bounded journey replanning: never engages once maxBacktracks is already exhausted", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      objective: "Explore the dead end.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 8 },
    });
    const reasoning = new ExploresDeadEndThenObjectiveProvider();
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "blocked");
    assert.equal(response.diagnostics.backtrackCount, 0, "maxBacktracks: 0 must never be exceeded by a replanning attempt");
    assert.ok(!response.steps.some((s) => s.safetyFlags?.includes("journey_replanning_attempted")));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("bounded journey replanning: never engages on the run's very first step (no previous page to go back to)", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      objective: "Do nothing useful.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
    });
    const reasoning = new ImmediateStopBlockedProvider();
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 1, "the very first stop_blocked must be honoured immediately");
    assert.equal(response.diagnostics.backtrackCount, 0);
    assert.ok(!response.steps[0]?.safetyFlags?.includes("journey_replanning_attempted"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("bounded journey replanning: applies identically to a stop_blocked the safety layer substitutes for a domain_blocked decision", async () => {
  const { baseUrl, close } = await startJourneyReplanningFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/continue-start.html`,
      objective: "Continue, then activate the objective control.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
    });
    const reasoning = new DomainBlockedReplanningProvider();
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);

    const replanningSteps = response.steps.filter((s) => s.safetyFlags?.includes("journey_replanning_attempted"));
    assert.equal(replanningSteps.length, 1);
    assert.match(replanningSteps[0]?.decision ?? "", /substituted by the safety layer for a rejected decision/);
    assert.ok(replanningSteps[0]?.safetyFlags?.includes("domain_blocked"), "the original safety flag must still be preserved");

    // The safety-guard diagnostic for the rejected navigate must reflect that the run was
    // given a bounded replanning attempt, not that it actually stopped here.
    const domainBlockedErrors = (response.captures.errors ?? []).filter((e) => e.message.includes("domain_blocked"));
    assert.equal(domainBlockedErrors.length, 1);
    assert.equal(domainBlockedErrors[0]?.stoppedRun, false);
    assert.equal(domainBlockedErrors[0]?.recoverable, true);
    assert.match(domainBlockedErrors[0]?.message ?? "", /bounded journey replanning/i);

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
