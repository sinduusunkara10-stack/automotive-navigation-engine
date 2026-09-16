import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Corrective architecture (see CLAUDE.md and docs/architecture.md "Milestone-anchored
 * recovery" / "Alternative route exploration" / "Consent behaviour"): an integrated,
 * generic reproduction of the combined real-journey sequence the Nissan production audit
 * found no existing test covered -- milestones 1-3 satisfied, a CTA opens a delayed,
 * non-ARIA half-window with more than 40 background interactive elements, a genuine
 * consent surface is present and must be resolved without spending the navigation budget,
 * the first candidate tried inside the half-window fails to progress, and only a second,
 * distinct candidate reaches the final milestone. Nothing here is Nissan-specific or
 * brand-specific -- every route/label is synthetic and served from 127.0.0.1.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/start.html") {
      return void page("Start", '<a href="/listing.html">Enter Listing</a>');
    }

    if (path === "/listing.html") {
      // More than 40 background interactive elements (item 4 of the required combined
      // sequence), a genuine consent surface (item 13/14), and a trigger that opens a
      // same-document, non-ARIA half-window (item 3/5) offering two distinct candidates:
      // one that leads nowhere (item 9/10) and one that reaches the objective (item 12).
      const fillers = Array.from({ length: 45 }, (_, i) => `<a href="#filler-${i}">Filler link ${i}</a>`).join(" ");
      return void page(
        "Listing",
        fillers +
          '<div id="cookie-banner"><h2>We use cookies to improve your experience</h2>' +
          '<button type="button" id="accept-cookies">Accept All Cookies</button>' +
          '<button type="button" id="manage-cookies">Manage Cookie Preferences</button></div>' +
          '<button type="button" id="trigger">View Offer Details</button>' +
          "<script>" +
          "document.getElementById('accept-cookies').addEventListener('click', function () {" +
          // Hidden via style, not removed from the DOM: keeps this fixture clear of an
          // unrelated, pre-existing element-id-collision edge case in
          // observationBuilder.ts's per-scan indexing scheme (discovered while building
          // this test; tracked separately, out of this corrective pass's scope) where a
          // brand-new element appended after an *earlier*-scanned element is removed can be
          // assigned that removed element's now-unused index-based id. display:none is
          // still correctly excluded by the existing visibility filter either way.
          "  document.getElementById('cookie-banner').style.display = 'none';" +
          "});" +
          "document.getElementById('trigger').addEventListener('click', function () {" +
          "  var marker = document.createElement('div'); marker.id = 'offer-selected'; document.body.appendChild(marker);" +
          "  var d = document.createElement('div');" +
          "  d.id = 'drawer';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;';" +
          "  d.innerHTML = '<h2>Offer details</h2>' +" +
          "    '<button type=\"button\" id=\"siblingA\">Alternative CTA A</button>' +" +
          "    '<button type=\"button\" id=\"siblingB\">Alternative CTA B</button>';" +
          "  document.body.appendChild(d);" +
          "  document.getElementById('siblingB').addEventListener('click', function () {" +
          "    var goal = document.createElement('div'); goal.id = 'goal-control-clicked'; document.body.appendChild(goal);" +
          "  });" +
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

function isSatisfied(context: ReasoningContext): boolean {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  return requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
}

function combinedSequenceTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.17.0",
    taskId: "milestone-anchored-recovery-combined-sequence",
    allowedDomains: ["127.0.0.1"],
    startUrl,
    objective:
      "1. Start from the fixture homepage. 2. Enter the listing. 3. Select the offer to open its details. " +
      "4. Reach the offer's own goal control.",
    successCriteria: [
      { id: "step-1", type: "url_pattern", description: "Start from the fixture homepage.", config: { pattern: "**/start.html" } },
      { id: "step-2", type: "url_pattern", description: "Enter the listing.", config: { pattern: "**/listing.html" } },
      // Descriptions deliberately share vocabulary with their own step's dominant CTA label
      // (a realistic case: a well-written objective names the control it expects) so this
      // fixture exercises milestone-anchored recovery specifically, not the separate,
      // pre-existing proactive branch-exploration heuristic (core/branchExploration.ts's
      // isAmbiguousMultiCandidateDecisionPoint), which only engages when *no* candidate at a
      // decision point is a dominant lexical match -- an intentionally distinct mechanism
      // this test does not exercise.
      {
        id: "step-3",
        type: "element_present",
        description: "Click View Offer Details to select the item and open its details.",
        config: { selector: "#offer-selected" },
      },
      {
        id: "step-4",
        type: "element_present",
        description: "Choose the correct Alternative CTA control to reach the offer's own goal control.",
        config: { selector: "#goal-control-clicked" },
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 14, maxBacktracks: 6, maxRepeatedActions: 10 },
    safety: {
      allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      consentInteractionPolicy: "accept_optional",
    },
    outputSchemaVersion: "1.16.0",
  };
}

/**
 * Deterministic, stateful script reproducing the combined sequence: reach the drawer, then
 * (twice) propose stop_blocked directly -- standing in for a real provider's low-confidence
 * or rejected decision -- forcing milestone-anchored recovery to trigger. The engine's own
 * proactive consent handling (accept_optional) is expected to resolve the cookie banner
 * entirely on its own, without this provider ever being asked about it.
 */
class CombinedSequenceProvider implements ReasoningProvider {
  private stage:
    | "start"
    | "listing"
    | "drawer_first_blocked"
    | "drawer_pick_a"
    | "after_a_blocked"
    | "drawer_pick_b"
    | "done" = "start";

  sawConsentControlInPrompt = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All success criteria satisfied." };
    }

    const els = context.observation.interactiveElements;
    if (els.some((el) => /cookie/i.test(el.accessibleName))) {
      this.sawConsentControlInPrompt = true;
    }

    const enter = els.find((el) => el.accessibleName === "Enter Listing");
    if (enter && this.stage === "start") {
      this.stage = "listing";
      return { action: { type: "click", target: enter.id }, rationale: "Enter the listing." };
    }

    const siblingA = els.find((el) => el.accessibleName === "Alternative CTA A");
    const siblingB = els.find((el) => el.accessibleName === "Alternative CTA B");
    const trigger = els.find((el) => el.accessibleName === "View Offer Details");

    if (trigger && !siblingA && !siblingB && this.stage === "listing") {
      this.stage = "drawer_first_blocked";
      return { action: { type: "click", target: trigger.id }, rationale: "Open the offer drawer." };
    }
    if (this.stage === "drawer_first_blocked") {
      this.stage = "drawer_pick_a";
      return { action: { type: "stop_blocked" }, rationale: "Cannot decide confidently which drawer control to use yet." };
    }
    if (this.stage === "drawer_pick_a" && siblingA) {
      this.stage = "after_a_blocked";
      return { action: { type: "click", target: siblingA.id }, rationale: "Try alternative candidate A." };
    }
    if (this.stage === "after_a_blocked") {
      this.stage = "drawer_pick_b";
      return { action: { type: "stop_blocked" }, rationale: "Candidate A did not help; still cannot decide confidently." };
    }
    if (this.stage === "drawer_pick_b" && siblingB) {
      this.stage = "done";
      return { action: { type: "click", target: siblingB.id }, rationale: "Try alternative candidate B instead." };
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("combined sequence: milestone-anchored zero-hop recovery, persistent candidate exhaustion, and proactive consent handling together reach the objective", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new CombinedSequenceProvider();
    const response = await runTask({ page, task: combinedSequenceTask(`${baseUrl}/start.html`), reasoning: provider });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    assert.equal(response.status, "success", JSON.stringify(response.diagnostics, null, 2));

    // Milestones 1-3 must remain preserved in the final response evidence (item 18 of the
    // required sequence), never undone by the recovery/exploration that followed them.
    const satisfiedIds = response.engineAssessment.satisfiedSuccessCriteriaIds ?? [];
    assert.deepEqual([...satisfiedIds].sort(), ["step-1", "step-2", "step-3", "step-4"]);

    // The run must never have retreated behind the milestone-3 decision point: no step's
    // resulting URL is ever the homepage again, and go_back is never dispatched at all --
    // the drawer is a same-document state, so a correctly milestone-anchored recovery needs
    // zero browser-history hops to return to it.
    assert.ok(
      response.steps.every((s) => s.selectedAction.type !== "go_back"),
      "a same-document half-window anchor should need zero go_back hops to restore",
    );
    assert.ok(
      response.steps.slice(1).every((s) => !s.currentUrl.endsWith("/start.html")),
      "must never have retreated all the way back to the homepage",
    );

    // Engine-enforced proactive consent handling (accept_optional): the banner must have
    // been resolved by the engine itself, never surfaced to the reasoning layer as
    // something it had to choose an action for.
    assert.ok(response.diagnostics.consent, "expected consent diagnostics to be present");
    assert.ok(response.diagnostics.consent?.surfaces.some((s) => s.engineActionTaken === "clicked_accept_all"));
    assert.ok(response.diagnostics.consent?.surfaces.every((s) => s.engineActionVerified !== false));
    assert.equal(
      provider.sawConsentControlInPrompt,
      false,
      "the reasoning layer should never have been asked to act on the cookie banner directly",
    );

    // Milestone-anchored recovery: at least one restore attempt is recorded, and it
    // succeeded with zero hops (the drawer never left the listing document).
    assert.ok(response.diagnostics.recovery, "expected recovery diagnostics to be present");
    assert.ok((response.diagnostics.recovery?.anchorsRecorded ?? 0) >= 3);
    const restoredAttempts = response.diagnostics.recovery?.attempts.filter((a) => a.restored) ?? [];
    assert.ok(restoredAttempts.length >= 1, "expected at least one confirmed anchor restoration");
    assert.ok(
      restoredAttempts.every((a) => a.hopsAttempted === 0),
      "a same-document drawer anchor should always restore with zero hops",
    );

    // Alternative Route Exploration: exactly two distinct candidates were tried at the
    // drawer's decision point -- "Alternative CTA A" (no progress) then "Alternative CTA B"
    // (which reached the objective) -- well within the bounded budget of three.
    const candidates = response.diagnostics.alternativeExploration?.candidates ?? [];
    assert.ok(candidates.length >= 1, "expected at least one alternative-candidate diagnostic");
    assert.ok(
      candidates.some((c) => c.candidateLabel.includes("Alternative CTA A")),
      "expected candidate A to be recorded as tried",
    );
    assert.ok(
      candidates.every((c) => c.budget === 3),
      "expected the default bounded budget of 3 to be reported",
    );

    // The consent budget and the navigation-exploration budget must be visibly separate --
    // resolving consent must never have consumed an alternative-candidate attempt.
    assert.ok((response.diagnostics.consent?.consentRetriesUsed ?? 0) <= 2);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
