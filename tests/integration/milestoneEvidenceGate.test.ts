import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type {
  SemanticCriterionVerifier,
  SemanticVerificationInput,
  SemanticVerificationOutcome,
} from "../../src/reasoning/semanticCriterionVerifier.js";

/**
 * BMW live-site corrective work (2026-09-21, see the BMW-run investigation memo, Correction
 * B in src/core/loop.ts, and ActionResult.verifiedSuccessType's own doc comment in
 * src/types/task-response.ts): engine-level regression coverage that
 * core/loop.ts -- not just src/core/successEvaluator.ts's own, already-tested forwarding
 * mechanism -- only ever forwards a click's own LastActionEvidence to the semantic
 * milestone verifier when that click's success was established via one of the fixed,
 * directly-observed evidence classes (ActionResult.verifiedSuccessType present). This is
 * the actual BMW defect: a click reporting `success: true` on weak, uncorroborated
 * evidence alone used to let its own declared destination/ctaText corroborate a milestone
 * the live page evidence never actually supported. Nothing here is brand/site-specific --
 * every route is synthetic, served from 127.0.0.1 on an ephemeral port.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/uneventful-click.html") {
      // A plain click that dispatches cleanly, produces no dialog and no co-occurring
      // multi-control panel -- ActionResult.success is true (an ordinary, uneventful
      // click), but verifiedSuccessType is absent: exactly the class of "weak" success the
      // BMW investigation found being used to satisfy a milestone it should never have been
      // able to satisfy.
      return void page(
        "Search results",
        '<button type="button" id="trigger">View details</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var p = document.createElement('p');" +
          "  p.textContent = 'Selected';" +
          "  document.body.appendChild(p);" +
          "});" +
          "</script>",
      );
    }

    if (path === "/dialog-click.html") {
      // A genuine, standards-based dialog signal -- verifiedSuccessType "dialog" -- must
      // still let LastActionEvidence corroborate a milestone, exactly as before this
      // correction (no regression).
      return void page(
        "Search results",
        '<button type="button" id="trigger">View details</button>' +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.setAttribute('role', 'dialog');" +
          "  d.setAttribute('aria-modal', 'true');" +
          "  d.innerHTML = '<h2>Details</h2><button type=\"button\">Close</button>';" +
          "  document.body.appendChild(d);" +
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

/**
 * Reproduces exactly the BMW run's own shape: page evidence (title/headings/interactive
 * text) never itself describes the target state -- only the clicked element's own declared
 * details (LastActionEvidence) would claim it, if forwarded. Records every call so a test
 * can assert both the outcome and whether/how it was actually invoked.
 */
function evidenceTrustingFakeVerifier(): SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } {
  const calls: SemanticVerificationInput[] = [];
  return {
    calls,
    async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
      calls.push(input);
      const hasLastActionEvidence = input.lastActionEvidence !== undefined;
      return {
        satisfied: hasLastActionEvidence,
        confidence: hasLastActionEvidence ? 0.95 : 0.1,
        evidence: hasLastActionEvidence
          ? `Trusting the last clicked control's own declared details: ${JSON.stringify(input.lastActionEvidence)}`
          : "No corroborating last-action evidence was supplied; the page evidence alone does not describe the target state.",
      };
    },
  };
}

/** Clicks the named control once, then stops (success once satisfied, else failure). */
class ClickOnceProvider implements ReasoningProvider {
  private alreadyClicked = false;
  constructor(private readonly targetName: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    if (!this.alreadyClicked) {
      const candidate = context.observation.interactiveElements.find((el) => el.accessibleName === this.targetName);
      if (candidate && context.allowedActions.includes("click")) {
        this.alreadyClicked = true;
        return { action: { type: "click", target: candidate.id }, rationale: `Click "${candidate.accessibleName}".` };
      }
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "No further candidates; the target state was never confirmed." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function buildTask(params: { startUrl: string }): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "milestone-evidence-gate",
    objective: "Confirm receipt of a dealership callback request.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "callback-confirmed",
        type: "semantic_page_match",
        description: "A callback confirmation state has been reached.",
        // Forces the deterministic lexical path to always fall short, so the fake
        // semanticVerifier above is always consulted -- this test is about the
        // lastActionEvidence-forwarding gate, not deterministic scoring.
        config: { minScore: 0.99 },
      },
    ],
    captureModules: ["cta_clicks", "errors"],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 2 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

// Regression test 4 (BMW investigation report, the milestone-evidence gate itself): a click
// whose success is only "weak" (no verifiedSuccessType -- an uneventful click with no
// dialog/panel corroboration) must never let its own LastActionEvidence corroborate a
// semantic_page_match milestone the live page evidence does not itself support.
test("REGRESSION 4: an uncorroborated click's own details never satisfy a milestone via lastActionEvidence", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/uneventful-click.html` });
    const verifier = evidenceTrustingFakeVerifier();
    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceProvider("View details"),
      semanticVerifier: verifier,
    });

    assert.equal(response.status, "failure", "the milestone must never have been satisfied by the weak click's own evidence");
    assert.ok(
      !response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("callback-confirmed"),
      "callback-confirmed must not be in the satisfied set",
    );
    assert.ok(verifier.calls.length >= 1, "the semantic verifier must have been consulted (the deterministic path always falls short)");
    assert.ok(
      verifier.calls.every((c) => c.lastActionEvidence === undefined),
      "the click's own details must never have reached the semantic verifier, since verifiedSuccessType was never set for this click",
    );

    // Confirms the evidence class that produced this: the one dispatched click succeeded
    // (an ordinary, uneventful click), but carried no verifiedSuccessType -- the exact
    // "weak success" class this whole correction is about.
    const clickStep = response.steps.find((s) => s.selectedAction.type === "click");
    assert.ok(clickStep, "expected exactly one click step");
    assert.equal(clickStep?.actionResult.success, true, "the click itself did succeed");
    assert.equal(
      clickStep?.actionResult.verifiedSuccessType,
      undefined,
      "and it is exactly this absence of verifiedSuccessType that must have suppressed lastActionEvidence forwarding",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// Regression test 5 (BMW investigation report, gate preserved / no regression): a click
// whose success is genuinely corroborated (a real dialog -- verifiedSuccessType "dialog")
// must still let its own LastActionEvidence corroborate an otherwise-unsatisfiable
// milestone, exactly as before this correction.
test("REGRESSION 5 (no regression): a genuinely corroborated click's own details still satisfy a milestone via lastActionEvidence", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/dialog-click.html` });
    const verifier = evidenceTrustingFakeVerifier();
    const response = await runTask({
      page,
      task,
      reasoning: new ClickOnceProvider("View details"),
      semanticVerifier: verifier,
    });

    assert.equal(response.status, "success");
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("callback-confirmed"));
    assert.ok(
      verifier.calls.some((c) => c.lastActionEvidence !== undefined),
      "the click's own details must have reached the semantic verifier once corroborated by the genuine dialog signal",
    );

    const clickStep = response.steps.find((s) => s.selectedAction.type === "click");
    assert.equal(clickStep?.actionResult.success, true);
    assert.equal(
      clickStep?.actionResult.verifiedSuccessType,
      "dialog",
      "confirms this ran through the corroborated-evidence class, not the weak one -- which is exactly what allowed forwarding",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
