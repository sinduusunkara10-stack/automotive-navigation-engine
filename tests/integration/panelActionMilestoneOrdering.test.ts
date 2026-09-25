import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type {
  SemanticCriterionVerifier,
  SemanticVerificationInput,
  SemanticVerificationOutcome,
} from "../../src/reasoning/semanticCriterionVerifier.js";

/**
 * Panel-relevance-veto corrective pass (see CLAUDE.md and the BMW post-PR61 live-run
 * investigation): the realistic lifecycle PR #61's own fixtures never exercised -- an
 * action-execution milestone ("X was clicked") and a resulting-surface milestone ("the
 * panel appeared") are ADJACENT required milestones, one verified click causes the panel,
 * and the panel *covers the clicked CTA* (so the CTA's own text drops out of the deterministic
 * page-signal pool once surface-scoped). The panel's own content has reject-tier vocabulary
 * overlap with the action milestone (it is a contact/enquiry form, not a restatement of "a
 * control was clicked") but adopt-tier overlap with the resulting-surface milestone. Before
 * this pass, `evaluateSemanticPageMatch` (src/core/successEvaluator.ts) hard-vetoed *any*
 * currently-eligible criterion the moment a reject-tier panel was present, never reaching the
 * semantic verifier at all -- so the action milestone could never fall back to
 * `lastActionEvidence`, exactly the BMW "Enquire" failure. Brand-neutral: no CTA name, panel
 * wording, or milestone description here reuses any BMW-specific text.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    // The trigger sits at top:40%/left:60% -- inside the region the right-hand panel will
    // render over once opened, so the trigger becomes `covered` (elementFromPoint) the
    // instant the panel appears, exactly like a real in-page enquiry panel that opens where
    // its own CTA was. This is the deliberate opposite of panelAttribution.test.ts's own
    // panel.html, which keeps its trigger apart from the panel on purpose.
    const triggerHtml =
      '<button type="button" id="trigger" ' +
      'style="position:absolute;top:40%;left:60%;">Request Info</button>';

    if (path === "/ordering-relevant.html") {
      return void page(
        "Item Page",
        triggerHtml +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:45%;background:#fff;';" +
          "  d.innerHTML = '<h2>Your Enquiry Panel</h2><h3>Your Contact Details</h3>' +" +
          "    '<button type=\"button\">First Name</button>' +" +
          "    '<button type=\"button\">Submit</button>' +" +
          "    '<button type=\"button\">Cancel</button>';" +
          "  document.body.appendChild(d);" +
          "});" +
          "</script>",
      );
    }

    if (path === "/ordering-unrelated.html") {
      // Structurally identical (same coverage/geometry), but the panel's own content
      // shares no vocabulary with either milestone -- a generic newsletter popup.
      return void page(
        "Item Page",
        triggerHtml +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:45%;background:#fff;';" +
          "  d.innerHTML = '<h2>Subscribe To Our Newsletter</h2>' +" +
          "    '<button type=\"button\">Sign Up</button>' +" +
          "    '<button type=\"button\">No Thanks</button>';" +
          "  document.body.appendChild(d);" +
          "});" +
          "</script>",
      );
    }

    if (path === "/ordering-weak-click.html") {
      // The click succeeds but produces no dialog/panel/navigation -- exactly the "weak"
      // success class ActionResult.verifiedSuccessType is never set for (see
      // milestoneEvidenceGate.test.ts's own uneventful-click.html), so lastActionEvidence
      // is never forwarded at all. No panel ever opens.
      return void page(
        "Item Page",
        triggerHtml +
          "<script>" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var p = document.createElement('p');" +
          "  p.textContent = 'Noted';" +
          "  document.body.appendChild(p);" +
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

const OBJECTIVE = "Complete the item journey.";
const ACTION_MILESTONE_DESCRIPTION = "The primary control was activated on the item page.";
const SURFACE_MILESTONE_DESCRIPTION = "Your enquiry panel with your own contact details is now clearly visible.";

function buildTask(params: { startUrl: string; maxSteps?: number }): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "panel-action-milestone-ordering",
    objective: OBJECTIVE,
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "action_activated", type: "semantic_page_match", description: ACTION_MILESTONE_DESCRIPTION, required: true },
      { id: "panel_visible", type: "semantic_page_match", description: SURFACE_MILESTONE_DESCRIPTION, required: true },
    ],
    // cta_clicks is required for loop.ts to ever forward a click's own details as
    // lastActionEvidence to the verifier at all (see loop.ts's wantsCtaClickCapture gate) --
    // without it, the action milestone could never reach the fixed fallback regardless of
    // this pass's correction.
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: params.maxSteps ?? 4, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

/**
 * A criterion-aware test double, not a blanket stub: it reads `criterionDescription` to
 * decide which evidence class is actually relevant to *this* criterion -- exactly the
 * distinction the real verifier's own system prompt (semanticCriterionVerifier.ts's
 * buildPrompt) asks the model to draw, now that a reject-tier panel no longer pre-empts the
 * call. This is what makes the test exercise the real, previously-broken branch: before this
 * pass, `verify()` was never reached at all for the action milestone when a reject-tier panel
 * was present, so `calls` below would have stayed empty for it.
 */
