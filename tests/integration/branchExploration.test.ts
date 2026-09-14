import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { RouteMemoryCandidateSummary } from "../../src/types/routeMemory.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Goal-Directed Bounded Branch Exploration (behavioural phase, building on PR #40 Action
 * Progress Awareness, PR #41 Bounded Journey Replanning, and PR #42 Route Memory Phase 1 --
 * see docs/architecture.md and src/core/branchExploration.ts). These tests drive the real
 * engine (navigate -> observe -> decide -> act -> check-success) against local, entirely
 * synthetic fixtures and prove the feature end to end: a candidate whose accessible-name
 * label shares no vocabulary with the objective can still be followed for several
 * downstream actions, judged on accumulated evidence, and abandoned (with a verified,
 * bounded return to its own decision point) in favour of the next untried candidate --
 * without ever clicking every visible control, without ever treating a page change alone
 * as objective progress, and without ever mislabeling a required, already-satisfied
 * milestone as part of a failed branch.
 *
 * No brand/market/CTA-specific wording anywhere in this file, per CLAUDE.md's non-negotiable
 * design rule; every route is synthetic, served from 127.0.0.1 on an ephemeral port. Every
 * candidate label below is deliberately generic and shares no vocabulary with any
 * objective/successCriteria text used against it, so the engine's own ambiguity/relevance
 * signal (never a hardcoded synonym list) is what drives branch entry.
 */

