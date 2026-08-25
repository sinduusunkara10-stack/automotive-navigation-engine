import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * Generic reproductions of the observation -> reasoning -> execution consistency defect:
 * a page observation can generate element ids that are no longer resolvable/actionable by
 * the time the engine is ready to act on them (an async reasoning round trip is enough time
 * for an SPA to re-render, an overlay to appear, or an element to disappear entirely).
 * Nothing here is specific to any website, brand, market, or language -- every route below
 * is synthetic, served from 127.0.0.1 on an ephemeral port, and every reasoning decision
 * comes from a small deterministic fake provider (mirrors tests/integration/actionNavigation.test.ts).
 */
async function startConsistencyFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/done.html") {
      return void page("Done", "<h1>Done</h1>");
    }

    if (path === "/visible-actionable.html") {
      return void page("Start", '<a href="/done.html">Continue</a>');
    }

    if (path === "/hidden-duplicate.html") {
      return void page(
        "Start",
        '<a href="/wrong.html" style="display: none">Duplicate</a>' +
          '<a href="/done.html">Duplicate</a>',
      );
    }

    if (path === "/dom-reorder.html") {
      return void page(
        "Start",
        '<div id="anchor-holder"><a href="/done.html">Continue</a></div>' +
          '<p>Padding paragraph one.</p><p>Padding paragraph two.</p>',
      );
    }

    if (path === "/detach-target.html") {
      return void page("Start", '<a href="/done.html">Continue</a>');
    }

    if (path === "/stale-id.html") {
      return void page("Start", '<a href="/wrong.html">Continue</a>');
    }

    if (path === "/hide-with-no-alternative.html") {
      return void page("Start", '<a href="/done.html">Continue</a>');
    }

    if (path === "/intercepted-overlay.html") {
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="/done.html">Continue</a>',
      );
    }

    if (path === "/pointer-events-none.html") {
      return void page("Start", '<a href="/done.html" style="pointer-events: none">Continue</a>');
    }

    if (path === "/fallback-outside-domain.html") {
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="https://example-not-allowed.invalid/done.html">Continue</a>',
      );
    }

    if (path === "/fallback-unsafe-protocol.html") {
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="javascript:void(0)">Continue</a>',
      );
    }

    if (path === "/disabled-button.html") {
      return void page("Start", "<button disabled>Continue</button>");
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
 * Deterministic fake provider that always targets the first not-yet-clicked element whose
 * accessibleName matches `targetName` in the *current* observation -- exactly like a real
 * model re-evaluating the page each turn, never hardcoding an element id. `onFirstDecide`,
 * when given, runs exactly once, before the first decision is returned, so a test can
 * simulate a page mutating between the observation and the decision being acted on (the
 * async reasoning round trip is exactly when this window opens in production).
 */
class ClickByNameProvider implements ReasoningProvider {
  private mutated = false;
  constructor(
    private readonly page: Page,
    private readonly targetName: string,
    private readonly onFirstDecide?: (page: Page) => Promise<void>,
  ) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.mutated && this.onFirstDecide) {
      this.mutated = true;
      await this.onFirstDecide(this.page);
    }

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
 * A deliberately unsophisticated fake provider: it picks a target once and then keeps
 * re-selecting that exact same id on every subsequent call, even after a fresh
 * observation no longer contains it -- unlike ClickByNameProvider, it never reconsiders.
 * This is what actually exercises core/loop.ts's last-resort behaviour (falling through
 * to the original decision, unchanged, so actions/click.ts's own destinationUrl fallback
 * gets a chance) for a target that goes stale with nothing else to pick instead.
 */
class StubbornClickProvider implements ReasoningProvider {
  private fixedTargetId: string | undefined;
  private mutated = false;
  constructor(
    private readonly page: Page,
    private readonly targetName: string,
    private readonly onFirstDecide: (page: Page) => Promise<void>,
  ) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.mutated) {
      this.mutated = true;
      this.fixedTargetId = context.observation.interactiveElements.find(
        (el) => el.accessibleName === this.targetName,
      )?.id;
      await this.onFirstDecide(this.page);
    }

    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
    }

    if (this.fixedTargetId && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: this.fixedTargetId }, rationale: `Click "${this.targetName}".` };
    }
    return { action: { type: "stop_failure" }, rationale: "No target available." };
  }
}

function buildTask(params: { startUrl: string; successUrlPattern: string }): TaskRequest {
  return {
    schemaVersion: "1.1.0",
    taskId: "action-execution-consistency",
    objective: "Reach the fixture's target page via the configured control.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_target",
        type: "url_pattern",
        description: "The current page URL matches the configured target.",
        config: { pattern: params.successUrlPattern },
      },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 4, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.2.0",
  };
}

