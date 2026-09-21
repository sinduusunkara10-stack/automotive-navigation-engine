import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { RouteMemoryCandidateSummary } from "../../src/types/routeMemory.js";

/**
 * Route-progress classification fix (see CLAUDE.md and docs/architecture.md §18): a
 * successful click/navigate candidate's Route Memory outcome ("advanced" vs "no_change")
 * must no longer be classified purely from a URL/title diff -- an unverified generic
 * destinationUrl fallback (a same-document hash-only navigation) can produce that diff
 * without the site's own click handler ever having run. These tests drive the real engine
 * end to end (mirrors tests/integration/routeMemory.test.ts's own pattern) and inspect what
 * ReasoningContext.routeMemory actually shows the reasoning layer on a later visit to the
 * exact same decision point.
 *
 * No brand/market/CTA-specific wording anywhere in this file, per CLAUDE.md's non-negotiable
 * design rule; every route is synthetic, served from 127.0.0.1 on an ephemeral port.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/unverified-fallback-start.html") {
      // A permanent, full-viewport transparent overlay makes the anchor unactionable from
      // the very first read -- exactly like tests/integration/actionExecutionConsistency
      // .test.ts's own /intercepted-overlay.html fixture -- forcing the generic
      // destinationUrl fallback. The anchor's href is hash-only on the *same* page, and
      // nothing on this page reacts to the hash at all, so the fallback can never produce
      // any verified evidence of progress.
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="#detail">View Details</a>',
      );
    }

    if (path === "/async-dialog-start.html") {
      return void page(
        "Start",
        '<button type="button" id="open">Open Panel</button>' +
          "<script>" +
          "document.getElementById('open').addEventListener('click', function () {" +
          "  setTimeout(function () {" +
          "    var d = document.createElement('div');" +
          "    d.setAttribute('role', 'dialog');" +
          "    d.setAttribute('aria-modal', 'true');" +
          "    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5)';" +
          "    d.innerHTML = '<button type=\"button\" id=\"close\">Close</button>';" +
          "    document.body.appendChild(d);" +
          "    document.getElementById('close').addEventListener('click', function () { d.remove(); });" +
          "  }, 60);" +
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
 * Deterministic fake provider: click a named candidate, go back exactly once its outcome
 * has actually been recorded, then re-propose the same click exactly once more so the test
 * can inspect the routeMemory context the reasoning layer sees on that revisit.
 *
 * Driven off `context.routeMemory`'s own recorded `attempts` count for the candidate
 * (real-dispatch evidence), never a blind step counter -- core/loop.ts's own pre-dispatch
 * revalidation (see MAX_STALE_TARGET_RECOVERY_ATTEMPTS in core/loop.ts) can call a
 * provider's decide() an extra time, with a fresh observation, before a decision is
 * actually dispatched, whenever the chosen target isn't immediately actionable (exactly the
 * case for a permanently-covered target in the fixture below) -- a rigid, cursor-based
 * script would get desynchronised by that extra call and propose the wrong action out of
 * order. Idempotently re-proposing "click the target" until routeMemory confirms it was
 * actually dispatched is robust to any number of such extra calls.
 */
class ScriptedRouteMemoryProvider implements ReasoningProvider {
  readonly routeMemorySeen: Array<RouteMemoryCandidateSummary[] | undefined> = [];
  /** The exact routeMemory context seen at the decide() call that proposed the revisit click -- what the test actually inspects. */
  revisitRouteMemorySnapshot: RouteMemoryCandidateSummary[] | undefined;
  private wentBack = false;

  constructor(private readonly targetName: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const snapshot = context.routeMemory ? context.routeMemory.map((c) => ({ ...c })) : undefined;
    this.routeMemorySeen.push(snapshot);

    const target = context.observation.interactiveElements.find((el) => el.accessibleName === this.targetName);
    const entry = context.routeMemory?.find((c) => c.label.includes(this.targetName));
    const attempts = entry?.attempts ?? 0;

    if (target && attempts === 0 && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: target.id }, rationale: `First attempt at "${this.targetName}".` };
    }
    if (attempts >= 1 && !this.wentBack && context.allowedActions.includes("go_back")) {
      this.wentBack = true;
      return { action: { type: "go_back" }, rationale: "Returning to the same decision point." };
    }
    if (this.wentBack && target && attempts === 1 && context.allowedActions.includes("click")) {
      this.revisitRouteMemorySnapshot = snapshot;
      return { action: { type: "click", target: target.id }, rationale: `Revisit attempt at "${this.targetName}".` };
    }
    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "Script exhausted." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

/**
 * Companion provider for the async-dialog fixture: opens the panel, closes it once the
 * dialog's own Close control appears, then re-opens it once more so the test can inspect
 * the routeMemory context surfaced on that revisit -- driven off live observation state
 * (which control is currently present) and routeMemory's own recorded attempts count,
 * never a blind step counter, for the same robustness reasons as ScriptedRouteMemoryProvider
 * above.
 */
