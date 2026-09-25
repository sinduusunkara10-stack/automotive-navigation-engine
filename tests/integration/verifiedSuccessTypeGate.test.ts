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
 * BMW live-site corrective work (2026-09-21, see the BMW-run investigation memo and
 * ActionResult.verifiedSuccessType's own doc comment in src/types/task-response.ts):
 * regression coverage for Correction A (actions/click.ts) -- a target becoming
 * covered/disappearing/re-rendering must never, by itself, be reported as a successful
 * click; it must be corroborated by a standards-based dialog or a settled multi-control
 * panel, or the click must fall through to the generic destinationUrl fallback (and that
 * fallback's own result must itself be verified). Nothing here is specific to any
 * website, brand, market, or CTA label -- every route is synthetic, served from
 * 127.0.0.1 on an ephemeral port, mirroring tests/integration/overlayClickDetection.test.ts's
 * own convention.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    // Same deterministic animation-driven timing device as
    // tests/integration/overlayClickDetection.test.ts's /race-start.html -- see that file's
    // own comment for why this reliably forces Playwright's actionability retries into the
    // "intercepted" category without racing a wall-clock timer against machine-dependent
    // setup latency.
    const animatedTrigger = (triggerMarkup: string, onSettleScript: string) =>
      "<style>" +
      "@keyframes settle { 0% { transform: translateX(0); } 50% { transform: translateX(1px); } 100% { transform: translateX(0); } }" +
      // display:inline-block is required for the transform-based instability check below to
      // have any effect on an <a> (transform is a no-op on a plain inline box per the CSS
      // spec) -- without it, an anchor target is judged stable immediately and the click
      // dispatches before ever hitting Playwright's own actionability-timeout path, unlike a
      // <button>, which is inline-block by default.
      "#trigger { animation: settle 1s linear; display: inline-block; }" +
      "</style>" +
      triggerMarkup +
      "<script>" +
      `document.getElementById('trigger').addEventListener('animationend', function () { ${onSettleScript} });` +
      "</script>";

    if (path === "/weak-signal-no-destination.html") {
      // No href at all -- the destinationUrl fallback is not even eligible (see
      // actions/click.ts's "no_destination_url" rejection). A weak, uncorroborated cover
      // signal here must produce a genuine failure, never a false-positive success.
      return void page(
        "Listing",
        animatedTrigger(
          '<button type="button" id="trigger">View details</button>',
          "var d = document.createElement('div'); d.id = 'unrelated-overlay'; " +
            "d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,0.9)'; " +
            "d.textContent = 'Loading'; document.body.appendChild(d);",
        ),
      );
    }

    if (path === "/weak-signal-with-destination.html") {
      // A real <a href>: the same weak, uncorroborated cover signal as above, but this time
      // a genuine destinationUrl fallback is available and must be the only way this click
      // is ever reported successful.
      return void page(
        "Listing",
        animatedTrigger(
          '<a id="trigger" href="/vehicle-detail.html">View details</a>',
          "var d = document.createElement('div'); d.id = 'unrelated-overlay'; " +
            "d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,0.9)'; " +
            "d.textContent = 'Loading'; document.body.appendChild(d);",
        ),
      );
    }

    if (path === "/vehicle-detail.html") {
      return void page("Vehicle Detail", "<h1>Vehicle Detail</h1><p>Full specification.</p>");
    }

    if (path === "/dialog-signal.html") {
      // The genuine, standards-based overlay-click-detection case that must keep working
      // unchanged: a real role="dialog" surface corroborates the weak cover signal, so this
      // must still short-circuit straight to success without ever touching the fallback.
      return void page(
        "Listing",
        animatedTrigger(
          '<button type="button" id="trigger">View details</button>',
          "var d = document.createElement('div'); d.setAttribute('role', 'dialog'); " +
            "d.setAttribute('aria-modal', 'true'); " +
            "d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5)'; " +
            "d.innerHTML = '<h2>Details</h2><button type=\"button\">Close</button>'; " +
            "document.body.appendChild(d);",
        ),
      );
    }

    if (path === "/bmw-shape-listing.html") {
      // End-to-end replay of the BMW live-site failure shape (run_b5cfde68...): repeated
      // "View details"-style cards whose click handler covers the trigger with an unrelated,
      // non-dialog overlay -- generic, not brand-specific. Each card has its own real
      // destinationUrl, unlike the production run (whose n8n task never enabled the fallback
      // to succeed because of the bug this correction fixes) -- so a correctly-fixed engine
      // must reach a real vehicle-detail page via the fallback in a small, bounded number of
      // steps, rather than looping through repeated false-positive-classified attempts.
      return void page(
        "Search results",
        '<div><h3>Fictional Model Alpha</h3>' +
          animatedTrigger(
            '<a id="trigger" href="/vehicle-detail.html" data-id="alpha">View details</a>',
            "var d = document.createElement('div'); d.className = 'unrelated-overlay'; " +
              "d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,0.9)'; " +
              "d.textContent = 'Loading'; document.body.appendChild(d);",
          ) +
          "</div>",
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

function buildTask(params: { startUrl: string; successCriteria: TaskRequest["successCriteria"] }): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "verified-success-type-gate",
    objective: "Reach the vehicle detail page via the configured listing flow.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: params.successCriteria,
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

// Regression test 1 (BMW investigation report): a transient, uncorroborated overlay must
// never be reported as click success on its own -- with no destinationUrl fallback
// available, this must genuinely fail rather than falsely succeed.
test("REGRESSION 1: a target becoming covered by an unrelated, non-dialog overlay with no destinationUrl available is never reported as a successful click", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/weak-signal-no-destination.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "View details");
    assert.ok(target, "expected the trigger button in the initial observation");

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

    assert.equal(result.success, false, "a weak, uncorroborated cover signal must never report success");
    assert.equal(result.verifiedSuccessType, undefined);
    assert.equal(result.staleTarget, true, "an intercepted click stays eligible for core/loop.ts's bounded stale-target recovery");

    const errors = (captures as { errors?: { message: string; category: string }[] }).errors ?? [];
    const weakSignalDiagnostic = errors.find((e) => /weak, uncorroborated evidence/.test(e.message));
    assert.ok(weakSignalDiagnostic, "expected a diagnostic recording the rejected weak/uncorroborated evidence");
    assert.equal(weakSignalDiagnostic?.category, "stale_target_recovery");
    assert.match(
      result.error ?? "",
      /fallback navigation not attempted \(no_destination_url\)/,
      "expected the returned error to record that no destinationUrl fallback was even eligible",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// Regression test 2 (BMW investigation report): when a genuine destinationUrl fallback is
// available, the same weak/uncorroborated cover signal must fall through to it and recover
// -- reaching the real destination, not looping on the weak signal.
test("REGRESSION 2: the destinationUrl fallback recovers and reaches the real destination when the cover signal is uncorroborated", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/weak-signal-with-destination.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "View details");
    assert.ok(target, "expected the trigger link in the initial observation");

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
    assert.equal(result.resultingUrl, `${baseUrl}/vehicle-detail.html`, "must have actually reached the real destination");
    assert.equal(
      result.verifiedSuccessType,
      "destination_fallback_verified",
      "success must be attributed to the verified fallback, never to the weak cover signal alone",
    );

    const errors = (captures as { errors?: { message: string; category: string }[] }).errors ?? [];
    const weakSignalDiagnostic = errors.find((e) => /weak, uncorroborated evidence/.test(e.message));
    assert.ok(weakSignalDiagnostic, "expected the weak-evidence diagnostic to have fired before the fallback ran");
    const shortcutDiagnostic = errors.some((e) => /reporting success without using the destinationUrl fallback/.test(e.message));
    assert.ok(!shortcutDiagnostic, "must never have taken the corroborated-signal shortcut");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// Regression test 3 (BMW investigation report): the pre-existing, genuine overlay-click-
// detection case (a real dialog corroborates the cover signal) must be preserved exactly --
// still a success, still short-circuiting the fallback, now additionally tagged "dialog".
test("REGRESSION 3 (no regression): a genuine dialog corroborating the cover signal is still reported success without ever using the fallback", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(`${baseUrl}/dialog-signal.html`);
    const observation = await buildObservation(page);
    const target = observation.interactiveElements.find((el) => el.accessibleName === "View details");
    assert.ok(target, "expected the trigger button in the initial observation");

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
    assert.equal(result.clickSideEffectDetected, true);
    assert.equal(result.verifiedSuccessType, "dialog");

    const errors = (captures as { errors?: { message: string } []}).errors ?? [];
    const fallbackAttempted = errors.some((e) => /fallbackNavigationAttempted=true/.test(e.message));
    assert.ok(!fallbackAttempted, "a corroborated dialog signal must still short-circuit the destinationUrl fallback entirely");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// Regression test 6 (BMW investigation report): end-to-end replay of the reported
// production failure shape through the full engine loop -- a repeated-card listing whose
// details click only produces the weak, uncorroborated cover signal must recover via the
// fallback in a small, bounded number of steps rather than looping on false-positive
// "success".
test("REGRESSION 6 (end-to-end BMW-shape replay): the engine reaches the real destination via the fallback, in a bounded number of steps, instead of looping on a false-positive success", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/bmw-shape-listing.html`,
      successCriteria: [
        {
          id: "reached-vehicle-detail",
          type: "url_pattern",
          description: "The vehicle detail page has been reached.",
          config: { pattern: "**/vehicle-detail.html" },
        },
      ],
    });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider("View details") });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/vehicle-detail.html`);
    assert.ok(response.steps.length <= 3, `expected a small, bounded number of steps to recover via the fallback, got ${response.steps.length}`);

    const clickSteps = response.steps.filter((s) => s.selectedAction.type === "click");
    assert.ok(
      clickSteps.every((s) => s.actionResult.success !== true || s.actionResult.verifiedSuccessType !== undefined || s.actionResult.resultingUrl === `${baseUrl}/vehicle-detail.html`),
      "no click step may report an unqualified success on the weak, uncorroborated cover signal alone",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