async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let hubW2RequestCount = 0;

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    // ---- Wing 1: a weakly-labelled candidate leads, several hops deep, to success; the
    // other weakly-labelled candidate at the same decision point is a dead end. ----
    if (path === "/w1/start.html") {
      return void page("W1 start", '<a href="/w1/entity.html">Enter section</a>');
    }
    if (path === "/w1/entity.html") {
      return void page(
        "W1 entity",
        '<a href="/w1/detail-1.html">View details</a><a href="/w1/dead-end.html">Learn about this</a>',
      );
    }
    if (path === "/w1/dead-end.html") {
      return void page("W1 dead end", "<p>Nothing else here.</p>");
    }
    if (path === "/w1/detail-1.html") {
      return void page("W1 detail 1", '<a href="/w1/detail-2.html">Continue</a>');
    }
    if (path === "/w1/detail-2.html") {
      return void page("W1 detail 2", '<a href="/w1/target.html">Continue</a>');
    }
    if (path === "/w1/target.html") {
      return void page("W1 target", "<h1>Reached.</h1>");
    }

    // ---- Wing 2: the origin decision point's own content changes between visits, so a
    // return cannot be verified -- exercises restore_failed. ----
    if (path === "/w2/start.html") {
      return void page("W2 start", '<a href="/w2/hub.html">Begin</a>');
    }
    if (path === "/w2/hub.html") {
      hubW2RequestCount += 1;
      const extra = hubW2RequestCount > 1 ? '<a href="/w2/unrelated.html">Unrelated later control</a>' : "";
      return void page(
        "W2 hub",
        `<a href="/w2/branch.html">Check option</a><a href="/w2/other.html">Look further</a>${extra}`,
      );
    }
    if (path === "/w2/branch.html") {
      return void page("W2 branch", "<p>Nothing else here.</p>");
    }
    if (path === "/w2/other.html") {
      return void page("W2 other", "<p>Also nothing here.</p>");
    }
    if (path === "/w2/unrelated.html") {
      return void page("W2 unrelated", "<p>Unrelated.</p>");
    }

    // ---- Wing 3: an in-branch loop (candidate leads through two downstream pages that
    // cycle back to the first). ----
    if (path === "/w3/start.html") {
      return void page("W3 start", '<a href="/w3/hub.html">Go</a>');
    }
    if (path === "/w3/hub.html") {
      return void page(
        "W3 hub",
        '<a href="/w3/loop-a.html">First path</a><a href="/w3/loop-fallback.html">Second path</a>',
      );
    }
    if (path === "/w3/loop-a.html") {
      return void page("W3 loop a", '<a href="/w3/loop-b.html">Next</a>');
    }
    if (path === "/w3/loop-b.html") {
      return void page("W3 loop b", '<a href="/w3/loop-a.html">Back to first</a>');
    }
    if (path === "/w3/loop-fallback.html") {
      return void page("W3 fallback", "<p>Unused fallback.</p>");
    }

    // ---- Wing 4: a candidate leads to a page whose only control never navigates anywhere
    // (two consecutive no-progress actions). ----
    if (path === "/w4/start.html") {
      return void page("W4 start", '<a href="/w4/hub.html">Go</a>');
    }
    if (path === "/w4/hub.html") {
      return void page(
        "W4 hub",
        '<a href="/w4/stay.html">Option A</a><a href="/w4/other.html">Option B</a>',
      );
    }
    if (path === "/w4/stay.html") {
      return void page("W4 stay", '<button type="button">Stay here</button>');
    }
    if (path === "/w4/other.html") {
      return void page("W4 other", "<p>Unused fallback.</p>");
    }

    // ---- Wing 5: a candidate that, once inside the branch, proposes crossing outside
    // allowedDomains -- exercises a safety-driven branch closure ("unsafe"). ----
    if (path === "/w5/start.html") {
      return void page("W5 start", '<a href="/w5/hub.html">Go</a>');
    }
    if (path === "/w5/hub.html") {
      return void page(
        "W5 hub",
        '<a href="/w5/branch.html">Check option</a><a href="/w5/other.html">Other option</a>',
      );
    }
    if (path === "/w5/branch.html") {
      return void page("W5 branch", "<p>Inside the branch.</p>");
    }
    if (path === "/w5/other.html") {
      return void page("W5 other", "<p>Unused fallback.</p>");
    }

    // ---- Wing 6: both candidates at one decision point are dead ends -- exercises the
    // candidate budget never being exceeded. ----
    if (path === "/w6/start.html") {
      return void page("W6 start", '<a href="/w6/hub.html">Go</a>');
    }
    if (path === "/w6/hub.html") {
      return void page(
        "W6 hub",
        '<a href="/w6/dead-1.html">Path one</a><a href="/w6/dead-2.html">Path two</a>',
      );
    }
    if (path === "/w6/dead-1.html") {
      return void page("W6 dead 1", "<p>Nothing here.</p>");
    }
    if (path === "/w6/dead-2.html") {
      return void page("W6 dead 2", "<p>Nothing here either.</p>");
    }

    // ---- Wing 7: two candidates TIE for the highest relevance score against the
    // objective, and that tied score is itself weak/non-dominant -- exercises the revised
    // entry condition (a magnitude threshold, not "every candidate scores zero"). ----
    if (path === "/w7/start.html") {
      return void page("W7 start", '<a href="/w7/hub.html">Go</a>');
    }
    if (path === "/w7/hub.html") {
      return void page(
        "W7 hub",
        '<a href="/w7/dead-end.html">Continue over to page</a><a href="/w7/target.html">Proceed over to page</a>',
      );
    }
    if (path === "/w7/dead-end.html") {
      return void page("W7 dead end", "<p>Nothing else here.</p>");
    }
    if (path === "/w7/target.html") {
      return void page("W7 target", "<h1>Reached.</h1>");
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

function baseTask(
  overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">,
): TaskRequest {
  return {
    schemaVersion: "1.11.0",
    taskId: "branch-exploration",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 25, maxBacktracks: 12, maxRepeatedActions: 6 },
    safety: { allowedActions: ["click", "go_back", "navigate", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.10.0",
    ...overrides,
  };
}

function isSatisfied(context: ReasoningContext): boolean {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  return requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
}

/**
 * A deterministic, route-memory-aware provider: on each call, clicks the first accessible
 * name from `preferredClicks` (in order) that is present on the current page and not
 * already marked dead_end/blocked/unsafe (branch-level) or blocked/failed (single-dispatch
 * level) in `context.routeMemory` -- mirroring, mechanically, the prompt guidance actually
 * given to a real reasoning provider ("prefer a control not shown as already
 * dead_end/blocked/unsafe/failed"). Falls back to stop_success once satisfied, or
 * stop_blocked/stop_failure once nothing plausible remains. Records every ReasoningContext
 * it was given, for assertions.
 */
class RouteMemoryAwareScriptedProvider implements ReasoningProvider {
  readonly contextsSeen: ReasoningContext[] = [];

  constructor(private readonly preferredClicks: readonly string[]) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    this.contextsSeen.push(context);

    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Required criteria satisfied." };
    }

    const avoidLabels = new Set(
      (context.routeMemory ?? [])
        .filter(
          (c) =>
            c.branchResult === "dead_end" ||
            c.branchResult === "blocked" ||
            c.branchResult === "unsafe" ||
            c.lastOutcome === "blocked" ||
            c.lastOutcome === "failed",
        )
        .map((c) => c.label),
    );

    for (const name of this.preferredClicks) {
      const el = context.observation.interactiveElements.find((e) => e.accessibleName === name);
      if (!el) {
        continue;
      }
      const label = `${el.role} "${el.accessibleName}"`;
      if (avoidLabels.has(label)) {
        continue;
      }
      if (context.allowedActions.includes("click")) {
        return { action: { type: "click", target: el.id }, rationale: `Trying "${name}".` };
      }
    }

    if (context.allowedActions.includes("stop_blocked")) {
      return { action: { type: "stop_blocked" }, rationale: "Nothing plausible remains at this decision point." };
    }
    return { action: { type: "stop_failure" }, rationale: "No permitted action available." };
  }
}

