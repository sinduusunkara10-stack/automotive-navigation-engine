import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Multilingual consent handling (corrective pass, see CLAUDE.md and docs/architecture.md
 * "Consent behaviour -- multilingual" / "Consent behaviour -- consent at any journey
 * stage"): a genuine consent surface, in a different configured language each time,
 * re-appears at every required journey stage -- initial page load (French), after milestone
 * 1 (German), after milestone 3 (Spanish), while a tracked candidate route is active
 * (Italian), while progressing from milestone 4 toward milestone 5 (Dutch), and after a real
 * navigation to a further page (English) -- and every single one is resolved by the engine
 * itself, in place, without ever: returning to the homepage, resetting or exhausting the
 * active candidate route, or consuming the alternative-route-exploration budget. Nothing
 * here is brand-specific -- every route/label is synthetic and served from 127.0.0.1.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, lang: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html lang="${lang}"><head><title>${title}</title></head><body>${body}</body></html>`);

    const banner = (id: string, heading: string, acceptLabel: string, declineLabel: string) =>
      `<div id="${id}"><h2>${heading}</h2>` +
      `<button type="button" id="${id}-accept">${acceptLabel}</button>` +
      `<button type="button" id="${id}-decline">${declineLabel}</button></div>`;

    if (path === "/start.html") {
      // Point 1: a genuine consent surface at initial page load, in French.
      return void page(
        "Start",
        "fr",
        banner("consent-fr", "Nous utilisons des cookies", "Tout accepter", "Tout refuser") +
          '<a href="/listing.html">Enter Listing</a>' +
          "<script>document.getElementById('consent-fr-accept').addEventListener('click', function () { document.getElementById('consent-fr').remove(); });</script>",
      );
    }

    if (path === "/listing.html") {
      const fillers = Array.from({ length: 45 }, (_, i) => `<a href="#filler-${i}">Filler link ${i}</a>`).join(" ");
      // Point 2: a further genuine consent surface after milestone 1 (arriving here), in German.
      return void page(
        "Listing",
        "de",
        fillers +
          banner("consent-de", "Wir verwenden Cookies", "Alle akzeptieren", "Alle ablehnen") +
          '<a href="#offer" id="trigger">View Offer Details</a>' +
          '<div id="routed-content"></div>' +
          "<script>" +
          "document.getElementById('consent-de-accept').addEventListener('click', function () { document.getElementById('consent-de').remove(); });" +
          // Each stage's own banner is shown at most once, even if a bounded go_back return
          // (e.g. restoring the milestone-3 anchor after a dead-end candidate route) causes
          // this same hash state to render again -- exactly like a real cookie-consent
          // widget's own "don't ask again this session" behaviour, and keeping this
          // fixture's six language stages exactly six real surfaces, not a resurfaced one.
          "var shownConsent = {};" +
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
          // Point 3: a further genuine consent surface after milestone 3 (the drawer/decision
          // point opens), in Spanish.
          "    el.innerHTML = '<h2>Offer details</h2>' +" +
          "      (shownConsent.es ? '' : '" + banner("consent-es", "Usamos cookies", "Aceptar todo", "Rechazar todo").replace(/'/g, "\\'") + "') +" +
          "      '<a href=\"#offer/a\" id=\"siblingA\">Alternative CTA A</a> ' +" +
          "      '<a href=\"#offer/b\" id=\"siblingB\">Alternative CTA B</a>';" +
          "    shownConsent.es = true;" +
          "    var esAccept = document.getElementById('consent-es-accept');" +
          "    if (esAccept) esAccept.addEventListener('click', function () { document.getElementById('consent-es').remove(); });" +
          "  } else if (h === '#offer/a') {" +
          // Point 4: a further genuine consent surface while candidate A's own tracked route
          // is active, in Italian. Candidate A itself is a dead end (no further relevant
          // controls once consent is resolved) -- the multi-step-route proof itself lives in
          // milestoneAnchoredRecovery.test.ts; this fixture's own focus is proving consent
          // resolves correctly *during* an active route without disturbing it.
          "    el.innerHTML = '<h2>Trim options</h2>' +" +
          "      (shownConsent.it ? '' : '" + banner("consent-it", "Utilizziamo i cookie", "Accetta tutto", "Rifiuta tutto").replace(/'/g, "\\'") + "') +" +
          "      '<p>No further relevant controls here.</p>';" +
          "    shownConsent.it = true;" +
          "    var itAccept = document.getElementById('consent-it-accept');" +
          "    if (itAccept) itAccept.addEventListener('click', function () { document.getElementById('consent-it').remove(); });" +
          "  } else if (h === '#offer/b') {" +
          "    el.innerHTML = '<h2>Configure offer</h2><a href=\"#offer/b/confirm\" id=\"confirmConfig\">Confirm Configuration</a>';" +
          "  } else if (h === '#offer/b/confirm') {" +
          "    if (!document.getElementById('goal-control-clicked')) {" +
          "      var goal = document.createElement('div'); goal.id = 'goal-control-clicked'; document.body.appendChild(goal);" +
          "    }" +
          // Point 5: a further genuine consent surface while progressing from milestone 4
          // toward milestone 5, in Dutch.
          "    el.innerHTML = '<h2>Configuration confirmed</h2>' +" +
          "      (shownConsent.nl ? '' : '" + banner("consent-nl", "Wij gebruiken cookies", "Alles accepteren", "Alles weigeren").replace(/'/g, "\\'") + "') +" +
          "      '<a href=\"#offer/b/confirm/done\" id=\"viewConfirmation\">View Confirmation</a>';" +
          "    shownConsent.nl = true;" +
          "    var nlAccept = document.getElementById('consent-nl-accept');" +
          "    if (nlAccept) nlAccept.addEventListener('click', function () { document.getElementById('consent-nl').remove(); });" +
          "  } else if (h === '#offer/b/confirm/done') {" +
          "    if (!document.getElementById('confirmation-received')) {" +
          "      var conf = document.createElement('div'); conf.id = 'confirmation-received'; document.body.appendChild(conf);" +
          "    }" +
          "    el.innerHTML = '<h2>Confirmation received</h2><a href=\"/summary.html\" id=\"toSummary\">Continue to Summary</a>';" +
          "  } else {" +
          "    el.innerHTML = '';" +
          "  }" +
          "}" +
          "window.addEventListener('hashchange', render);" +
          "render();" +
          "</script>",
      );
    }

    if (path === "/summary.html") {
      // Point 6: a further genuine consent surface after a real navigation to a further
      // page, in English.
      return void page(
        "Summary",
        "en",
        banner("consent-en", "We use cookies", "Accept All Cookies", "Reject All") +
          '<div id="summary-viewed"></div>' +
          "<script>document.getElementById('consent-en-accept').addEventListener('click', function () { document.getElementById('consent-en').remove(); });</script>",
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

function task(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.23.0",
    taskId: "multilingual-consent-every-journey-stage",
    allowedDomains: ["127.0.0.1"],
    startUrl,
    objective:
      "1. Start from the fixture homepage. 2. Enter the listing. 3. Select the offer to open its details. " +
      "4. Choose the correct Alternative CTA control and follow it through to the offer's own goal control. " +
      "5. Continue on to view the confirmation. 6. Continue to the summary page.",
    successCriteria: [
      { id: "step-1", type: "url_pattern", description: "Start from the fixture homepage.", config: { pattern: "**/start.html" } },
      { id: "step-2", type: "url_pattern", description: "Enter the listing.", config: { pattern: "**/listing.html" } },
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
      { id: "step-6", type: "element_present", description: "Continue to the summary page.", config: { selector: "#summary-viewed" } },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 20, maxBacktracks: 6, maxRepeatedActions: 10 },
    safety: {
      allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      consentInteractionPolicy: "accept_optional",
    },
    outputSchemaVersion: "1.24.0",
  };
}

class MultilingualJourneyProvider implements ReasoningProvider {
  private stage:
    | "start"
    | "listing"
    | "drawer_first_blocked"
    | "drawer_pick_a"
    | "after_a_blocked"
    | "drawer_pick_b"
    | "config_step1"
    | "config_step2"
    | "to_summary"
    | "done" = "start";

  sawConsentControlInPrompt = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All success criteria satisfied." };
    }
    const els = context.observation.interactiveElements;
    if (els.some((el) => /cookie|consent|akzept|accept|rifiut|weiger|weiger|rechaz|refus/i.test(el.accessibleName))) {
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
      this.stage = "after_a_blocked";
      return click(siblingA.id, "Try alternative candidate A.");
    }
    if (this.stage === "after_a_blocked") {
      this.stage = "drawer_pick_b";
      return { action: { type: "stop_blocked" }, rationale: "Candidate A did not help; still cannot decide confidently." };
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
      this.stage = "to_summary";
      return click(viewConfirmation.id, "Continue on toward the confirmation.");
    }
    const toSummary = find("Continue to Summary");
    if (this.stage === "to_summary" && toSummary) {
      this.stage = "done";
      return click(toSummary.id, "Continue to the summary page.");
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("a genuine consent surface, in a different configured language each time, is resolved by the engine at every required journey stage without ever resetting state or spending the navigation budget", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const provider = new MultilingualJourneyProvider();
    const response = await runTask({ page, task: task(`${baseUrl}/start.html`), reasoning: provider });
    const validation = await validateAgainstTaskResponseSchema(response);
    assert.ok(validation.valid, validation.errorsText);

    assert.equal(response.status, "success", JSON.stringify(response.diagnostics, null, 2));
    const satisfiedIds = response.engineAssessment.satisfiedSuccessCriteriaIds ?? [];
    assert.deepEqual([...satisfiedIds].sort(), ["step-1", "step-2", "step-3", "step-4", "step-5", "step-6"]);

    // Every one of the six consent surfaces (fr, de, es, it, nl, en) was resolved by the
    // engine itself -- never surfaced to the reasoning layer as something it had to act on.
    assert.ok(response.diagnostics.consent, "expected consent diagnostics to be present");
    const surfaces = response.diagnostics.consent?.surfaces ?? [];
    const acceptedSurfaces = surfaces.filter((s) => s.engineActionTaken === "clicked_accept_all");

    assert.equal(acceptedSurfaces.length, 6, "expected all six language surfaces to have been proactively accepted");
    assert.ok(acceptedSurfaces.every((s) => s.engineActionVerified !== false));
    assert.equal(
      provider.sawConsentControlInPrompt,
      false,
      "the reasoning layer should never have been asked to act on any of the six consent surfaces directly",
    );
    // Each surface was resolved by the deterministic, configured-language table -- none of
    // these six languages needed the model-assist fallback.
    assert.ok(acceptedSurfaces.every((s) => s.resolvedViaModelAssist !== true));

    // Pause/resume without resetting state: the milestone-3 anchor, candidate route
    // bookkeeping, and exhausted-candidate tracking all still worked correctly around every
    // one of these six interruptions -- proven the same way milestoneAnchoredRecovery.test.ts
    // proves it, on a run whose consent surfaces are the entire point.
    assert.ok((response.diagnostics.recovery?.anchorsRecorded ?? 0) >= 3);
    const routeAttempts = response.diagnostics.recovery?.routeAttempts ?? [];
    const aAttempts = routeAttempts.filter((r) => r.candidateLabel.includes("Alternative CTA A"));
    const bAttempts = routeAttempts.filter((r) => r.candidateLabel.includes("Alternative CTA B"));
    assert.ok(aAttempts.some((r) => r.status === "candidate_exhausted"));
    assert.ok(
      aAttempts.some((r) => r.consentInterruptionsHandled >= 1),
      "expected candidate A's own route diagnostics to show the Italian consent interruption it absorbed while active",
    );
    assert.ok(
      bAttempts.some((r) => r.status === "route_succeeded" && r.milestoneStateAtTransition.includes("step-4")),
      "expected candidate B's route to still reach milestone 4 despite the Dutch consent interruption partway through it",
    );
    assert.ok(!bAttempts.some((r) => r.status === "candidate_exhausted"), "candidate B must never have been marked exhausted");

    // Never spent the navigation-exploration budget: exactly the two candidates (A, B) were
    // ever tried, each still reporting the default bounded budget of 3.
    const candidates = response.diagnostics.alternativeExploration?.candidates ?? [];
    assert.equal(candidates.length, 2, "the six consent interruptions must never have consumed an alternative-candidate attempt");
    assert.ok(candidates.every((c) => c.budget === 3));

    // Never returned to the homepage at any point after it was first left -- the French
    // consent surface adds one extra step still observing start.html before "Enter Listing"
    // is even dispatched, so this checks every step *after* the last one still on start.html,
    // not merely index 1.
    const lastStartHtmlStepIndex = response.steps.map((s) => s.currentUrl).lastIndexOf(`${baseUrl}/start.html`);
    assert.ok(lastStartHtmlStepIndex >= 0);
    assert.ok(response.steps.slice(lastStartHtmlStepIndex + 1).every((s) => !s.currentUrl.endsWith("/start.html")));

    // Consent's own bounded retry budget (separate from every navigation budget) covered
    // all six surfaces without exhausting -- MAX_CONSENT_RETRIES is sized generously enough
    // for a real multi-surface journey.
    assert.ok((response.diagnostics.consent?.consentRetriesUsed ?? 0) === 6);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
