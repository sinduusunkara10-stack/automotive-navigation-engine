import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { RecordedAction } from "../../src/types/actions.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * REGRESSION (production incident NIS-20260910-94E42B): the engine reached a destination
 * page via a click, then re-selected the exact same click again. The repeat executed
 * without error and was reported as a successful action (actions/click.ts's own success
 * definition is "no Playwright error", never "the page actually changed"), but produced no
 * URL or title change -- and nothing fed back into the next reasoning decision told the
 * model that. Root cause traced to core/state.ts/core/loop.ts: RunState.actionHistory (and
 * the recentActions this repo's reasoning providers are given) carried only action
 * identity, never outcome. The fix adds a generic, capture-module-independent
 * `observedProgress` flag to each recorded action -- a plain url/title diff against the
 * next observation actually taken, computed identically for every action type -- and
 * threads it into ReasoningContext.recentActions.
 *
 * Nothing here is brand/market/CTA/URL-specific: every route is synthetic, served from
 * 127.0.0.1 on an ephemeral port (mirrors tests/integration/actionExecutionConsistency.test.ts).
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
      return void page(
        "Start",
        '<button type="button">Stay</button><a href="/done.html">Continue</a>',
      );
    }
    if (path === "/progress-start.html") {
      return void page("Start", '<a href="/progress-mid.html">Continue</a>');
    }
    if (path === "/progress-mid.html") {
      return void page("Mid", '<a href="/done.html">Finish</a>');
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
 * Deterministic fake provider: on each call it records a deep copy of the
 * `recentActions` it was actually given (so the test can inspect exactly what the
 * reasoning layer saw at each turn), then clicks the next not-yet-clicked element named in
 * `script`, in order, falling back to stop_success once required criteria are already
 * satisfied (matching a real model's behaviour) or stop_failure once the script and page
 * are both exhausted.
 */
class ScriptedRecordingProvider implements ReasoningProvider {
  readonly recentActionsSeen: RecordedAction[][] = [];
  private cursor = 0;

  constructor(private readonly script: readonly string[]) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    this.recentActionsSeen.push(context.recentActions.map((a) => ({ ...a })));

    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }

    const name = this.script[this.cursor];
    this.cursor += 1;
    const candidate = name
      ? context.observation.interactiveElements.find((el) => el.accessibleName === name)
      : undefined;
    if (candidate && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: candidate.id }, rationale: `Click "${name}".` };
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "Script exhausted with no matching candidate." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function buildTask(params: { startUrl: string; successUrlPattern: string }): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "action-progress-tracking",
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
    limits: { maxSteps: 6, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
  };
}

test("a click that executes without error but produces no URL/title change is tracked as observedProgress: false, and that outcome reaches the very next reasoning decision", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/no-progress-start.html`, successUrlPattern: `${baseUrl}/done.html` });
    const reasoning = new ScriptedRecordingProvider(["Stay", "Continue"]);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);

    // First decision: no history yet.
    assert.deepEqual(reasoning.recentActionsSeen[0], []);

    // Second decision (after the "Stay" click executed successfully but left the page
    // unchanged): recentActions must show that action with observedProgress: false, not
    // omitted and not true.
    const afterStay = reasoning.recentActionsSeen[1];
    assert.equal(afterStay?.length, 1);
    assert.equal(afterStay?.[0]?.type, "click");
    assert.equal(afterStay?.[0]?.observedProgress, false);

    // The click itself must still have been reported as an ordinary successful action step
    // (no error captured for it) -- this defect was specifically that a no-op click looked
    // identical to a working one from the action-result side; only recentActions should
    // change, not click success semantics.
    const stayStep = response.steps.find((s) => s.selectedAction.type === "click" && s.currentUrl === `${baseUrl}/no-progress-start.html`);
    assert.equal(stayStep?.actionResult.success, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("existing successful multi-step navigation is unaffected: advancing clicks are tracked as observedProgress: true and the run still succeeds exactly as before", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/progress-start.html`, successUrlPattern: `${baseUrl}/done.html` });
    const reasoning = new ScriptedRecordingProvider(["Continue", "Finish"]);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    assert.equal(response.captures.errors, undefined);

    // Second decision (after the "Continue" click actually navigated): observedProgress
    // must be true, not false and not omitted.
    const afterContinue = reasoning.recentActionsSeen[1];
    assert.equal(afterContinue?.length, 1);
    assert.equal(afterContinue?.[0]?.observedProgress, true);

    // Third decision (after "Finish" navigated to the success page): both recorded
    // actions show progress.
    const afterFinish = reasoning.recentActionsSeen[2];
    assert.equal(afterFinish?.length, 2);
    assert.equal(afterFinish?.[0]?.observedProgress, true);
    assert.equal(afterFinish?.[1]?.observedProgress, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