class AsyncDialogProvider implements ReasoningProvider {
  revisitRouteMemorySnapshot: RouteMemoryCandidateSummary[] | undefined;

  async decide(context: ReasoningContext): Promise<Decision> {
    const snapshot = context.routeMemory ? context.routeMemory.map((c) => ({ ...c })) : undefined;

    const closeButton = context.observation.interactiveElements.find((el) => el.accessibleName === "Close");
    if (closeButton && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: closeButton.id }, rationale: "Closing the panel." };
    }

    const openPanel = context.observation.interactiveElements.find((el) => el.accessibleName === "Open Panel");
    const entry = context.routeMemory?.find((c) => c.label.includes("Open Panel"));
    const attempts = entry?.attempts ?? 0;
    if (openPanel && attempts < 2 && context.allowedActions.includes("click")) {
      if (attempts === 1) {
        this.revisitRouteMemorySnapshot = snapshot;
      }
      return { action: { type: "click", target: openPanel.id }, rationale: "Opening the panel." };
    }

    if (context.allowedActions.includes("stop_failure")) {
      return { action: { type: "stop_failure" }, rationale: "Script exhausted." };
    }
    return { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function buildTask(params: { startUrl: string; maxBacktracks?: number }): TaskRequest {
  return {
    schemaVersion: "1.22.0",
    taskId: "route-progress-classification",
    objective: "Exercise the configured controls; this suite only inspects routeMemory context, never final status.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "never_reached",
        type: "url_pattern",
        description: "A pattern this fixture never satisfies -- forces the script to run to exhaustion.",
        config: { pattern: "http://127.0.0.1/never-reached.html" },
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 8, maxBacktracks: params.maxBacktracks ?? 1, maxRepeatedActions: 5 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.23.0",
  };
}

test("an unverified same-document destinationUrl fallback (hash-only, no meaningful state change) is never classified as 'advanced', and -- since the fixture provides no way to ever verify it -- the action itself now correctly fails rather than reporting silent progress", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/unverified-fallback-start.html`, maxBacktracks: 1 });
    const provider = new ScriptedRouteMemoryProvider("View Details");
    const response = await runTask({ page, task, reasoning: provider });

    // Target-attributable click-success fix (superseding this test's original premise): this
    // fixture's anchor is permanently covered by a transparent overlay and nothing on the
    // page ever reacts to its hash -- by the fixture's own design, its destinationUrl
    // fallback can *never* produce target-attributable evidence. Before that fix, such a
    // fallback still reported success (unverified only for route-memory purposes), so a
    // scripted revisit could eventually happen; now the click correctly fails outright every
    // time (never "advanced", never even a completed action), so the run exhausts the
    // bounded stale-target recovery allowance instead of ever reaching a revisit. This is a
    // strictly stronger form of the same guarantee the original test asserted: an unverified
    // hash-only fallback can never be mistaken for progress, in route memory or anywhere else.
    assert.equal(response.status, "failure");
    assert.equal(response.statusReason, "stale_target_recovery_exhausted");
    assert.ok(
      !provider.revisitRouteMemorySnapshot,
      "no revisit can ever happen for a candidate whose fallback can never be verified -- the run must fail safely first",
    );

    // Route Memory's "advanced"/"no_change" classification (core/loop.ts) is only ever
    // recorded for a *successful* action -- and this candidate's action now never succeeds
    // at all (every attempt fails as staleTarget, per the comment above), so it correctly
    // never reaches that classification step in the first place. This is a strictly
    // stronger guarantee than the original "recorded as no_change, not advanced" assertion:
    // there is no route-memory entry that could ever be misread as progress, because no
    // outcome for this candidate is ever recorded as anything but a failure.
    const anyRouteMemoryObservationOfCandidate = provider.routeMemorySeen.some((snapshot) =>
      snapshot?.some((c) => c.label.includes("View Details")),
    );
    assert.ok(
      !anyRouteMemoryObservationOfCandidate,
      "a candidate whose action always fails must never acquire a routeMemory entry at all, let alone an 'advanced' one",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a click that produces no URL change but a verified async dialog side effect IS classified as 'advanced' when the same decision point recurs", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/async-dialog-start.html`, maxBacktracks: 0 });
    const provider = new AsyncDialogProvider();
    await runTask({ page, task, reasoning: provider });

    const onRevisit = provider.revisitRouteMemorySnapshot;
    assert.ok(onRevisit, "expected the revisit to actually happen");
    const candidate = onRevisit?.find((c) => c.label.includes("Open Panel"));
    assert.ok(candidate, "expected the 'Open Panel' candidate to be present in routeMemory");
    assert.equal(
      candidate?.lastOutcome,
      "advanced",
      "generic post-click evidence of a new interaction surface must count as progress even with no URL change at all",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
