import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import {
  waitForAdaptiveSettle,
  robustGoto,
  PAGE_SETTLE_DELAY_MS,
  SETTLE_QUIET_WINDOW_MS,
  DEFAULT_SETTLE_CEILING_MS,
  MAX_SETTLE_CEILING_MS,
} from "../../src/core/robustNavigation.js";
import { executeClick } from "../../src/actions/click.js";
import { executeNavigate } from "../../src/actions/navigate.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Phase 3 PR 1 (adaptive settling -- see CLAUDE.md and docs/architecture.md §24). Every
 * fixture below is purely synthetic, no brand/market/CTA text, served from 127.0.0.1 on an
 * ephemeral port (mirrors tests/integration/nonAriaSurfaceDetection.test.ts's convention).
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/quiet.html") {
      // Nothing ever mutates after load -- the common, fast-page case.
      return void page("Quiet page", '<button type="button" id="continue">Continue</button>');
    }

    if (path === "/mutating.html") {
      // Mutates document.body forever (a non-interactive div appended every 30ms) -- a page
      // that never goes quiet, so any settle wait against it must always be cut off at its
      // ceiling, never resolve early.
      return void page(
        "Never-quiet page",
        '<button type="button" id="continue">Continue</button>' +
          "<script>setInterval(function () { var d = document.createElement('div'); document.body.appendChild(d); }, 30);</script>",
      );
    }

    if (path === "/click-opens-mutating-panel.html") {
      // A click that, once dispatched, keeps the page mutating forever afterward -- proves
      // the click executor's own post-click settle point is cut off at its ceiling rather
      // than hanging, and that the click itself still reports success.
      return void page(
        "Panel trigger",
        '<button type="button" id="trigger">Open</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  setInterval(function () { var d = document.createElement('div'); document.body.appendChild(d); }, 30);" +
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

test("waitForAdaptiveSettle: a page that never mutates after load resolves early as quiet_window, never later than the floor + quiet window", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/quiet.html`);
    const result = await waitForAdaptiveSettle(page);
    assert.equal(result.reason, "quiet_window");
    assert.ok(result.elapsedMs >= PAGE_SETTLE_DELAY_MS, `expected elapsedMs (${result.elapsedMs}) >= floor (${PAGE_SETTLE_DELAY_MS})`);
    // Generous upper bound: floor + quiet window + one polling interval's worth of slack.
    const upperBound = PAGE_SETTLE_DELAY_MS + SETTLE_QUIET_WINDOW_MS + 500;
    assert.ok(result.elapsedMs <= upperBound, `expected a quiet page to settle well under its ceiling (got ${result.elapsedMs}ms)`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("waitForAdaptiveSettle: a page that mutates forever is cut off at a caller-supplied ceiling, reported as ceiling_reached", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/mutating.html`);
    const ceilingMs = 500;
    const result = await waitForAdaptiveSettle(page, { ceilingMs });
    assert.equal(result.reason, "ceiling_reached");
    assert.ok(result.elapsedMs >= ceilingMs, `expected elapsedMs (${result.elapsedMs}) >= ceiling (${ceilingMs})`);
    assert.ok(result.elapsedMs <= ceilingMs + 300, `expected the wait to be cut off close to its ceiling (got ${result.elapsedMs}ms)`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("waitForAdaptiveSettle: a requested ceiling above MAX_SETTLE_CEILING_MS is clamped to the hard cap, never honoured verbatim", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/mutating.html`);
    const result = await waitForAdaptiveSettle(page, { ceilingMs: MAX_SETTLE_CEILING_MS * 10 });
    assert.equal(result.reason, "ceiling_reached");
    assert.ok(
      result.elapsedMs <= MAX_SETTLE_CEILING_MS + 500,
      `expected the wait to be clamped to MAX_SETTLE_CEILING_MS (${MAX_SETTLE_CEILING_MS}ms), got ${result.elapsedMs}ms`,
    );
    assert.ok(result.elapsedMs >= MAX_SETTLE_CEILING_MS, `expected the wait to actually run the full clamped ceiling, got ${result.elapsedMs}ms`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("waitForAdaptiveSettle: default ceiling (no config) is DEFAULT_SETTLE_CEILING_MS, not MAX_SETTLE_CEILING_MS", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/mutating.html`);
    const result = await waitForAdaptiveSettle(page);
    assert.equal(result.reason, "ceiling_reached");
    assert.ok(
      result.elapsedMs <= DEFAULT_SETTLE_CEILING_MS + 500,
      `expected the default-config wait to be cut off at DEFAULT_SETTLE_CEILING_MS (${DEFAULT_SETTLE_CEILING_MS}ms), got ${result.elapsedMs}ms`,
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("robustGoto: a successful navigation to a quiet page reports settleDiagnostic", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const outcome = await robustGoto({ page, url: `${baseUrl}/quiet.html`, allowedDomains: ["127.0.0.1"], timeoutMs: 10000 });
    assert.equal(outcome.status, "ok");
    assert.ok(outcome.settleDiagnostic, "expected a settleDiagnostic on a successful navigation");
    assert.equal(outcome.settleDiagnostic!.reason, "quiet_window");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("executeNavigate: settleDiagnostic is present on the returned ActionResult and honours a caller-supplied settleCeilingMs", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const ceilingMs = 400;
    const result = await executeNavigate({
      page,
      action: { type: "navigate", target: `${baseUrl}/mutating.html` },
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 10000,
      captures: {},
      stepIndex: 0,
      captureModules: ["errors"],
      settleCeilingMs: ceilingMs,
    });
    assert.equal(result.success, true);
    assert.ok(result.settleDiagnostic, "expected settleDiagnostic on the ActionResult");
    assert.equal(result.settleDiagnostic!.reason, "ceiling_reached");
    assert.ok(
      result.settleDiagnostic!.elapsedMs <= ceilingMs + 300,
      `expected the navigate action's own settle to honour the requested ceiling (got ${result.settleDiagnostic!.elapsedMs}ms)`,
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("executeClick: a click that leaves the page mutating forever still succeeds and reports a ceiling-bounded settleDiagnostic", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/click-opens-mutating-panel.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "Open");
    assert.ok(target, "expected the trigger button in the initial observation");

    const ceilingMs = 400;
    const result = await executeClick({
      page,
      action: { type: "click", target: target!.id },
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 10000,
      captures: {},
      stepIndex: 0,
      captureModules: ["errors"],
      settleCeilingMs: ceilingMs,
    });

    assert.equal(result.success, true);
    assert.ok(result.settleDiagnostic, "expected settleDiagnostic on the click's ActionResult");
    assert.equal(result.settleDiagnostic!.reason, "ceiling_reached");
    assert.ok(
      result.settleDiagnostic!.elapsedMs <= ceilingMs + 300,
      `expected the click's own post-click settle to honour the requested ceiling (got ${result.settleDiagnostic!.elapsedMs}ms)`,
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

function buildTask(params: { startUrl: string; maxSettleMs?: number }): TaskRequest {
  return {
    schemaVersion: "1.20.0",
    taskId: "adaptive-settling-wiring",
    objective: "Click the trigger control and stop once the destination control is visible.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "trigger_gone", type: "element_present", description: "unused", config: { selector: "#never-present" }, required: false },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 4, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    ...(params.maxSettleMs !== undefined ? { settling: { maxSettleMs: params.maxSettleMs } } : {}),
    outputSchemaVersion: "1.21.0",
  };
}

class ClickTriggerOnceProvider implements ReasoningProvider {
  private decisionCount = 0;
  async decide(context: ReasoningContext): Promise<Decision> {
    this.decisionCount += 1;
    if (this.decisionCount === 1) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Open");
      if (trigger) {
        return { action: { type: "click", target: trigger.id }, rationale: "Open the panel." };
      }
    }
    return { action: { type: "stop_success" }, rationale: "Done." };
  }
}

test("core/loop.ts wiring: task.settling.maxSettleMs is threaded through dispatchAction into the step's own settleDiagnostic", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const maxSettleMs = 400;
    const task = buildTask({ startUrl: `${baseUrl}/click-opens-mutating-panel.html`, maxSettleMs });
    const response = await runTask({ page, task, reasoning: new ClickTriggerOnceProvider() });

    const clickStep = response.steps.find((s) => s.selectedAction.type === "click");
    assert.ok(clickStep, "expected the click step to be recorded");
    assert.ok(clickStep!.settleDiagnostic, "expected settleDiagnostic on the click step");
    assert.equal(clickStep!.settleDiagnostic!.reason, "ceiling_reached");
    assert.ok(
      clickStep!.settleDiagnostic!.elapsedMs <= maxSettleMs + 300,
      `expected the task-level maxSettleMs override to bound this step's settle wait (got ${clickStep!.settleDiagnostic!.elapsedMs}ms)`,
    );
    assert.equal(clickStep!.actionResult.settleDiagnostic, clickStep!.settleDiagnostic, "stepLog.settleDiagnostic must mirror actionResult.settleDiagnostic");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
