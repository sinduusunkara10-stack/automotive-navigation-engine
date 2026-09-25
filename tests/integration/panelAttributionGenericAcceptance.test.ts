import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Required acceptance gate (see CLAUDE.md and the BMW-enquire-panel investigation §13-14):
 * a SECOND, differently-worded, brand-neutral end-to-end fixture proving the panel-attribution
 * mechanism is genuinely generic -- not merely tuned to pass the BMW-shaped fixture in
 * panelAttributionBmwShapedE2E.test.ts, nor a restatement of the original mechanism tests in
 * panelAttribution.test.ts. Every label, heading, and milestone description here is
 * deliberately different from both of those files: CTA "Request Info" (not "Show Info" or
 * "Enquire"), panel headings "Product Info Panel" / "Now Open For Browsing" (not "Item
 * Details" / "Panel Now Visible" or "Enquiry Form" / "Enquire Now About This Vehicle"), and
 * milestone wording built around "activated"/"visible" rather than "clicked"/"seen". The
 * underlying mechanism exercised is identical (src/core/panelEvidence.ts, the causal-identity
 * plumbing in src/core/state.ts and src/core/loop.ts, and the panel-causal satisfaction path
 * in src/core/successEvaluator.ts) -- there is no fixture-specific branch anywhere in that
 * code, only generic structural/relevance evidence.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/catalogue.html") {
      return void page(
        "Catalogue Item",
        '<button type="button" id="request-info" style="position:absolute;top:0;left:0;">Request Info</button>' +
          "<script>" +
          "document.getElementById('request-info').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'info-panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Product Info Panel</h2><h3>Now Open For Browsing</h3>' +" +
          "    '<button type=\"button\" id=\"learn-more\">Learn More</button>' +" +
          "    '<button type=\"button\" id=\"dismiss-panel\">Dismiss</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('dismiss-panel').addEventListener('click', function () { d.remove(); });" +
          "});" +
          "</script>",
      );
    }

    if (path === "/catalogue-unrelated.html") {
      // Same structural/coverage shape, but its own scoped content shares no vocabulary
      // with the objective/criteria below -- a generic cookie-consent-style panel,
      // deliberately unrelated (and worded nothing like panel-unrelated.html's newsletter
      // content in panelAttribution.test.ts).
      return void page(
        "Catalogue Item",
        '<button type="button" id="request-info" style="position:absolute;top:0;left:0;">Request Info</button>' +
          "<script>" +
          "document.getElementById('request-info').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'info-panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
          "  d.innerHTML = '<h2>Manage Cookie Preferences</h2>' +" +
          "    '<button type=\"button\" id=\"accept-all\">Accept All</button>' +" +
          "    '<button type=\"button\" id=\"dismiss-panel\">Reject All</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('dismiss-panel').addEventListener('click', function () { d.remove(); });" +
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

// Deliberately tuned (same token-coverage approach as the other two panel-attribution test
// files, deliberately different wording): milestone 1's deterministic score clears
// DEFAULT_SEMANTIC_MIN_SCORE (0.4) from the CTA's own accessible name alone ("Request Info"
// appearing twice in the joined objective+criterion text against the page's own "Request
// Info" button); milestone 2's deterministic whole-page score (~0.357) falls just short of
// 0.4 even though the panel's own scoped headings are the exact evidence involved, while its
// panel-scoped relevance score (the same ~0.357, since headings are the only source of
// heading text on this page) clears RELEVANCE_ADOPT_THRESHOLD (0.35) -- so milestone 2 can
// only be satisfied via the panel-causal path, never the pre-existing deterministic one.
function buildTask(params: {
  startUrl: string;
  allowedActions?: TaskRequest["safety"]["allowedActions"];
}): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "panel-attribution-generic-acceptance",
    objective: "Request Info activated.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "request_info_activated",
        type: "semantic_page_match",
        description: "Request Info activated.",
        required: true,
      },
      {
        id: "info_panel_open",
        type: "semantic_page_match",
        description:
          "The product info panel is now open and clearly shown after the Request Info control was activated successfully by the visitor.",
        required: true,
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: {
      allowedActions: params.allowedActions ?? ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"],
    },
    outputSchemaVersion: "1.27.0",
  };
}

/** Activates "Request Info" once, then always proposes stop_success -- never touches "Dismiss", never repeats the CTA. */
class ActivateThenStopProvider implements ReasoningProvider {
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Request Info");
      assert.ok(trigger, "expected the Request Info CTA on the initial page");
      this.clicked = true;
      return { action: { type: "click", target: trigger!.id }, rationale: "Request more information about this item." };
    }
    return { action: { type: "stop_success" }, rationale: "Objective reached." };
  }
}

test("generic acceptance gate: a differently-worded action-to-panel journey completes both milestones from one evidence transition, through the identical generic mechanism, with no fixture-specific code", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/catalogue.html` });
    const provider = new ActivateThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.deepEqual(
      response.diagnostics.missingRequiredCriteriaIds ?? [],
      [],
      "both milestones must be satisfied for a real stop_success -- the run must stop only via the mechanical gate",
    );

    const clickMilestone = response.diagnostics?.milestoneEvidence?.find(
      (m) => m.criterionId === "request_info_activated",
    );
    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "info_panel_open");
    assert.ok(clickMilestone, "expected milestone 1 (Request Info activated) to have satisfying evidence");
    assert.ok(panelMilestone, "expected milestone 2 (info panel open) to have satisfying evidence");
    assert.notEqual(
      clickMilestone!.evidenceSource,
      "semantic_page_match:panel_causal",
      "the action-execution milestone must not need the panel-causal path",
    );
    assert.equal(
      panelMilestone!.evidenceSource,
      "semantic_page_match:panel_causal",
      "the resulting-surface milestone must be satisfied via the generic panel-causal path",
    );
    assert.equal(
      clickMilestone!.stepIndex,
      panelMilestone!.stepIndex,
      "both milestones must complete from the same evidence transition, no extra click needed",
    );

    const clickActions = response.steps.filter((s) => s.selectedAction.type === "click");
    assert.equal(
      clickActions.length,
      1,
      "Request Info must be activated exactly once, never repeated, and the panel's own Dismiss control never clicked",
    );

    const activeSurfaceAtEnd = response.steps[response.steps.length - 1]?.observation.activeSurface;
    assert.equal(
      activeSurfaceAtEnd?.kind,
      "in_document",
      "the info panel must still be open (preserved, not closed) at the end of the run",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("generic acceptance gate: an unrelated panel (structurally identical, no shared vocabulary, different wording than the other fixtures) fails closed", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/catalogue-unrelated.html` });
    task.limits.maxSteps = 4;
    const provider = new ActivateThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.notEqual(response.status, "success", "an unrelated panel must never satisfy the resulting-surface milestone");
    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "info_panel_open");
    assert.equal(panelMilestone, undefined, "the unrelated panel must never be recorded as satisfying evidence");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
