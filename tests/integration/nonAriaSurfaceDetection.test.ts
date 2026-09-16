import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { executeClick } from "../../src/actions/click.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * PR 1C-a (drawer/modal/half-window detection beyond role="dialog"/aria-modal, post-click
 * surface awareness, readiness-based post-click timing -- see CLAUDE.md and
 * docs/architecture.md §19). Generic reproductions of the diagnosed Nissan-investigation
 * failure mode's root cause: a click opens a side-panel/drawer built with plain CSS
 * (position: fixed, no role="dialog"/aria-modal at all), which the existing standards-based
 * activeDialog/clickSideEffectDetected signals cannot see. Nothing here is specific to any
 * website, brand, market, or CTA label -- every route is synthetic, served from 127.0.0.1 on
 * an ephemeral port (mirrors tests/integration/overlayClickDetection.test.ts's convention).
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/drawer.html") {
      // A classic slide-in side drawer: fixed positioning, spans the full viewport height,
      // occupies a meaningful fraction of its width -- but deliberately carries NONE of
      // role="dialog"/aria-modal/<dialog>, and never touches the trigger button's own
      // aria-expanded/covered state (the trigger sits in the top-left, the drawer opens on
      // the right and never overlaps it) -- so neither activeDialog nor the existing
      // target-attributed clickSideEffectDetected can see it. Only the new, broader
      // panel-heuristic (classifyObservedSurfaceChange) should recognise this.
      return void page(
        "Offer listing",
        '<button type="button" id="trigger" style="position:absolute;top:0;left:0;">View Offer Details</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'drawer';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Offer details</h2>' +" +
          "    '<button type=\"button\" id=\"request-quote\">Request a Quote</button>' +" +
          "    '<button type=\"button\" id=\"close-drawer\">Close</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('close-drawer').addEventListener('click', function () { d.remove(); });" +
          "});" +
          "</script>",
      );
    }

    if (path === "/toast.html") {
      // A small, non-panel-shaped notification -- below the viewport-coverage/full-edge
      // heuristic's bar, and never co-occurring with two or more new controls (only one).
      // Must NOT be classified as a new surface at all.
      return void page(
        "Toast",
        '<button type="button" id="trigger">Save draft</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var t = document.createElement('div');" +
          "  t.style.cssText = 'position:fixed;bottom:8px;right:8px;width:160px;height:32px;background:#333;color:#fff;';" +
          "  t.innerHTML = '<button type=\"button\">Dismiss</button>';" +
          "  document.body.appendChild(t);" +
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

function buildTask(params: { startUrl: string; successCriteria: TaskRequest["successCriteria"] }): TaskRequest {
  return {
    schemaVersion: "1.17.0",
    taskId: "non-aria-surface-detection",
    objective: "Reach the fixture's drawer-opened control.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: params.successCriteria,
    captureModules: ["errors"],
    limits: { maxSteps: 6, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.16.0",
  };
}

test("actions/click.ts directly: a non-ARIA drawer (plain CSS, no role=dialog/aria-modal, never covering or expanding the trigger) is reported as surfaceChangeDetected/layer_panel_appeared, distinctly from the unaffected, still-false clickSideEffectDetected", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/drawer.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "View Offer Details");
    assert.ok(target, "expected the trigger button in the initial observation");
    assert.equal(observation.activeDialog, undefined, "the fixture must not use role=dialog/aria-modal at all");

    const captures = {};
    const result = await executeClick({
      page,
      action: { type: "click", target: target!.id },
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 10000,
      captures,
      stepIndex: 0,
      captureModules: ["errors"],
    });

    assert.equal(result.success, true);
    assert.equal(
      result.clickSideEffectDetected,
      undefined,
      "the trigger's own state never changes (not covered, no aria-expanded, still attached) -- the stricter, target-attributed signal must stay unaffected",
    );
    assert.equal(result.surfaceChangeDetected, true, "the broader panel heuristic must recognise the newly-appeared drawer");
    assert.equal(result.surfaceChangeType, "layer_panel_appeared");

    const drawerVisible = await page.evaluate(() => document.getElementById("drawer") !== null);
    assert.equal(drawerVisible, true);
    const nextObservation = await buildObservation(page);
    const drawerControl = nextObservation.interactiveElements.find((el) => el.accessibleName === "Request a Quote");
    assert.ok(drawerControl, "the drawer's own control must be visible to the very next observation");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("actions/click.ts directly: a small, non-panel-shaped notification with only one new control is never classified as a new surface", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/toast.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "Save draft");
    assert.ok(target);

    const result = await executeClick({
      page,
      action: { type: "click", target: target!.id },
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 10000,
      captures: {},
      stepIndex: 0,
      captureModules: ["errors"],
    });

    assert.equal(result.success, true);
    assert.equal(result.surfaceChangeDetected, undefined, "a small, single-control notification must not be misclassified as a new surface");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

/**
 * Confirms the full wiring, not just the click executor in isolation: opens the drawer on
 * step 1, then asserts that the *second* decide() call's own ReasoningContext.recentActions
 * carries surfaceChangeType on the just-recorded click -- proving
 * core/state.ts's recordAction and src/reasoning/promptBuilder.ts's consumption of it are
 * correctly wired end to end, directly addressing the diagnosed root cause ("the engine did
 * not confidently understand the newly opened surface" -- it now has an explicit signal for
 * exactly this in the very next decision's own context).
 */
class DrawerThenQuoteProvider implements ReasoningProvider {
  public recentActionsOnSecondDecision: ReasoningContext["recentActions"] | undefined;
  private decisionCount = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.decisionCount += 1;
    if (this.decisionCount === 2) {
      this.recentActionsOnSecondDecision = context.recentActions;
    }
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    if (requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id)) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    const quoteControl = context.observation.interactiveElements.find((el) => el.accessibleName === "Request a Quote");
    if (quoteControl) {
      return { action: { type: "click", target: quoteControl.id }, rationale: "Click the drawer's own control." };
    }
    const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "View Offer Details");
    if (trigger) {
      return { action: { type: "click", target: trigger.id }, rationale: "Open the drawer." };
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("core/loop.ts wiring: the next decision's ReasoningContext.recentActions carries surfaceChangeType for the click that opened the drawer", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/drawer.html`,
      successCriteria: [
        {
          id: "quote_control_present",
          type: "element_present",
          description: "The drawer's own control is present.",
          config: { selector: "#request-quote" },
        },
      ],
    });
    const provider = new DrawerThenQuoteProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.ok(provider.recentActionsOnSecondDecision, "expected a second decision to have been made");
    const drawerOpenAction = provider.recentActionsOnSecondDecision!.find((a) => a.type === "click");
    assert.ok(drawerOpenAction, "expected the drawer-opening click to be in recentActions by the second decision");
    assert.equal(drawerOpenAction!.surfaceChangeType, "layer_panel_appeared");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
