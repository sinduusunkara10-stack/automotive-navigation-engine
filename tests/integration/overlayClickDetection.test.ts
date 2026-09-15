import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { executeClick } from "../../src/actions/click.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Overlay-click-detection fix (see CLAUDE.md and docs/architecture.md §18). Generic
 * reproductions of the reported production defect's shape: a CTA click handler opens a
 * same-document overlay (a role="dialog" surface, often backed by a hash-only URL change
 * the handler itself sets as a side effect); the engine must recognise that as real
 * progress and expose the overlay's own controls to the next observation, rather than
 * discarding it via the generic destinationUrl navigation fallback (which cannot reproduce
 * a click-handler-only effect). Nothing here is specific to any website, brand, market, or
 * CTA label -- every route is synthetic, served from 127.0.0.1 on an ephemeral port (mirrors
 * tests/integration/actionExecutionConsistency.test.ts's own convention).
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/race-start.html") {
      // Models the reported race directly: a dialog begins rendering shortly after the
      // page loads (e.g. a lazy-hydrating overlay component) and persists once it appears.
      // Playwright's own click() commits to dispatching a real click only once its
      // actionability pre-check already passed, so a handler *triggered by* that same
      // click cannot itself race the click's own dispatch -- this is the closest
      // deterministic stand-in for "the trigger became covered while Playwright was still
      // performing actionability retries" that a test can reliably reproduce. The click
      // executor's own recovery logic (actions/click.ts) does not know or care what caused
      // the interception -- only whether generic evidence of a real side effect exists once
      // it happens -- so this is a faithful test of that recovery logic either way.
      return void page(
        "Start",
        '<button type="button">View Details</button>' +
          "<script>" +
          "setTimeout(function () {" +
          "  var d = document.createElement('div');" +
          "  d.setAttribute('role', 'dialog');" +
          "  d.setAttribute('aria-modal', 'true');" +
          "  d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5)';" +
          "  d.innerHTML = '<h2>Details</h2><button type=\"button\">Request a Callback</button>';" +
          "  document.body.appendChild(d);" +
          "}, 50);" +
          "</script>",
      );
    }

    if (path === "/listing.html") {
      // The full reported shape: repeated offer-style cards, each with two alternatives (an
      // "Info" branch and a "View Details" branch sharing an identical CTA label across
      // cards), a details CTA whose click handler changes the URL hash *and* asynchronously
      // injects a dialog containing a new goal-directed CTA. Nothing here reads the hash on
      // load -- only the click handler itself opens the dialog, so a raw hash-only
      // navigation can never reproduce it (see the dedicated test below).
      return void page(
        "Listing",
        '<div><h3>Fictional Model Alpha</h3>' +
          '<button type="button" class="info" data-id="alpha">Info</button>' +
          '<button type="button" class="details" data-id="alpha">View Details</button></div>' +
          '<div><h3>Fictional Model Beta</h3>' +
          '<button type="button" class="info" data-id="beta">Info</button>' +
          '<button type="button" class="details" data-id="beta">View Details</button></div>' +
          "<script>" +
          "document.querySelectorAll('.info').forEach(function (btn) {" +
          "  btn.addEventListener('click', function () {" +
          "    var p = document.createElement('p');" +
          "    p.textContent = 'Info for ' + btn.dataset.id;" +
          "    p.className = 'info-text';" +
          "    document.body.appendChild(p);" +
          "  });" +
          "});" +
          "document.querySelectorAll('.details').forEach(function (btn) {" +
          "  btn.addEventListener('click', function () {" +
          "    var id = btn.dataset.id;" +
          "    history.pushState(null, '', '#offerId=' + id);" +
          "    setTimeout(function () {" +
          "      var d = document.createElement('div');" +
          "      d.setAttribute('role', 'dialog');" +
          "      d.setAttribute('aria-modal', 'true');" +
          "      d.innerHTML = '<h2>Details for ' + id + '</h2>' +" +
          "        '<button type=\"button\" id=\"goal-cta\">Request a Callback</button>' +" +
          "        '<button type=\"button\" id=\"dialog-close\">Close</button>';" +
          "      d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5)';" +
          "      document.body.appendChild(d);" +
          "      document.getElementById('dialog-close').addEventListener('click', function () { d.remove(); });" +
          "      document.getElementById('goal-cta').addEventListener('click', function () {" +
          "        document.title = 'Callback Requested';" +
          "      });" +
          "    }, 60);" +
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

/** Always clicks the first not-yet-clicked element whose accessibleName matches, else stop_success once satisfied, else stop_failure. */
class ClickByNameProvider implements ReasoningProvider {
  constructor(private readonly targetName: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    const clickedTargets = new Set(
      context.recentActions.filter((a) => a.type === "click" && a.target).map((a) => a.target as string),
    );
    const candidate = context.observation.interactiveElements.find(
      (el) => el.accessibleName === this.targetName && !clickedTargets.has(el.id),
    );
    if (candidate && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: candidate.id }, rationale: `Click "${candidate.accessibleName}".` };
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

/**
 * Reaches the listing's "Fictional Model Alpha" card specifically (never Beta), clicking
 * "View Details" under Alpha's own heading, then the dialog's goal-directed CTA. Uses
 * nearestHeadingText to disambiguate which physical "View Details" button to click, exactly
 * as the repeated-card candidate identity fix (core/routeMemory.ts) does internally.
 */
class ListingProvider implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }
    const goalCta = context.observation.interactiveElements.find((el) => el.accessibleName === "Request a Callback");
    if (goalCta) {
      return { action: { type: "click", target: goalCta.id }, rationale: "Click the goal-directed CTA." };
    }
    const alphaDetails = context.observation.interactiveElements.find(
      (el) => el.accessibleName === "View Details" && el.nearestHeadingText === "Fictional Model Alpha",
    );
    if (alphaDetails) {
      return { action: { type: "click", target: alphaDetails.id }, rationale: "Open Alpha's own details." };
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function buildTask(params: { startUrl: string; successCriteria: TaskRequest["successCriteria"] }): TaskRequest {
  return {
    schemaVersion: "1.14.0",
    taskId: "overlay-click-detection",
    objective: "Reach the fixture's goal-directed control via the configured overlay flow.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: params.successCriteria,
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.13.0",
  };
}

test("actions/click.ts directly: a click that Playwright's own actionability retries classify as 'intercepted' (a dialog appears mid-poll and persists) is recognised as a real success, and the destinationUrl fallback is never invoked", async () => {
  // Exercises actions/click.ts's own interception-recovery branch deterministically, at the
  // executor level rather than through the full engine loop: calling executeClick directly
  // removes core/loop.ts's own per-step overhead (a reasoning-provider round trip,
  // evaluateSuccessCriteria, etc.), whose added latency was empirically found to shift this
  // fixture's race outcome toward the button dispatching cleanly before the dialog ever
  // appears (still a valid, correctly-handled outcome -- see the non-navigating-success
  // path test below -- just not *this* specific branch). Calling the executor directly is
  // the reliable way to prove the "click() itself times out as intercepted, but a bounded
  // post-click check recognises the dialog anyway" branch specifically, without a flaky,
  // machine-speed-dependent race baked into an end-to-end test.
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/race-start.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "View Details");
    assert.ok(target, "expected the trigger button in the initial observation");

    const captures = {};
    const start = Date.now();
    const result = await executeClick({
      page,
      action: { type: "click", target: target!.id },
      allowedDomains: ["127.0.0.1"],
      timeoutMs: 10000,
      captures,
      stepIndex: 0,
      captureModules: ["errors"],
    });
    const elapsedMs = Date.now() - start;

    assert.equal(result.success, true);
    assert.equal(result.clickSideEffectDetected, true);
    // Proves this genuinely went through Playwright's own actionability-timeout path (the
    // fixed CLICK_ELEMENT_TIMEOUT_MS in actions/click.ts), not a coincidentally-fast direct
    // dispatch -- the interception-recovery branch is only reached after that timeout fires.
    assert.ok(elapsedMs >= 4900, `expected this to have gone through the ~5s click timeout, took ${elapsedMs}ms`);

    const errors = (captures as { errors?: { message: string; category: string; severity: string }[] }).errors ?? [];
    const fallbackAttempted = errors.some((e) => /fallbackNavigationAttempted=true/.test(e.message));
    assert.ok(!fallbackAttempted, "the destinationUrl fallback must never even be attempted");
    const sideEffectDiagnostic = errors.find((e) => /appeared to fail \(intercepted\)/.test(e.message));
    assert.ok(sideEffectDiagnostic, "expected a diagnostic recording the recognised intercepted-category side effect");
    assert.equal(sideEffectDiagnostic?.category, "stale_target_recovery");
    assert.equal(sideEffectDiagnostic?.severity, "info");
    assert.match(sideEffectDiagnostic?.message ?? "", /dialog_appeared/);

    const dialogNowVisible = await page.evaluate(() => document.querySelector('[role="dialog"]') !== null);
    assert.equal(dialogNowVisible, true, "the dialog's DOM state must be preserved, not discarded by a fallback navigation");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a click whose own dialog appears while Playwright is still settling on it is recognised as a real success, and the destinationUrl fallback is never attempted", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/race-start.html`,
      successCriteria: [
        {
          id: "callback_cta_reached",
          type: "element_present",
          description: "The goal-directed control is present.",
          config: { selector: 'button:has-text("Request a Callback")' },
        },
      ],
    });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider("View Details") });

    assert.equal(response.status, "success");
    // The overlay's own goal-directed control must have been exposed to a later observation.
    const sawGoalControl = response.steps.some((s) =>
      s.observation.interactiveElements.some((el) => el.accessibleName === "Request a Callback"),
    );
    assert.ok(sawGoalControl, "expected the dialog's own control to be exposed to a later observation");

    // The generic destinationUrl fallback must never have been invoked at all: the button
    // has no href (a real destinationUrl fallback is not even eligible for it -- see
    // actions/click.ts's own "no_destination_url" rejection), so the only way this run can
    // have reached the dialog's own control at all is by the click being recognised as
    // genuinely successful -- whether Playwright's own click() happened to dispatch cleanly
    // (the ordinary non-navigating-success path, itself now also side-effect-aware -- see
    // actions/click.ts) or happened to first look intercepted and was then recovered via the
    // dedicated overlay-click-detection check. Exactly which of the two is timing-dependent
    // (Playwright's own actionability polling cadence against this fixture's async delay)
    // and is not itself the thing under test here -- what matters, and what the assertions
    // above already establish, is that neither path ever fell through to a fallback attempt.
    const fallbackAttempted = response.captures.errors?.some((e) => /fallbackNavigationAttempted=true/.test(e.message));
    assert.ok(!fallbackAttempted, "the destinationUrl fallback must never even be attempted once a click side effect is recognised");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION (generic reproduction of the reported production shape): a repeated-card listing's details CTA changes the hash and asynchronously opens a dialog with a new goal-directed CTA; the engine reaches it without ever using the hash-only destinationUrl fallback", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/listing.html`,
      successCriteria: [
        {
          id: "goal_cta_present",
          type: "element_present",
          description: "The goal-directed control inside the details dialog is present.",
          config: { selector: "#goal-cta" },
        },
      ],
    });
    const response = await runTask({ page, task, reasoning: new ListingProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/listing.html#offerId=alpha`);

    // The dialog's own goal-directed CTA must have reached the reasoning layer.
    const sawGoalControl = response.steps.some((s) =>
      s.observation.interactiveElements.some((el) => el.accessibleName === "Request a Callback"),
    );
    assert.ok(sawGoalControl);

    // Confirms the click actually clicked Alpha's own button (nearestHeadingText
    // disambiguation) and not Beta's -- the CTA reached is scoped to "alpha".
    assert.match(response.finalUrl, /offerId=alpha/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("raw hash-only navigation, bypassing the click handler entirely, never reproduces a click-handler-only dialog (the underlying browser-level fact this whole fix addresses)", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/listing.html`);
    // Direct navigation straight to the hash URL, exactly as the generic destinationUrl
    // fallback (actions/click.ts) would perform it -- never a real click.
    await page.goto(`${baseUrl}/listing.html#offerId=alpha`);
    await page.waitForTimeout(300);

    const dialogPresent = await page.evaluate(() => document.querySelector('[role="dialog"]') !== null);
    assert.equal(dialogPresent, false, "a raw hash-only navigation must not open a dialog only the click handler knows how to render");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("the modal's own diagnostic evidence is a real Playwright/DOM fact, not merely engine bookkeeping: role=dialog, aria-modal=true, and an accessible-name match for the goal control are all directly inspectable after a genuine click", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page: Page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/listing.html`);
    await page.getByRole("button", { name: "View Details" }).first().click();
    await page.waitForTimeout(200);

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    await assert.doesNotReject(dialog.waitFor({ state: "visible", timeout: 1000 }));
    await assert.doesNotReject(
      page.getByRole("button", { name: "Request a Callback" }).waitFor({ state: "visible", timeout: 1000 }),
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
