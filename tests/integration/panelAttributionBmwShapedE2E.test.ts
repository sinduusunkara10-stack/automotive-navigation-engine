import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Panel-attribution corrective pass (see CLAUDE.md and the BMW-enquire-panel investigation):
 * an end-to-end replay of the originally-reported scenario's SHAPE (a vehicle model page, an
 * "Enquire"-style CTA opening a non-ARIA enquiry panel) using synthetic, placeholder content
 * -- no real dealer/OEM site, brand name, or proprietary content. This is deliberately kept
 * separate from tests/integration/panelAttribution.test.ts, whose fixtures and wording are
 * brand-neutral by design (per CLAUDE.md's non-negotiable rule) -- this file exists only to
 * prove the fix against the originally-reported failure shape; the mechanism itself (in
 * src/core, src/reasoning) has zero knowledge of vehicles, dealers, or this wording. See
 * panelAttributionGenericAcceptance.test.ts for the required, differently-worded acceptance
 * gate proving genericity.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/model.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          "<!doctype html><html><head><title>Model X Saloon</title></head><body>" +
            '<button type="button" id="enquire" style="position:absolute;top:0;left:0;">Enquire</button>' +
            "<script>" +
            "document.getElementById('enquire').addEventListener('click', function () {" +
            "  var d = document.createElement('div');" +
            "  d.id = 'enquiry-panel';" +
            "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;border-left:1px solid #ccc;';" +
            "  d.innerHTML = '<h2>Enquiry Form</h2><h3>Enquire Now About This Vehicle</h3>' +" +
            "    '<button type=\"button\" id=\"submit-enquiry\">Submit Enquiry</button>' +" +
            "    '<button type=\"button\" id=\"close-enquiry\">Close</button>';" +
            "  document.body.appendChild(d);" +
            "  document.getElementById('close-enquiry').addEventListener('click', function () { d.remove(); });" +
            "});" +
            "</script></body></html>",
        );
      return;
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

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.23.0",
    taskId: "panel-attribution-bmw-shaped",
    // Deliberately tuned (see tests/integration/panelAttribution.test.ts's own
    // token-coverage walkthrough) so milestone 1's deterministic score clears
    // DEFAULT_SEMANTIC_MIN_SCORE (0.4) from the CTA's own accessible name alone, while
    // milestone 2's deterministic whole-page score falls just short of 0.4 even though the
    // panel's own scoped headings are the exact evidence involved -- so milestone 2 can only
    // be satisfied via the panel-causal path (RELEVANCE_ADOPT_THRESHOLD, 0.35).
    objective: "Enquire clicked.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "enquire_clicked",
        type: "semantic_page_match",
        description: "Enquire clicked.",
        required: true,
      },
      {
        id: "enquiry_popup_seen",
        type: "semantic_page_match",
        description:
          "The enquiry form panel is now visible after the Enquire control was clicked by the visitor.",
        required: true,
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.24.0",
  };
}

class ClickEnquireThenStopProvider implements ReasoningProvider {
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Enquire");
      assert.ok(trigger, "expected the Enquire CTA on the initial page");
      this.clicked = true;
      return { action: { type: "click", target: trigger!.id }, rationale: "Enquire about this vehicle." };
    }
    return { action: { type: "stop_success" }, rationale: "Objective reached." };
  }
}

test("BMW-shaped E2E: Enquire click completes milestone N, the causally-linked enquiry panel completes milestone N+1 from the same evidence transition, the panel is never closed, Enquire is never clicked twice", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask(`${baseUrl}/model.html`);
    const provider = new ClickEnquireThenStopProvider();
    const response = await runTask({ page, task, reasoning: provider });

    assert.equal(response.status, "success");
    assert.deepEqual(response.diagnostics.missingRequiredCriteriaIds ?? [], []);

    const clickMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "enquire_clicked");
    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "enquiry_popup_seen");
    assert.ok(clickMilestone, "expected milestone N (Enquire clicked) to have satisfying evidence");
    assert.ok(panelMilestone, "expected milestone N+1 (enquiry popup seen) to have satisfying evidence");
    assert.equal(
      clickMilestone!.stepIndex,
      panelMilestone!.stepIndex,
      "both milestones must complete from the same evidence transition, no extra click needed",
    );

    const clickActions = response.steps.filter((s) => s.selectedAction.type === "click");
    assert.equal(clickActions.length, 1, "Enquire must be clicked exactly once, and the panel's own Close control never clicked");

    const activeSurfaceAtEnd = response.steps[response.steps.length - 1]?.observation.activeSurface;
    assert.equal(
      activeSurfaceAtEnd?.kind,
      "in_document",
      "the enquiry panel must still be open (not closed) at the end of the run",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
