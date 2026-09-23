import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Panel-attribution corrective pass (see CLAUDE.md and the BMW-enquire-panel investigation
 * §13): generic, brand-neutral regression coverage for items 1-5 of the approved design --
 * panel-scoped evidence, causal identity reaching the planner, the close-guard, cache
 * staleness, and ordered-milestone chaining within one evidence transition. Every fixture
 * here is synthetic HTML served from 127.0.0.1 on an ephemeral port, following the exact
 * same convention as tests/integration/nonAriaSurfaceDetection.test.ts's /drawer.html --
 * nothing here is specific to any website, brand, market, or CTA label.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/panel.html") {
      // A causally-linked, non-ARIA panel whose own scoped content (headings +
      // interactive-control labels only -- gatherPanelEvidence never reads arbitrary
      // paragraph text) shares substantial vocabulary with the task's own objective/
      // criteria below, so it scores at or above RELEVANCE_ADOPT_THRESHOLD. The trigger sits
      // apart from the panel and is never covered by it, so the click succeeds outright
      // (mirrors actions/click.ts's non-intercepted "settled_panel" path).
      return void page(
        "Item Page",
        '<button type="button" id="trigger" style="position:absolute;top:0;left:0;">Show Info</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Item Details</h2><h3>Panel Now Visible</h3>' +" +
          "    '<button type=\"button\" id=\"read-more\">Read More</button>' +" +
          "    '<button type=\"button\" id=\"close-panel\">Close</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('close-panel').addEventListener('click', function () { d.remove(); });" +
          "});" +
          "</script>",
      );
    }

    if (path === "/panel-ambiguous.html") {
      // Same causal/structural shape, but scores in the *ambiguous* relevance band (some
      // overlap, not enough to adopt) -- deliberately never satisfies milestone 2 on its
      // own (no semanticVerifier is configured in the test that uses this fixture), so the
      // surface is never marked verified. Used specifically to test the item-3 close-guard
      // in isolation from item 5's same-step chaining (a fully "adopt"-tier panel gets
      // marked verified in the very same step, which would legitimately allow closing it
      // per the guard's own override (a) -- see this module's own comment on that fixture).
      return void page(
        "Item Page",
        '<button type="button" id="trigger" style="position:absolute;top:0;left:0;">Show Info</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Panel Details Shown</h2>' +" +
          "    '<button type=\"button\" id=\"read-more\">Read More</button>' +" +
          "    '<button type=\"button\" id=\"close-panel\">Close</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('close-panel').addEventListener('click', function () { d.remove(); });" +
          "});" +
          "</script>",
      );
    }

    if (path === "/panel-unrelated.html") {
      // Structurally identical panel shape (same coverage/size heuristics), but its own
      // scoped content shares no vocabulary at all with the objective/criteria below -- a
      // generic newsletter-style popup, deliberately unrelated.
      return void page(
        "Item Page",
        '<button type="button" id="trigger" style="position:absolute;top:0;left:0;">Show Info</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Subscribe To Our Newsletter</h2>' +" +
          "    '<button type=\"button\" id=\"signup\">Sign Up</button>' +" +
          "    '<button type=\"button\" id=\"close-panel\">No Thanks</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('close-panel').addEventListener('click', function () { d.remove(); });" +
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

// Deliberately chosen so the two milestones' own vocabulary never overlaps: milestone 1
// ("Show Info was clicked") matches only the trigger's own page-level accessible name, and
// the (short) task objective; milestone 2 ("...item details panel...now visible...") matches
// only panel.html's own scoped headings ("Item Details" / "Panel Now Visible") -- see the
// module comment's own token-coverage walkthrough. panel-unrelated.html's content
// ("Subscribe To Our Newsletter" / "Sign Up" / "No Thanks") overlaps with neither.
function buildTask(params: {
  startUrl: string;
  allowedActions?: TaskRequest["safety"]["allowedActions"];
}): TaskRequest {
  return {
    schemaVersion: "1.24.0",
    taskId: "panel-attribution",
    objective: "Show Info was clicked.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "clicked_details_cta",
        type: "semantic_page_match",
        description: "Show Info was clicked.",
        required: true,
      },
      {
        id: "details_panel_visible",
        // Deliberately worded so the deterministic whole-page vocabulary-overlap score
        // (src/core/successEvaluator.ts's own DEFAULT_SEMANTIC_MIN_SCORE, 0.4) falls just
        // short even though the panel's own scoped headings ("Item Details"/"Panel Now
        // Visible") are the exact evidence involved -- so satisfaction here can only come
        // from the panel-causal path (RELEVANCE_ADOPT_THRESHOLD, 0.35), not the
        // pre-existing deterministic one. See this module's own token-coverage walkthrough.
        type: "semantic_page_match",
        description:
          "The item details panel is now visible after the Show Info control was clicked successfully by the visitor.",
        required: true,
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: {
      allowedActions: params.allowedActions ?? ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"],
    },
    outputSchemaVersion: "1.25.0",
  };
}

/** Clicks "Show Info" once, then always proposes stop_success -- never touches "Close". */
class ClickThenStopProvider implements ReasoningProvider {
  public contextsSeen: ReasoningContext[] = [];
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.contextsSeen.push(context);
    if (!this.clicked) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Show Info");
      assert.ok(trigger, "expected the trigger to be visible on the initial page");
      this.clicked = true;
      return { action: { type: "click", target: trigger!.id }, rationale: "Open the item details panel." };
    }
    return { action: { type: "stop_success" }, rationale: "Objective reached." };
  }
}

