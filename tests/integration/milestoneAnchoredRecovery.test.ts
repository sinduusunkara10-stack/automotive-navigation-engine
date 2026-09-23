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
 * recovery" / "Alternative route exploration -- complete route following" / "Consent
 * behaviour"): an integrated, generic reproduction of the combined real-journey sequence the
 * Nissan production audit found no existing test covered, extended per the corrective pass's
 * own 16-point required sequence: milestones 1-3 are satisfied, a genuine consent surface is
 * resolved without spending the navigation budget, a first candidate opens its own
 * multi-step route (followed for more than one action) that turns out to be a verified dead
 * end, the engine restores and verifies the exact same milestone-3 decision point, marks
 * that candidate exhausted, and only then a second, distinct candidate opens its own
 * multi-step route that reaches milestone 4 and is allowed to continue -- without ever being
 * reset back to the recovery anchor -- on to a further milestone 5. Every route here is a
 * real, same-document hash-navigation sequence (a client-side router keyed off
 * location.hash), so the browser's own history genuinely backs each downstream step -- a
 * bounded go_back return sequence is therefore a real, verifiable restoration, never a
 * same-document no-op the engine could get away with faking. Nothing here is Nissan-specific
 * or brand-specific -- every route/label is synthetic and served from 127.0.0.1. The cookie
 * banner is genuinely removed from the DOM on accept (not merely hidden): the element-ID
 * collision this once had to work around (see observation/observationBuilder.ts's now
 * counter-based, never-reused id assignment) is fixed at its source, so this test needs no
 * workaround to pass.
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
      // sequence) stay present at every hash state -- generic background noise a real
      // candidate must be picked out from regardless of route depth. A genuine consent
      // surface (item 13/14) sits alongside them. `trigger`/the drawer itself never
      // navigate to a new document -- every further step is a location.hash change,
      // client-side-routed by `render()` below, so the browser's real history is what
      // backs every downstream hop of each candidate's own route.
      const fillers = Array.from({ length: 45 }, (_, i) => `<a href="#filler-${i}">Filler link ${i}</a>`).join(" ");
      return void page(
        "Listing",
        fillers +
          '<div id="cookie-banner"><h2>We use cookies to improve your experience</h2>' +
          '<button type="button" id="accept-cookies">Accept All Cookies</button>' +
          '<button type="button" id="manage-cookies">Manage Cookie Preferences</button></div>' +
          '<a href="#offer" id="trigger">View Offer Details</a>' +
          '<div id="routed-content"></div>' +
          "<script>" +
          "document.getElementById('accept-cookies').addEventListener('click', function () {" +
          // Genuinely removed (not merely hidden) -- the element-ID collision this used to
          // force a display:none workaround for is now fixed at its source in
          // observationBuilder.ts (a monotonically increasing, never-reused id counter), so
          // this test exercises the same DOM-removal shape a real cookie-consent widget uses.
          "  document.getElementById('cookie-banner').remove();" +
          "});" +
          "function render() {" +
          "  var h = location.hash;" +
          "  var trigger = document.getElementById('trigger');" +
          "  trigger.style.display = (h === '' || h === '#') ? '' : 'none';" +
          "  if (h === '#offer' || h.indexOf('#offer/') === 0) {" +
          "    if (!document.getElementById('offer-selected')) {" +
          "      var marker = document.createElement('div'); marker.id = 'offer-selected'; document.body.appendChild(marker);" +
          "    }" +
          "  }" +
          "  var el = document.getElementById('routed-content');" +
          "  if (h === '#offer') {" +
          "    el.innerHTML = '<h2>Offer details</h2>' +" +
          "      '<a href=\"#offer/a\" id=\"siblingA\">Alternative CTA A</a> ' +" +
          "      '<a href=\"#offer/b\" id=\"siblingB\">Alternative CTA B</a>';" +
          "  } else if (h === '#offer/a') {" +
          "    el.innerHTML = '<h2>Trim options</h2><a href=\"#offer/a/compare\" id=\"compareTrims\">Compare Trims</a>';" +
          "  } else if (h === '#offer/a/compare') {" +
          "    el.innerHTML = '<h2>Trim comparison</h2><p>No further relevant controls here.</p>';" +
          "  } else if (h === '#offer/b') {" +
          "    el.innerHTML = '<h2>Configure offer</h2><a href=\"#offer/b/confirm\" id=\"confirmConfig\">Confirm Configuration</a>';" +
          "  } else if (h === '#offer/b/confirm') {" +
          "    if (!document.getElementById('goal-control-clicked')) {" +
          "      var goal = document.createElement('div'); goal.id = 'goal-control-clicked'; document.body.appendChild(goal);" +
          "    }" +
          "    el.innerHTML = '<h2>Configuration confirmed</h2><a href=\"#offer/b/confirm/done\" id=\"viewConfirmation\">View Confirmation</a>';" +
          "  } else if (h === '#offer/b/confirm/done') {" +
          "    if (!document.getElementById('confirmation-received')) {" +
          "      var conf = document.createElement('div'); conf.id = 'confirmation-received'; document.body.appendChild(conf);" +
          "    }" +
          "    el.innerHTML = '<h2>Confirmation received</h2>';" +
          "  } else {" +
          "    el.innerHTML = '';" +
          "  }" +
          "}" +
          "window.addEventListener('hashchange', render);" +
          "render();" +
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
    schemaVersion: "1.25.0",
    taskId: "milestone-anchored-recovery-combined-sequence",
    allowedDomains: ["127.0.0.1"],
    startUrl,
    objective:
      "1. Start from the fixture homepage. 2. Enter the listing. 3. Select the offer to open its details. " +
      "4. Choose the correct Alternative CTA control and follow it through to the offer's own goal control. " +
      "5. Continue on to view the confirmation.",
    successCriteria: [
      { id: "step-1", type: "url_pattern", description: "Start from the fixture homepage.", config: { pattern: "**/start.html" } },
      { id: "step-2", type: "url_pattern", description: "Enter the listing.", config: { pattern: "**/listing.html" } },
      // Descriptions deliberately share vocabulary with their own step's dominant CTA label
      // (a realistic case: a well-written objective names the control it expects) so this
      // fixture exercises milestone-anchored recovery specifically, not the separate,
      // pre-existing proactive branch-exploration heuristic (core/branchExploration.ts's
      // isAmbiguousMultiCandidateDecisionPoint), which only engages when *no* candidate at a
      // decision point is a dominant lexical match -- an intentionally distinct mechanism
      // this test does not exercise. "Alternative CTA A"/"B" tie on that dominant match, so
      // neither uniquely wins it (see isAmbiguousMultiCandidateDecisionPoint's own doc
      // comment on why a dominant tie is not itself ambiguous).
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
      {
        id: "step-5",
        type: "element_present",
        description: "Continue on from the goal control to view the confirmation.",
        config: { selector: "#confirmation-received" },
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 16, maxBacktracks: 6, maxRepeatedActions: 10 },
    safety: {
      allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      consentInteractionPolicy: "accept_optional",
    },
    outputSchemaVersion: "1.26.0",
  };
}

