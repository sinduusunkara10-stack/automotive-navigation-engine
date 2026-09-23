import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { RouteMemoryCandidateSummary } from "../../src/types/routeMemory.js";

/**
 * Route Memory (Phase 1: decision-point fingerprint, candidate identity tracking,
 * candidate outcome tracking, and prompt context showing tried candidates at the current
 * decision point -- see core/routeMemory.ts). These tests drive the real engine
 * (navigate -> observe -> decide -> act -> check-success) against a local, entirely
 * synthetic fixture (mirrors tests/integration/actionProgressTracking.test.ts) and prove
 * the feature end to end: a candidate tried at one step is visible to the reasoning layer
 * the next time the *same decision point* is reached -- including non-adjacently, after a
 * go_back returns to an already-seen page -- which the pre-existing
 * recentActions[].observedProgress mechanism (a plain linear history) cannot recognise on
 * its own, since it never re-identifies "the same page" once other steps intervene.
 *
 * No brand/market/CTA-specific wording anywhere in this file, per CLAUDE.md's non-negotiable
 * design rule; every route is synthetic, served from 127.0.0.1 on an ephemeral port.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/done.html") {
      return void page("Done", "<h1>Done</h1>");
    }
    if (path === "/no-progress-start.html") {
      return void page("Start", '<button type="button">Stay</button><a href="/done.html">Continue</a>');
    }
    if (path === "/a.html") {
      return void page("A", '<a href="/c.html">Detour</a><a href="/done.html">Continue</a>');
    }
    if (path === "/c.html") {
      return void page("C", "<p>Dead end, nothing useful here.</p>");
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

/**
 * Deterministic fake provider: records a deep copy of `context.routeMemory` on every call
 * (undefined when the field is absent, matching the real optional-context-field
 * convention), then follows a fixed script of instructions in order --
 * `click:<accessibleName>` or `go_back` -- falling back to stop_success once required
 * criteria are satisfied, or stop_failure once the script and page are both exhausted.
 */
class ScriptedRouteMemoryProvider implements ReasoningProvider {
  readonly routeMemorySeen: Array<RouteMemoryCandidateSummary[] | undefined> = [];
  private cursor = 0;

  constructor(private readonly script: readonly string[]) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    this.routeMemorySeen.push(context.routeMemory ? context.routeMemory.map((c) => ({ ...c })) : undefined);

    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }

    const instruction = this.script[this.cursor];
    this.cursor += 1;

    if (instruction === "go_back" && context.allowedActions.includes("go_back")) {
      return { action: { type: "go_back" }, rationale: "Going back per script." };
    }
    if (instruction?.startsWith("click:")) {
      const name = instruction.slice("click:".length);
      const candidate = context.observation.interactiveElements.find((el) => el.accessibleName === name);
      if (candidate && context.allowedActions.includes("click")) {
        return { action: { type: "click", target: candidate.id }, rationale: `Click "${name}" per script.` };
      }
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "Script exhausted with no matching candidate." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function buildTask(params: { startUrl: string; successUrlPattern: string; maxBacktracks?: number }): TaskRequest {
  return {
    schemaVersion: "1.23.0",
    taskId: "route-memory-phase-1",
    objective: "Reach the fixture's target page via the configured controls.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_target",
        type: "url_pattern",
        description: "The current page URL matches the configured target.",
        config: { pattern: params.successUrlPattern },
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: params.maxBacktracks ?? 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.24.0",
  };
}

test("a candidate tried at one step (no observable progress) is surfaced in routeMemory the very next time the same decision point is decided on", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/no-progress-start.html`, successUrlPattern: `${baseUrl}/done.html` });
    const provider = new ScriptedRouteMemoryProvider(["click:Stay", "click:Continue"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);

    // First decision at /no-progress-start.html: nothing tried here yet.
    assert.equal(provider.routeMemorySeen[0], undefined);

    // Second decision: still at /no-progress-start.html (the "Stay" click executed but
    // produced no url/title change), so this is the *same* decision point again --
    // routeMemory must now show the "Stay" candidate as tried once, with lastOutcome
    // "no_change".
    const afterStay = provider.routeMemorySeen[1];
    assert.equal(afterStay?.length, 1);
    assert.equal(afterStay?.[0]?.actionType, "click");
    assert.equal(afterStay?.[0]?.label, 'button "Stay"');
    assert.equal(afterStay?.[0]?.attempts, 1);
    assert.equal(afterStay?.[0]?.lastOutcome, "no_change");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("route memory recognises the same decision point non-adjacently, after a go_back returns to an already-seen page whose element ids have been reassigned by the fresh page load", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/a.html`,
      successUrlPattern: `${baseUrl}/done.html`,
      maxBacktracks: 2,
    });
    // Step 0: at /a.html, click "Detour" (navigates away -- this *does* make progress).
    // Step 1: at /c.html (dead end), go back.
    // Step 2: back at /a.html -- a fresh navigation/back-nav re-scans the page and
    // reassigns every element's own ephemeral id, but the decision point's fingerprint
    // (role+accessibleName, not id) must still recognise it as the same page as step 0.
    // Step 3: at /done.html, stop_success (handled automatically by the scripted provider
    // once required criteria are satisfied).
    const provider = new ScriptedRouteMemoryProvider(["click:Detour", "go_back", "click:Continue"]);
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);

    // Step 0 (first ever visit to /a.html): nothing tried yet.
    assert.equal(provider.routeMemorySeen[0], undefined);
    // Step 1 (first ever visit to /c.html): unrelated decision point, nothing tried yet.
    assert.equal(provider.routeMemorySeen[1], undefined);

    // Step 2: back at /a.html. Route Memory must recognise this as the *same* decision
    // point as step 0, purely from the page's own content (url + role/accessibleName of
    // its controls) -- never from the element id, which a real browser back-navigation is
    // free to have reassigned via a fresh scan.
    const afterGoBack = provider.routeMemorySeen[2];
    assert.equal(afterGoBack?.length, 1, "the earlier Detour attempt must be visible again at the revisited decision point");
    assert.equal(afterGoBack?.[0]?.actionType, "click");
    assert.equal(afterGoBack?.[0]?.label, 'a "Detour"');
    assert.equal(afterGoBack?.[0]?.attempts, 1);
    // The Detour click did navigate away from /a.html (url changed to /c.html) -- once
    // resolveLastActionProgress confirmed that at the top of step 1, the provisional
    // "no_change" outcome recorded at dispatch time must have been upgraded to "advanced".
    assert.equal(afterGoBack?.[0]?.lastOutcome, "advanced");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