test("visible actionable anchor: a normal, uncontested click succeeds", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/visible-actionable.html`, successUrlPattern: `${baseUrl}/done.html` });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    assert.equal(response.captures.errors, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("hidden duplicate anchor: never offered as a reasoning candidate, the visible twin is used instead", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/hidden-duplicate.html`, successUrlPattern: `${baseUrl}/done.html` });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Duplicate") });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);

    const duplicates = response.steps[0]?.observation.interactiveElements.filter((el) => el.accessibleName === "Duplicate");
    assert.equal(duplicates?.length, 1, "the hidden duplicate must never appear in the reasoning candidate set");
    assert.equal(duplicates?.[0]?.destinationUrl, `${baseUrl}/done.html`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("DOM reorder after observation: the same element id keeps resolving to the same node", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/dom-reorder.html`, successUrlPattern: `${baseUrl}/done.html` });
    const reasoning = new ClickByNameProvider(page, "Continue", async (p) => {
      await p.evaluate(() => {
        const holder = document.getElementById("anchor-holder");
        const anchor = holder?.querySelector("a");
        if (anchor) {
          document.body.insertBefore(anchor, document.body.firstChild);
          document.body.appendChild(anchor);
        }
      });
    });

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    assert.equal(response.captures.errors, undefined, "a reorder alone must never require re-observation or a fallback");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("detached element after observation: falls back to the destinationUrl the decision was actually made from", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/detach-target.html`, successUrlPattern: `${baseUrl}/done.html` });
    const reasoning = new StubbornClickProvider(page, "Continue", async (p) => {
      await p.evaluate(() => document.querySelector("a")?.remove());
    });

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    const fallbackWarning = response.captures.errors?.find((e) => e.category === "navigation_failure");
    assert.ok(fallbackWarning, "expected a warning diagnostic recording that the fallback was used");
    assert.equal(fallbackWarning?.severity, "warning");
    assert.equal(fallbackWarning?.recoverable, true);
    assert.match(fallbackWarning?.message ?? "", /fallback/i);
    assert.match(fallbackWarning?.message ?? "", /reObservationAttempted=true/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("stale ID mapping / successful retry after re-observation: a re-rendered element is picked up under its new id", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/stale-id.html`, successUrlPattern: `${baseUrl}/done.html` });
    const reasoning = new ClickByNameProvider(page, "Continue", async (p) => {
      await p.evaluate((newHref) => {
        const stale = document.querySelector("a");
        const replacement = document.createElement("a");
        replacement.href = newHref;
        replacement.textContent = "Continue";
        stale?.replaceWith(replacement);
      }, `${baseUrl}/done.html`);
    });

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    // The original (now-detached) element's id must differ from whatever was actually
    // clicked -- proof the engine re-observed and re-decided rather than reusing a stale id.
    const clickStep = response.steps.find((s) => s.selectedAction.type === "click");
    assert.ok(clickStep);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("failed re-observation: a target that goes stale with no alternative anywhere stops cleanly, not by hanging or crashing", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/hide-with-no-alternative.html`,
      successUrlPattern: `${baseUrl}/unreachable.html`,
    });
    const reasoning = new ClickByNameProvider(page, "Continue", async (p) => {
      await p.evaluate(() => {
        const el = document.querySelector("a");
        if (el) el.style.display = "none";
      });
    });

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.steps.length, 1);
    assert.equal(response.steps[0]?.selectedAction.type, "stop_failure");
    assert.equal(response.diagnostics.finishReason, "stop_failure_action");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("click intercepted by overlay: the target is never blindly clicked, the generic destinationUrl fallback is used instead", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/intercepted-overlay.html`, successUrlPattern: `${baseUrl}/done.html` });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    const fallbackWarning = response.captures.errors?.find((e) => e.category === "navigation_failure");
    assert.ok(fallbackWarning);
    assert.match(fallbackWarning?.message ?? "", /clickErrorCategory=intercepted/);
    assert.match(fallbackWarning?.message ?? "", /fallbackNavigationUsed=true/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("recoverable click failure with allowed-domain URL fallback: a click() that itself times out still recovers", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/pointer-events-none.html`, successUrlPattern: `${baseUrl}/done.html` });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    const fallbackWarning = response.captures.errors?.find((e) => e.category === "navigation_failure");
    assert.ok(fallbackWarning);
    // Proves the *executor's own click attempt* failed first (not the cheaper pre-click
    // revalidation short-circuit): only that code path records the original click error.
    assert.match(fallbackWarning?.message ?? "", /Original click error:/);
    assert.match(fallbackWarning?.message ?? "", /fallbackNavigationUsed=true/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fallback URL outside allowedDomains: the fallback is rejected, not silently followed", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/fallback-outside-domain.html`,
      successUrlPattern: "https://example-not-allowed.invalid/done.html",
    });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "failure");
    assert.equal(response.steps[0]?.currentUrl, `${baseUrl}/fallback-outside-domain.html`);
    const actionFailure = response.captures.errors?.find((e) => e.stoppedRun);
    assert.ok(actionFailure);
    assert.match(actionFailure?.message ?? "", /fallbackRejectedReason=outside_allowed_domains/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("unsafe protocol: a javascript: destinationUrl is never used as a fallback", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/fallback-unsafe-protocol.html`,
      successUrlPattern: `${baseUrl}/never-reached.html`,
    });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "failure");
    assert.equal(response.steps[0]?.currentUrl, `${baseUrl}/fallback-unsafe-protocol.html`);
    const actionFailure = response.captures.errors?.find((e) => e.stoppedRun);
    assert.ok(actionFailure);
    assert.match(actionFailure?.message ?? "", /fallbackRejectedReason=unsafe_protocol/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("disabled button without destinationUrl: fails cleanly with no fallback possible", async () => {
  const { baseUrl, close } = await startConsistencyFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/disabled-button.html`,
      successUrlPattern: `${baseUrl}/never-reached.html`,
    });
    const response = await runTask({ page, task, reasoning: new ClickByNameProvider(page, "Continue") });

    assert.equal(response.status, "failure");
    assert.equal(response.steps[0]?.currentUrl, `${baseUrl}/disabled-button.html`);
    const actionFailure = response.captures.errors?.find((e) => e.stoppedRun);
    assert.ok(actionFailure);
    assert.match(actionFailure?.message ?? "", /hasDestinationUrl=false/);
    assert.match(actionFailure?.message ?? "", /fallbackRejectedReason=no_destination_url/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