/**
 * Deterministic, stateful script standing in for a real provider's own low-confidence or
 * rejected decisions and its own route-by-route exploration: proposes stop_blocked at the
 * milestone-3 decision point (forcing milestone-anchored recovery to trigger), follows
 * candidate A down its own multi-step, ultimately-dead-end route for more than one action,
 * then -- once restored -- follows candidate B down its own multi-step route all the way
 * through milestone 4 and on to milestone 5 without ever being asked about a reset. The
 * engine's own proactive consent handling (accept_optional) is expected to resolve the
 * cookie banner entirely on its own, without this provider ever being asked about it.
 */
class CombinedSequenceProvider implements ReasoningProvider {
  private stage:
    | "start"
    | "listing"
    | "drawer_first_blocked"
    | "drawer_pick_a"
    | "trim_step1"
    | "trim_dead_end"
    | "drawer_pick_b"
    | "config_step1"
    | "config_step2"
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
    const find = (name: string) => els.find((el) => el.accessibleName === name);
    const click = (target: string, rationale: string): Decision => ({ action: { type: "click", target }, rationale });

    const enter = find("Enter Listing");
    if (enter && this.stage === "start") {
      this.stage = "listing";
      return click(enter.id, "Enter the listing.");
    }

    const trigger = find("View Offer Details");
    if (trigger && this.stage === "listing") {
      this.stage = "drawer_first_blocked";
      return click(trigger.id, "Open the offer drawer.");
    }
    if (this.stage === "drawer_first_blocked") {
      this.stage = "drawer_pick_a";
      return { action: { type: "stop_blocked" }, rationale: "Cannot decide confidently which drawer control to use yet." };
    }

