import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * A bespoke local server (not tests/helpers/staticServer.ts), mirroring
 * tests/integration/initialNavigation.test.ts, because these tests need routes that
 * deliberately hang mid-response, and a redirect off allowedDomains. Nothing here ever
 * touches a real website or makes a real Claude API call -- every route is synthetic and
 * served from 127.0.0.1/localhost on an ephemeral port, and every reasoning decision
 * below comes from a small deterministic fake provider.
 */
async function startHangingServer(): Promise<{ baseUrl: string; port: number; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const port = (server.address() as { port: number }).port;

    if (path === "/start.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        "<!doctype html><html><head><title>Start</title></head><body>" +
          '<h1>Start</h1><a href="/with-hanging-image.html" id="slow-usable-link">Go slow-usable</a>' +
          '<a href="/blank-hang.html" id="slow-blank-link">Go slow-blank</a>' +
          '<a href="/usable-partial-hang.html" id="slow-partial-link">Go slow-partial</a>' +
          '<a href="/redirect-to-disallowed.html" id="redirect-link">Go redirect</a>' +
          '<button type="button" id="no-nav-button">No navigation</button></body></html>',
      );
      return;
    }

    if (path === "/hang-forever.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      // Never call res.end(): this subresource never finishes loading, so a "load"-style
      // wait condition would hang, but domcontentloaded doesn't depend on it.
      return;
    }

    if (path === "/with-hanging-image.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        "<!doctype html><html><head><title>Hanging Image</title></head><body>" +
          '<h1>Welcome</h1><img src="/hang-forever.png" /></body></html>',
      );
      return;
    }

    if (path === "/done.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><html><head><title>Done</title></head><body><h1>Done</h1></body></html>");
      return;
    }

    if (path === "/usable-partial-hang.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write(
        "<!doctype html><html><head><title>Partial</title></head><body>" +
          '<h1>Partially rendered</h1><button id="cta">Continue</button>',
      );
      // Deliberately never finish the document: the parser never reaches EOF, so
      // domcontentloaded can never fire, even though a usable partial DOM already exists.
      return;
    }

    if (path === "/blank-hang.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head>");
      // Hangs before any title or body content is ever emitted.
      return;
    }

    if (path === "/redirect-to-disallowed.html") {
      // Redirects to a different hostname (localhost, not 127.0.0.1) so it lands outside
      // allowedDomains=["127.0.0.1"] even though it resolves to the same loopback
      // interface -- no real external network access involved.
      res.writeHead(302, { Location: `http://localhost:${port}/landed-disallowed.html` }).end();
      return;
    }

    if (path === "/landed-disallowed.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><html><head><title>Disallowed</title></head><body><h1>Disallowed</h1></body></html>");
      return;
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine hanging server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

/** Navigates to a fixed target URL on the first decision, then stops based on criteria. */
class NavigateOnceProvider implements ReasoningProvider {
  private navigated = false;
  constructor(private readonly targetUrl: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.navigated) {
      this.navigated = true;
      return { action: { type: "navigate", target: this.targetUrl }, rationale: "Navigate to the configured target." };
    }
    return finalDecision(context);
  }
}

/** Clicks a fixed, named element on the first decision, then stops based on criteria. */
class ClickOnceProvider implements ReasoningProvider {
  private clicked = false;
  constructor(private readonly accessibleName: string) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      this.clicked = true;
      const target = context.observation.interactiveElements.find((el) => el.accessibleName === this.accessibleName);
      if (!target) {
        throw new Error(`Fixture element "${this.accessibleName}" not found in observation`);
      }
      return { action: { type: "click", target: target.id }, rationale: `Click "${this.accessibleName}".` };
    }
    return finalDecision(context);
  }
}

function finalDecision(context: ReasoningContext): Decision {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
  if (allSatisfied && context.allowedActions.includes("stop_success")) {
    return { action: { type: "stop_success" }, rationale: "Success criteria satisfied." };
  }
  return { action: { type: "stop_failure" }, rationale: "Success criteria not satisfied." };
}