function criterionAwareFakeVerifier(): SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } {
  const calls: SemanticVerificationInput[] = [];
  return {
    calls,
    async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
      calls.push(input);
      if (input.criterionDescription === SURFACE_MILESTONE_DESCRIPTION) {
        const p = input.panelEvidence;
        const confirmed = p !== undefined && p.causallyLinked && p.documentUsable && p.relevanceTier === "adopt";
        return confirmed
          ? { satisfied: true, confidence: 0.9, evidence: `Causally-linked panel "${p!.identity}" is present and relevant.` }
          : {
              satisfied: false,
              confidence: 0.2,
              evidence: `No causally-linked, adopt-tier panel evidence supports this resulting-surface milestone (tier: ${
                p?.relevanceTier ?? "none"
              }).`,
            };
      }
      if (input.criterionDescription === ACTION_MILESTONE_DESCRIPTION) {
        return input.lastActionEvidence !== undefined
          ? {
              satisfied: true,
              confidence: 0.85,
              evidence: `Verified click on "${input.lastActionEvidence.accessibleName ?? input.lastActionEvidence.ctaText}" matches the criterion, independent of any unrelated panel's own relevance tier.`,
            }
          : { satisfied: false, confidence: 0.2, evidence: "No verified action evidence was supplied for this criterion." };
      }
      return { satisfied: false, confidence: 0, evidence: "Unrecognised criterion." };
    },
  };
}

/** Clicks "Request Info" once, then always proposes stop_success. */
class ClickRequestInfoThenStopProvider implements ReasoningProvider {
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Request Info");
      assert.ok(trigger, "expected the Request Info trigger to be visible on the initial page");
      this.clicked = true;
      return { action: { type: "click", target: trigger!.id }, rationale: "Request info about this item." };
    }
    return { action: { type: "stop_success" }, rationale: "Objective reached." };
  }
}

test("adjacent action + resulting-surface milestones both complete authoritatively from one click, in order", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/ordering-relevant.html` });
    const verifier = criterionAwareFakeVerifier();
    const response = await runTask({ page, task, reasoning: new ClickRequestInfoThenStopProvider(), semanticVerifier: verifier });

    assert.equal(response.status, "success", "both milestones must have completed for a real stop_success");
    assert.deepEqual(response.diagnostics.missingRequiredCriteriaIds ?? [], []);

    const actionMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "action_activated");
    const surfaceMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "panel_visible");
    assert.ok(actionMilestone, "the action milestone must have satisfying evidence recorded");
    assert.ok(surfaceMilestone, "the resulting-surface milestone must have satisfying evidence recorded");

    // The action milestone must have been resolved via the verifier + lastActionEvidence,
    // never via the panel's own (reject-tier, for this milestone) content.
    assert.equal(actionMilestone!.evidenceSource, "semantic_page_match:verifier");
    // The resulting-surface milestone must have been resolved via the pre-existing
    // panel-causal path, unchanged by this pass.
    assert.equal(surfaceMilestone!.evidenceSource, "semantic_page_match:panel_causal");

    // Item 5 (unchanged): both milestones satisfied at the same step, one evidence transition.
    assert.equal(actionMilestone!.stepIndex, surfaceMilestone!.stepIndex);

    // The previously-broken gate: the verifier must actually have been consulted for the
    // action milestone, with lastActionEvidence present and a reject-tier panelEvidence
    // forwarded alongside it (proving the reject tier no longer pre-empted the call).
    // The first call for this criterion is the pre-click pre_action check (no click has
    // happened yet, so naturally no lastActionEvidence); the one that actually satisfied it
    // is the post-click call carrying both the verified click and the reject-tier panel.
    const actionCallWithEvidence = verifier.calls.find(
      (c) => c.criterionDescription === ACTION_MILESTONE_DESCRIPTION && c.lastActionEvidence !== undefined,
    );
    assert.ok(actionCallWithEvidence, "the verifier must have been consulted with lastActionEvidence for the action milestone");
    assert.equal(actionCallWithEvidence!.panelEvidence?.relevanceTier, "reject");

    // The CTA was clicked exactly once, and the panel was never closed.
    const clickActions = response.steps.filter((s) => s.selectedAction.type === "click");
    assert.equal(clickActions.length, 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("negative: an unrelated panel still satisfies the action milestone from verified-action evidence alone, but never the resulting-surface milestone", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/ordering-unrelated.html` });
    const verifier = criterionAwareFakeVerifier();
    const response = await runTask({ page, task, reasoning: new ClickRequestInfoThenStopProvider(), semanticVerifier: verifier });

    assert.notEqual(response.status, "success", "the resulting-surface milestone must never be satisfied by an unrelated panel");
    assert.ok(
      response.diagnostics.missingRequiredCriteriaIds?.includes("panel_visible"),
      "panel_visible must remain a missing required criterion",
    );
    assert.ok(
      !(response.engineAssessment.satisfiedSuccessCriteriaIds ?? []).includes("panel_visible"),
      "the unrelated panel must never be recorded as satisfying the resulting-surface milestone",
    );

    const actionMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "action_activated");
    assert.ok(actionMilestone, "the action milestone must still complete from the verified click alone, unaffected by the unrelated panel");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("negative: an unverified (weak-success) click never satisfies the action milestone, and stop_success stays rejected", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/ordering-weak-click.html` });
    const verifier = criterionAwareFakeVerifier();
    const response = await runTask({ page, task, reasoning: new ClickRequestInfoThenStopProvider(), semanticVerifier: verifier });

    assert.notEqual(response.status, "success");
    assert.ok(response.diagnostics.missingRequiredCriteriaIds?.includes("action_activated"));
    assert.ok(
      verifier.calls
        .filter((c) => c.criterionDescription === ACTION_MILESTONE_DESCRIPTION)
        .every((c) => c.lastActionEvidence === undefined),
      "an unverified click's own details must never reach the verifier as lastActionEvidence",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