/** For Wing 5: proposes an off-domain navigate the instant a branch is active, to exercise a safety-driven branch closure. */
class BranchDomainRejectionProvider implements ReasoningProvider {
  readonly contextsSeen: ReasoningContext[] = [];

  async decide(context: ReasoningContext): Promise<Decision> {
    this.contextsSeen.push(context);
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Required criteria satisfied." };
    }
    if (context.branch && context.allowedActions.includes("navigate")) {
      return {
        action: { type: "navigate", target: "https://example-disallowed-site.test/" },
        rationale: "Attempting a navigation outside allowedDomains while inside the branch.",
      };
    }
    const elements = context.observation.interactiveElements;
    const go = elements.find((e) => e.accessibleName === "Go");
    if (go && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: go.id }, rationale: "Reaching the decision point." };
    }
    const check = elements.find((e) => e.accessibleName === "Check option");
    if (check && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: check.id }, rationale: "Entering the branch." };
    }
    if (context.allowedActions.includes("stop_blocked")) {
      return { action: { type: "stop_blocked" }, rationale: "Nothing else plausible." };
    }
    return { action: { type: "stop_failure" }, rationale: "No permitted action available." };
  }
}

function routeMemoryFor(candidates: RouteMemoryCandidateSummary[] | undefined, label: string) {
  return candidates?.find((c) => c.label === label);
}

// =========================================================================================
// Wing 1: multi-step exploration of a weakly-labelled candidate leads to success; the
// other weakly-labelled candidate at the same decision point is a dead end.
// =========================================================================================