function buildTask(params: {
  startUrl: string;
  successUrlPattern: string;
  allowedActions: TaskRequest["safety"]["allowedActions"];
}): TaskRequest {
  return {
    schemaVersion: "1.8.0",
    taskId: "action-navigation-reliability",
    objective: "Reach the fixture's target page via the configured action.",
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
    safety: { allowedActions: params.allowedActions },
    outputSchemaVersion: "1.7.0",
  };
}

test("navigate action waits only for domcontentloaded: a never-finishing subresource does not block it", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/with-hanging-image.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/with-hanging-image.html`);

    const started = Date.now();
    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 5000 });
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, "success");
    assert.equal(response.steps[0]?.actionResult.success, true);
    assert.equal(response.steps[0]?.actionResult.resultingUrl, `${baseUrl}/with-hanging-image.html`);
    // The hanging <img> never resolves; if the action were still waiting on "load" this
    // run could not finish well within the 5000ms action-navigation budget.
    assert.ok(elapsedMs < 4000, `expected the run to finish quickly, took ${elapsedMs}ms`);

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.equal(navFailures.length, 0, "domcontentloaded should be reached without needing timeout recovery");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a click causing document navigation also waits only for domcontentloaded", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/with-hanging-image.html`,
      allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new ClickOnceProvider("Go slow-usable");

    const started = Date.now();
    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 5000 });
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, "success");
    assert.equal(response.steps[0]?.actionResult.resultingUrl, `${baseUrl}/with-hanging-image.html`);
    assert.ok(elapsedMs < 4000, `expected the run to finish quickly, took ${elapsedMs}ms`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a click that triggers no navigation does not pay the action-navigation timeout budget", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/never-reached.html`,
      allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new ClickOnceProvider("No navigation");

    const started = Date.now();
    // No override: uses the real default (30000ms). If a non-navigating click paid that
    // full budget, this assertion below would fail well before the process could finish.
    const response = await runTask({ page, task, reasoning });
    const elapsedMs = Date.now() - started;

    assert.equal(response.steps[0]?.actionResult.success, true);
    assert.equal(response.steps[0]?.actionResult.resultingUrl, `${baseUrl}/start.html`);
    assert.ok(elapsedMs < 4000, `expected a non-navigating click to resolve quickly, took ${elapsedMs}ms`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("ACTION_NAVIGATION_TIMEOUT_MS is honoured end to end when no explicit override is passed", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const previousEnvValue = process.env.ACTION_NAVIGATION_TIMEOUT_MS;
  process.env.ACTION_NAVIGATION_TIMEOUT_MS = "500";

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/done.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/blank-hang.html`);

    const started = Date.now();
    const response = await runTask({ page, task, reasoning });
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "action_execution_error");
    // With the default 30000ms this run would take far longer; a ~500ms override proves
    // the environment variable actually reached the engine's action-navigation timeout.
    assert.ok(elapsedMs < 5000, `expected the env-configured 500ms timeout to apply, took ${elapsedMs}ms`);
  } finally {
    if (previousEnvValue === undefined) {
      delete process.env.ACTION_NAVIGATION_TIMEOUT_MS;
    } else {
      process.env.ACTION_NAVIGATION_TIMEOUT_MS = previousEnvValue;
    }
    await page.close();
    await browser.close();
    await close();
  }
});

test("a navigate timeout with a usable partial DOM recovers, records a warning, and satisfies the criterion at the actual URL", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/usable-partial-hang.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/usable-partial-hang.html`);

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 500 });

    assert.equal(response.status, "success", "a recoverable timeout at the actual target URL must satisfy the criterion");
    assert.equal(response.steps[0]?.actionResult.success, true);
    assert.equal(response.steps[0]?.actionResult.resultingUrl, `${baseUrl}/usable-partial-hang.html`);
    assert.ok(response.steps[0]?.progress.satisfiedCriteriaIds.includes("reached_target"));

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.equal(navFailures.length, 1);
    assert.equal(navFailures[0]?.severity, "warning");
    assert.equal(navFailures[0]?.recoverable, true);
    assert.equal(navFailures[0]?.stoppedRun, false);
    assert.equal(navFailures[0]?.actionType, "navigate");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a click navigation timeout with a usable partial DOM also recovers safely", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/usable-partial-hang.html`,
      allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new ClickOnceProvider("Go slow-partial");

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 500 });

    assert.equal(response.status, "success");
    assert.equal(response.steps[0]?.actionResult.resultingUrl, `${baseUrl}/usable-partial-hang.html`);

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.equal(navFailures.length, 1);
    assert.equal(navFailures[0]?.severity, "warning");
    assert.equal(navFailures[0]?.actionType, "click");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a navigate timeout with no usable document fails the action and does not satisfy any criterion", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/done.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/blank-hang.html`);

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 500 });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "action_execution_error");
    assert.equal(response.steps[0]?.actionResult.success, false);
    // The requested target (done.html) was never reached -- the criterion must not be
    // satisfied just because a navigate action was attempted toward some other URL.
    assert.deepEqual(response.steps[0]?.progress.satisfiedCriteriaIds, []);

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.equal(navFailures.length, 1);
    assert.equal(navFailures[0]?.severity, "critical");
    assert.equal(navFailures[0]?.recoverable, false);
    assert.equal(navFailures[0]?.stoppedRun, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a navigate target outside allowedDomains is blocked before navigating, leaving the current URL unchanged and the criterion unsatisfied", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: "http://localhost:1/blocked-target.html",
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider("http://localhost:1/blocked-target.html");

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 2000 });

    // The safety layer rejects an out-of-allowedDomains navigate target before it ever
    // reaches Playwright, forcing a stop_blocked in its place -- so no navigation is ever
    // attempted, the current URL never moves off the fixture's start page, and a
    // criterion for the blocked target must not be satisfied.
    assert.equal(response.status, "blocked");
    assert.equal(response.steps[0]?.selectedAction.type, "stop_blocked");
    assert.ok(response.steps[0]?.safetyFlags?.includes("domain_blocked"));
    assert.equal(response.steps[0]?.currentUrl, `${baseUrl}/start.html`);
    assert.deepEqual(response.steps[0]?.progress.satisfiedCriteriaIds, []);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a successful navigate action to the actual resulting URL satisfies the criterion", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/done.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/done.html`);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    assert.equal(response.steps[0]?.actionResult.success, true);
    assert.ok(response.steps[0]?.progress.satisfiedCriteriaIds.includes("reached_target"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a disallowed redirect after a navigate action is blocked, not silently followed", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/landed-disallowed.html`,
      allowedActions: ["navigate", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new NavigateOnceProvider(`${baseUrl}/redirect-to-disallowed.html`);

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 5000 });

    assert.equal(response.status, "failure");
    assert.equal(response.steps[0]?.actionResult.success, false);
    assert.match(response.steps[0]?.actionResult.error ?? "", /allowedDomains/);

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.ok(navFailures.length >= 1);
    assert.equal(navFailures[0]?.severity, "critical");
    assert.equal(navFailures[0]?.recoverable, false);
    assert.equal(navFailures[0]?.stoppedRun, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a disallowed redirect after a click is blocked, not silently followed", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({
      startUrl: `${baseUrl}/start.html`,
      successUrlPattern: `${baseUrl}/landed-disallowed.html`,
      allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
    });
    const reasoning = new ClickOnceProvider("Go redirect");

    const response = await runTask({ page, task, reasoning, actionNavigationTimeoutMs: 5000 });

    assert.equal(response.status, "failure");
    assert.equal(response.steps[0]?.actionResult.success, false);
    assert.match(response.steps[0]?.actionResult.error ?? "", /allowedDomains/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