/** Clicks "Show Info", then immediately tries to click "Close" -- the item-3 guard's own target scenario. */
class ClickThenCloseProvider implements ReasoningProvider {
  public decisions: SelectedActionLike[] = [];
  private step = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.step += 1;
    if (this.step === 1) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Show Info");
      assert.ok(trigger);
      this.decisions.push({ type: "click", target: trigger!.id });
      return { action: { type: "click", target: trigger!.id }, rationale: "Open the item details panel." };
    }
    if (this.step === 2) {
      const closeControl = context.observation.interactiveElements.find((el) => el.accessibleName === "Close");
      if (closeControl) {
        this.decisions.push({ type: "click", target: closeControl.id });
        return { action: { type: "click", target: closeControl.id }, rationale: "Close what looks like an obstruction." };
      }
    }
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    if (requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id)) && context.allowedActions.includes("stop_success")) {
      this.decisions.push({ type: "stop_success" });
      return { action: { type: "stop_success" }, rationale: "Objective reached." };
    }
    this.decisions.push({ type: "wait" });
    return { action: { type: "wait" }, rationale: "Waiting." };
  }
}

interface SelectedActionLike {
  type: string;
  target?: string;
}

test("item 1/CORE COMPLETION RULE (a): the click-execution milestone completes from page-state + verified-action evidence, without needing panel content", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/panel.html` });
    const provider = new ClickThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    const clickMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "clicked_details_cta");
    assert.ok(clickMilestone, "expected the click-execution milestone to have satisfying evidence recorded");
    assert.notEqual(
      clickMilestone!.evidenceSource,
      "semantic_page_match:panel_causal",
      "the click-execution milestone must not need the panel-causal path -- page-state (title 'Item Page') " +
        "plus the verified click evidence is sufficient on its own",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("item 1/2/5: a causally-linked, non-ARIA panel opened by the milestone's own CTA satisfies the resulting-surface milestone from the same evidence transition, with panel-local evidence captured", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/panel.html` });
    const provider = new ClickThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.deepEqual(
      response.diagnostics.missingRequiredCriteriaIds ?? [],
      [],
      "both milestones must be satisfied for a real stop_success",
    );

    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "details_panel_visible");
    assert.ok(panelMilestone, "expected the resulting-surface milestone to have satisfying evidence recorded");
    assert.equal(panelMilestone!.evidenceSource, "semantic_page_match:panel_causal");

    // Item 5: both milestones were satisfied by the SAME step's evidence transition -- no
    // further click was needed merely to re-observe the already-open panel.
    const clickMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "clicked_details_cta");
    assert.ok(clickMilestone);
    assert.equal(
      clickMilestone!.stepIndex,
      panelMilestone!.stepIndex,
      "both milestones must be satisfied at the same step, chained from one evidence transition",
    );

    // The panel was never closed, and "Show Info" was never clicked twice.
    const clickActions = response.steps.filter((s) => s.selectedAction.type === "click");
    assert.equal(clickActions.length, 1, "the CTA must be clicked exactly once, and the panel's own Close control never clicked");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("item 3: the engine blocks an attempt to close a newly-opened, causally-linked, unverified panel as the immediate next action", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    // "wait" is deliberately in allowedActions so the guard has a safe redirect target to
    // substitute -- see loop.ts's close-guard implementation. panel-ambiguous.html
    // (deliberately never reaching the panel-causal relevance-adopt bar, and never
    // satisfying milestone 2 at all without a semanticVerifier) is used here specifically
    // so the surface is genuinely *not yet verified* when the close attempt happens --
    // panel.html's own fully-adopted panel gets verified in the very same step it opens
    // (item 5's chaining), which would legitimately permit closing it under the guard's
    // own override (a), and is covered by the previous test instead.
    const task = buildTask({ startUrl: `${baseUrl}/panel-ambiguous.html` });
    task.limits.maxSteps = 5;
    const provider = new ClickThenCloseProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(provider.decisions[1]!.type, "click", "the provider must have actually proposed the close click");
    const dispatchedActions = response.steps.map((s) => s.selectedAction);
    const closeWasDispatched = dispatchedActions.some(
      (a) => a.type === "click" && a.target === provider.decisions[1]!.target,
    );
    assert.equal(closeWasDispatched, false, "the guard must have substituted a safe action instead of dispatching the close click");

    const guardDiagnostic = response.captures?.errors?.find((e) => e.message.includes("Blocked an attempt to close"));
    assert.ok(guardDiagnostic, "expected the close-guard's own diagnostic to be recorded");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("item 1/4: an unrelated panel (structurally identical, no shared vocabulary) does not satisfy the milestone -- fail-closed", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/panel-unrelated.html`,
      // maxSteps is intentionally small: the run must fail closed, never hang trying to
      // satisfy an unsatisfiable milestone forever.
    });
    task.limits.maxSteps = 4;
    const provider = new ClickThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.notEqual(response.status, "success", "an unrelated panel must never satisfy the resulting-surface milestone");
    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "details_panel_visible");
    assert.equal(panelMilestone, undefined, "the unrelated panel must never be recorded as satisfying evidence");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("item 7 (surfaceAdoption diagnostics regression, not a bug): an in_document surface's own adoption diagnostic is recorded one step after its causing click, unchanged by the causal-attribution work", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/panel.html` });
    const provider = new ClickThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    const clickStepLog = response.steps.find((s) => s.selectedAction.type === "click");
    assert.ok(clickStepLog, "expected exactly one click step");
    const clickStep = clickStepLog!.stepIndex;
    const adoptionEvent = response.diagnostics?.surfaceAdoption?.attempts?.find((a) => a.event === "adopted");
    assert.ok(adoptionEvent, "expected an 'adopted' surfaceAdoption diagnostic for the in_document surface");
    assert.equal(
      adoptionEvent!.stepIndex,
      clickStep + 1,
      "surface-entry detection must still be recorded exactly one step after its causing click (by design, unchanged)",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