test("a weakly-labelled candidate is followed through several intermediate states to success, without being rejected merely because its label differs from the objective", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w1/start.html`,
      objective: "Select the required entity, then reach the final destination page.",
      successCriteria: [
        {
          id: "entity-selected",
          type: "url_pattern",
          description: "The required entity's own page was reached.",
          config: { pattern: `${baseUrl}/w1/entity.html` },
          required: true,
        },
        {
          id: "reached-target",
          type: "url_pattern",
          description: "The final destination page was reached.",
          config: { pattern: `${baseUrl}/w1/target.html` },
          required: true,
        },
      ],
    });
    const provider = new RouteMemoryAwareScriptedProvider([
      "Enter section",
      "Learn about this",
      "View details",
      "Continue",
    ]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    // The required entity-selection milestone, once satisfied, must remain satisfied on
    // every subsequent step -- including all the steps spent inside and returning from
    // the dead-end branch -- never dropped because a later branch failed.
    const entityMilestoneStepIndex = response.steps.findIndex((s) =>
      s.progress.satisfiedCriteriaIds.includes("entity-selected"),
    );
    assert.ok(entityMilestoneStepIndex >= 0, "entity-selected must become satisfied at some step");
    for (const step of response.steps.slice(entityMilestoneStepIndex)) {
      assert.ok(
        step.progress.satisfiedCriteriaIds.includes("entity-selected"),
        `entity-selected must remain satisfied at step ${step.stepIndex}, even during/after the failed branch`,
      );
    }

    // Ordered-milestone enforcement (docs/n8n-integration.md §9f): "reached-target" is
    // declared after "entity-selected" and must never appear in satisfiedCriteriaIds at a
    // step where "entity-selected" is not also already present -- including every step
    // spent inside and returning from the dead-end branch, which produces several steps
    // with no criteria satisfied at all yet.
    for (const step of response.steps) {
      if (step.progress.satisfiedCriteriaIds.includes("reached-target")) {
        assert.ok(
          step.progress.satisfiedCriteriaIds.includes("entity-selected"),
          `step ${step.stepIndex} satisfied "reached-target" without "entity-selected" already satisfied`,
        );
      }
    }

    // Branch entry/closure diagnostics are present (errors capture, generic free-text).
    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(
      errorMessages.some((m) => m.includes("Entering bounded branch") && m.includes("Learn about this")),
      "expected a diagnostic for entering the dead-end branch",
    );
    assert.ok(
      errorMessages.some((m) => m.includes("Entering bounded branch") && m.includes("View details")),
      "expected a diagnostic for entering the successful branch",
    );

    // The dead-end branch's own outcome must have been surfaced to the reasoning provider
    // before the successful candidate was chosen -- proving the engine returned, verified
    // the original decision point, and let the next untried candidate be selected.
    const afterReturn = provider.contextsSeen.find((ctx) =>
      routeMemoryFor(ctx.routeMemory, 'a "Learn about this"')?.branchResult === "dead_end",
    );
    assert.ok(afterReturn, "the dead-end branch result must be surfaced to a later decision");
    assert.equal(routeMemoryFor(afterReturn?.routeMemory, 'a "Learn about this"')?.branchDepthReached, 0);

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 2: restore_failed when the origin decision point's own content changes between
// visits, so the return cannot be verified.
// =========================================================================================

test("a return that cannot be fingerprint-verified produces restore_failed and stops the run safely", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w2/start.html`,
      objective: "Proceed to explore and arrive at a suitable destination.",
      successCriteria: [
        {
          id: "reached-outcome",
          type: "url_pattern",
          description: "The intended outcome page was reached.",
          config: { pattern: `${baseUrl}/w2/never-reached.html` },
          required: true,
        },
      ],
    });
    const provider = new RouteMemoryAwareScriptedProvider(["Begin", "Check option", "Look further"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "blocked", `expected blocked, got ${response.status}/${response.statusReason}`);
    assert.equal(response.diagnostics.finishReason, "decision_point_restore_failed");

    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(
      errorMessages.some((m) => m.toLowerCase().includes("could not verify a return")),
      "expected a diagnostic explaining the failed restoration",
    );

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 3: an in-branch loop closes the branch as dead_end and the engine performs a
// verified, multi-hop return to the original decision point.
// =========================================================================================

test("a branch that loops back to a decision point it already visited closes as dead_end, and the engine performs a bounded multi-hop return verified by fingerprint", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w3/start.html`,
      objective: "Proceed to explore and arrive at a suitable destination.",
      successCriteria: [
        {
          id: "reached-outcome",
          type: "url_pattern",
          description: "An outcome page that this wing never actually reaches.",
          config: { pattern: `${baseUrl}/w3/never-reached.html` },
          required: true,
        },
      ],
      limits: { maxSteps: 25, maxBacktracks: 12, maxRepeatedActions: 8 },
    });
    const provider = new RouteMemoryAwareScriptedProvider(["Go", "First path", "Next", "Back to first"]);
    const response = await runTask({ page, task, reasoning: provider });

    // This wing has no reachable success page, so the run necessarily ends blocked/failure
    // once every candidate is exhausted -- what matters here is the branch lifecycle itself.
    assert.notEqual(response.status, "success");

    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(
      errorMessages.some((m) => m.includes("decision point already seen earlier in this same branch")),
      "expected the loop-specific dead_end reason to be recorded",
    );

    const afterReturn = provider.contextsSeen.find(
      (ctx) => routeMemoryFor(ctx.routeMemory, 'a "First path"')?.branchResult === "dead_end",
    );
    assert.ok(afterReturn, "the looped branch's result must be surfaced after a verified return");
    // Two downstream actions were taken inside the branch ("Next", "Back to first") before
    // the loop was detected.
    assert.equal(routeMemoryFor(afterReturn?.routeMemory, 'a "First path"')?.branchDepthReached, 2);

    // Exactly 3 go_back hops were needed to restore the origin decision point (depth + 1) --
    // never assumed, always driven by the fingerprint check.
    const branchReturnSteps = response.steps.filter((s) => s.safetyFlags?.includes("branch_return_attempted"));
    assert.equal(branchReturnSteps.length, 3, "expected exactly depth+1 (2+1=3) return hops");
    assert.ok(branchReturnSteps.every((s) => s.selectedAction.type === "go_back"));

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 4: two consecutive no-progress actions close the branch early.
// =========================================================================================

test("a branch ends early after two consecutive in-branch actions produce no observable progress", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w4/start.html`,
      objective: "Proceed to explore and arrive at a suitable destination.",
      successCriteria: [
        {
          id: "reached-outcome",
          type: "url_pattern",
          description: "An outcome page that this wing never actually reaches.",
          config: { pattern: `${baseUrl}/w4/never-reached.html` },
          required: true,
        },
      ],
    });
    const provider = new RouteMemoryAwareScriptedProvider(["Go", "Option A", "Stay here", "Option B"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.notEqual(response.status, "success");

    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(
      errorMessages.some((m) => m.includes("Two consecutive in-branch actions produced no observable page-state change")),
      "expected the no-progress-specific dead_end reason to be recorded",
    );

    const afterReturn = provider.contextsSeen.find(
      (ctx) => routeMemoryFor(ctx.routeMemory, 'a "Option A"')?.branchResult === "dead_end",
    );
    assert.ok(afterReturn, "the no-progress branch's result must be surfaced after a verified return");

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 5: a safety-layer rejection inside an active branch closes it as unsafe and returns.
// =========================================================================================

test("a branch closes safely (unsafe) when a downstream decision is rejected by the safety layer, and never crosses outside allowedDomains", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w5/start.html`,
      objective: "Proceed to explore and arrive at a suitable destination.",
      successCriteria: [
        {
          id: "reached-outcome",
          type: "url_pattern",
          description: "An outcome page that this wing never actually reaches.",
          config: { pattern: `${baseUrl}/w5/never-reached.html` },
          required: true,
        },
      ],
    });
    const provider = new BranchDomainRejectionProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.notEqual(response.status, "success");
    // The run must never actually navigate to the disallowed host.
    assert.ok(!response.steps.some((s) => s.currentUrl.includes("example-disallowed-site.test")));
    assert.equal(response.finalUrl.includes("example-disallowed-site.test"), false);

    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(
      errorMessages.some((m) => m.includes("domain_blocked")),
      "expected the domain rejection to be recorded",
    );

    const afterReturn = provider.contextsSeen.find(
      (ctx) => routeMemoryFor(ctx.routeMemory, 'a "Check option"')?.branchResult === "unsafe",
    );
    assert.ok(afterReturn, "the unsafe branch's result must be surfaced after a verified return");

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 6: candidate budget is never exceeded -- a third branch is never entered at the
// same decision point once both candidates have been tried.
// =========================================================================================

test("the candidate budget at one decision point is never exceeded: once both candidates are tried and dead-end, a third branch is never entered", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w6/start.html`,
      objective: "Proceed to explore and arrive at a suitable destination.",
      successCriteria: [
        {
          id: "reached-outcome",
          type: "url_pattern",
          description: "An outcome page that this wing never actually reaches.",
          config: { pattern: `${baseUrl}/w6/never-reached.html` },
          required: true,
        },
      ],
      limits: { maxSteps: 25, maxBacktracks: 12, maxRepeatedActions: 3 },
    });
    const provider = new RouteMemoryAwareScriptedProvider(["Go", "Path one", "Path two"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.notEqual(response.status, "success");

    const entryMessages = (response.captures.errors ?? [])
      .map((e) => e.message)
      .filter((m) => m.includes("Entering bounded branch"));
    // Exactly two branch entries at the hub decision point -- never a third, even though
    // the run continues (via PR #41's own pre-existing fallback) after both are exhausted.
    assert.equal(entryMessages.length, 2, `expected exactly 2 branch entries, got ${entryMessages.length}`);
    assert.ok(entryMessages.some((m) => m.includes("Path one")));
    assert.ok(entryMessages.some((m) => m.includes("Path two")));
    assert.ok(entryMessages.every((m) => m.includes("candidate 1/2") || m.includes("candidate 2/2")));

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Wing 7: two candidates TIE for the highest, non-zero relevance score -- branch entry
// engages even though not every candidate scores zero (the revised entry condition).
// =========================================================================================

test("branch exploration engages when two candidates tie for the highest relevance score and that score is weak, not only when every candidate scores exactly zero", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w7/start.html`,
      objective: "Reach the destination page.",
      successCriteria: [
        {
          id: "reached-target",
          type: "url_pattern",
          description: "The destination page was reached.",
          config: { pattern: `${baseUrl}/w7/target.html` },
          required: true,
        },
      ],
    });
    // Both "Continue over to page" and "Proceed over to page" share exactly one token
    // ("page") out of three of their own with the objective/criteria text and so score
    // identically (0.333) under objectiveRelevanceScore -- a genuine tie, and a weak one,
    // below the dominance threshold. Under the earlier "every candidate scores zero"
    // condition this decision point would never have entered branch mode at all (neither
    // candidate scores exactly zero); under a bare tie-detection rule a *strong* tie (e.g.
    // two candidates each fully matching their own short label) would incorrectly trigger
    // branch mode too -- see tests/unit/branchExploration.test.ts's own regression-shaped
    // coverage for that case.
    const provider = new RouteMemoryAwareScriptedProvider(["Go", "Continue over to page", "Proceed over to page"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);

    const entryMessages = (response.captures.errors ?? [])
      .map((e) => e.message)
      .filter((m) => m.includes("Entering bounded branch"));
    assert.ok(
      entryMessages.some((m) => m.includes("Continue over to page")),
      "expected branch mode to engage for the tied, dead-end candidate",
    );

    const afterReturn = provider.contextsSeen.find(
      (ctx) => routeMemoryFor(ctx.routeMemory, 'a "Continue over to page"')?.branchResult === "dead_end",
    );
    assert.ok(afterReturn, "the tied dead-end candidate's branch result must be surfaced before the other tied candidate is tried");

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// =========================================================================================
// Backward compatibility: an ordinary, non-ambiguous journey behaves exactly as before this
// phase -- no branch is ever entered, no branch-related safetyFlags/diagnostics appear.
// =========================================================================================

test("an ordinary, unambiguous single-candidate journey never enters branch mode and behaves exactly as before this phase", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/w1/start.html`,
      objective: "Enter the required section.",
      successCriteria: [
        {
          id: "entity-selected",
          type: "url_pattern",
          description: "The required section's own page was reached.",
          config: { pattern: `${baseUrl}/w1/entity.html` },
          required: true,
        },
      ],
    });
    // "Enter section" is the only candidate on /w1/start.html -- never an ambiguous
    // decision point, so branch mode must never engage even though this same server also
    // hosts the ambiguous /w1/entity.html decision point (never reached as a *decision*
    // here, since the single required criterion is satisfied the moment entity.html loads).
    const provider = new RouteMemoryAwareScriptedProvider(["Enter section"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.ok(!response.steps.some((s) => s.safetyFlags?.some((f) => f.startsWith("branch_"))));
    const errorMessages = (response.captures.errors ?? []).map((e) => e.message);
    assert.ok(!errorMessages.some((m) => m.includes("Entering bounded branch")));

    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