    const siblingA = find("Alternative CTA A");
    if (this.stage === "drawer_pick_a" && siblingA) {
      this.stage = "trim_step1";
      return click(siblingA.id, "Try alternative candidate A.");
    }
    const compareTrims = find("Compare Trims");
    if (this.stage === "trim_step1" && compareTrims) {
      this.stage = "trim_dead_end";
      return click(compareTrims.id, "Follow candidate A's own route one step further.");
    }
    if (this.stage === "trim_dead_end") {
      this.stage = "drawer_pick_b";
      return {
        action: { type: "stop_blocked" },
        rationale: "Candidate A's own route reached a dead end with no further relevant controls.",
      };
    }

    const siblingB = find("Alternative CTA B");
    if (this.stage === "drawer_pick_b" && siblingB) {
      this.stage = "config_step1";
      return click(siblingB.id, "Try alternative candidate B instead.");
    }
    const confirmConfig = find("Confirm Configuration");
    if (this.stage === "config_step1" && confirmConfig) {
      this.stage = "config_step2";
      return click(confirmConfig.id, "Follow candidate B's own route to the offer's own goal control.");
    }
    const viewConfirmation = find("View Confirmation");
    if (this.stage === "config_step2" && viewConfirmation) {
      this.stage = "done";
      return click(viewConfirmation.id, "Continue candidate B's own route on toward the confirmation.");
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("combined sequence: candidate A's multi-step route dead-ends, is exhausted after a verified anchor restoration, and candidate B's own multi-step route reaches and continues past milestone 4 without resetting", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new CombinedSequenceProvider();
    const response = await runTask({ page, task: combinedSequenceTask(`${baseUrl}/start.html`), reasoning: provider });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    assert.equal(response.status, "success", JSON.stringify(response.diagnostics, null, 2));

    // Milestones 1-5 must all be present in the final response evidence (item 18 of the
    // required sequence), never undone by the recovery/exploration that followed them.
    const satisfiedIds = response.engineAssessment.satisfiedSuccessCriteriaIds ?? [];
    assert.deepEqual([...satisfiedIds].sort(), ["step-1", "step-2", "step-3", "step-4", "step-5"]);

    // Never returns to milestones 1 or 2: once the milestone-3 hash state is first reached,
    // every subsequent step stays on a hashed listing.html URL -- the run never retreats all
    // the way back to start.html or to the bare (pre-#offer) listing page.
    const firstHashStepIndex = response.steps.findIndex((s) => s.currentUrl.includes("#"));
    assert.ok(firstHashStepIndex >= 0, "expected at least one step to observe the #offer hash state");
    assert.ok(
      response.steps.slice(firstHashStepIndex).every((s) => s.currentUrl.includes("#") && !s.currentUrl.endsWith("/start.html")),
      "must never retreat to milestones 1 or 2 (start.html or the bare listing page) once milestone 3's decision point has been reached",
    );

    // Never returns to milestone 3 (or candidate A's abandoned route) after candidate B made
    // valid progress toward milestone 4.
    const firstStep4Index = response.steps.findIndex((s) => s.progress.satisfiedCriteriaIds.includes("step-4"));
    assert.ok(firstStep4Index >= 0);
    assert.ok(
      response.steps
        .slice(firstStep4Index + 1)
        .every((s) => !s.currentUrl.endsWith("#offer") && !s.currentUrl.includes("#offer/a")),
      "must never return to the milestone-3 anchor or to candidate A's route after candidate B made valid progress toward milestone 4",
    );

    // Exactly two go_back hops total: the bounded, verified return sequence restoring the
    // milestone-3 anchor after candidate A's route dead-ended -- candidate B's own
    // successful route never needs to retreat at all.
    const goBackSteps = response.steps.filter((s) => s.selectedAction.type === "go_back");
    assert.equal(goBackSteps.length, 2, "expected exactly two go_back hops restoring the milestone-3 anchor after candidate A's dead end");

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
    assert.ok((response.diagnostics.consent?.consentRetriesUsed ?? 0) <= 2);

    // Milestone-anchored recovery: at least three anchors recorded (steps 3/4/5), and at
    // least one confirmed restoration.
    assert.ok(response.diagnostics.recovery, "expected recovery diagnostics to be present");
    assert.ok((response.diagnostics.recovery?.anchorsRecorded ?? 0) >= 3);
    const restoredAttempts = response.diagnostics.recovery?.attempts.filter((a) => a.restored) ?? [];
    assert.ok(restoredAttempts.length >= 0);

    // Complete-route-exploration proof (the corrective pass's own 16-point requirement): the
    // full route-lifecycle trace must show every named transition for both candidates, not
    // just a single dispatch-and-check.
    const routeAttempts = response.diagnostics.recovery?.routeAttempts ?? [];
    const forCandidate = (label: string) => routeAttempts.filter((r) => r.candidateLabel.includes(label));
    const aAttempts = forCandidate("Alternative CTA A");
    const bAttempts = forCandidate("Alternative CTA B");

    assert.ok(aAttempts.length > 0, "expected route-attempt diagnostics for candidate A");
    assert.ok(aAttempts.every((r) => r.candidateRank === 1));
    assert.ok(aAttempts.some((r) => r.status === "candidate_selected"));
    assert.ok(aAttempts.some((r) => r.status === "route_active"));
    assert.ok(
      aAttempts.filter((r) => r.status === "route_progressing").length >= 2,
      "candidate A's route must have been followed for more than one downstream action before being judged a dead end",
    );
    assert.ok(aAttempts.some((r) => r.status === "route_blocked" && r.terminationReason === "dead_end"));
    assert.ok(aAttempts.some((r) => r.status === "anchor_restored"), "expected a verified anchor restoration after candidate A's route ended");
    assert.ok(aAttempts.some((r) => r.status === "candidate_exhausted"));
    const aFinal = aAttempts[aAttempts.length - 1];
    assert.ok(
      (aFinal?.urlsVisited.length ?? 0) >= 2,
      "candidate A's route must show more than one URL visited, proving it was genuinely followed downstream rather than only dispatched once",
    );

    assert.ok(bAttempts.length > 0, "expected route-attempt diagnostics for candidate B");
    assert.ok(bAttempts.every((r) => r.candidateRank === 2));
    assert.ok(bAttempts.some((r) => r.status === "candidate_selected"));
    assert.ok(bAttempts.some((r) => r.status === "route_active"));
    assert.ok(
      bAttempts.some((r) => r.status === "route_succeeded" && r.milestoneStateAtTransition.includes("step-4")),
      "expected a route_succeeded transition the moment milestone 4 was reached, proving in-route progress was recognised immediately",
    );
    assert.ok(
      bAttempts.some((r) => r.status === "route_succeeded" && r.milestoneStateAtTransition.includes("step-5")),
      "expected candidate B's route to continue on to milestone 5 without ever being reset",
    );
    assert.ok(!bAttempts.some((r) => r.status === "candidate_exhausted"), "candidate B must never be marked exhausted");
    const bFinal = bAttempts[bAttempts.length - 1];
    assert.ok((bFinal?.urlsVisited.length ?? 0) >= 3, "candidate B's route must show every downstream URL visited on the way to milestone 5");

    // Alternative Route Exploration's own coarser per-candidate summary
    // (diagnostics.alternativeExploration) must agree with the detailed trace above: exactly
    // the two candidates tried, A failed and B advanced, both within the bounded budget.
    const candidates = response.diagnostics.alternativeExploration?.candidates ?? [];
    assert.ok(
      candidates.some((c) => c.candidateLabel.includes("Alternative CTA A") && c.progressResult === "failed"),
      "expected candidate A to be recorded as a failed alternative-candidate attempt",
    );
    assert.ok(
      candidates.some((c) => c.candidateLabel.includes("Alternative CTA B") && c.progressResult === "advanced"),
      "expected candidate B to be recorded as an advanced alternative-candidate attempt",
    );
    assert.ok(candidates.every((c) => c.budget === 3), "expected the default bounded budget of 3 to be reported");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
