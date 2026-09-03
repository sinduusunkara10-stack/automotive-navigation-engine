import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";

/**
 * A bespoke local server (not tests/helpers/staticServer.ts) because these tests need to
 * deliberately hang mid-response -- something a plain "read a fixture file and respond"
 * static server can't do. Nothing here ever touches a real website; every route is
 * synthetic and served from 127.0.0.1 on an ephemeral port.
 */
async function startHangingServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/hang-forever.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      // Never call res.end(): this subresource never finishes loading, so a "load"-style
      // wait condition would hang, but domcontentloaded doesn't depend on it.
      return;
    }

    if (path === "/with-hanging-image.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        "<!doctype html><html><head><title>Hanging Image</title></head><body>" +
          '<h1>Welcome</h1><a href="/done.html" id="continue-link">Continue</a>' +
          '<img src="/hang-forever.png" /></body></html>',
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

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine hanging server address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function buildTask(params: { startUrl: string; successUrl: string; captureModules?: TaskRequest["captureModules"] }): TaskRequest {
  return {
    schemaVersion: "1.5.0",
    taskId: "initial-navigation-robustness",
    objective: "Reach the fixture's done page by following the visible continue control.",
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_done_page",
        type: "url_pattern",
        description: "The current page URL matches the done fixture.",
        config: { pattern: params.successUrl },
      },
    ],
    captureModules: params.captureModules ?? ["errors"],
    limits: { maxSteps: 3, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.5.0",
  };
}

test("initial navigation waits only for domcontentloaded: a never-finishing subresource does not block the run", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/with-hanging-image.html`, successUrl: `${baseUrl}/done.html` });

    const started = Date.now();
    const response = await runTask({ page, task, initialNavigationTimeoutMs: 5000 });
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/done.html`);
    assert.notEqual(response.diagnostics.finishReason, "initial_navigation_error");
    // The hanging <img> never resolves; if the engine were still waiting on "load" (or
    // networkidle) this run could not finish well within the 5000ms initial-navigation
    // budget, let alone the full test timeout.
    assert.ok(elapsedMs < 4000, `expected the run to finish quickly, took ${elapsedMs}ms`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a page.goto timeout with a usable partial DOM is treated as a recoverable timeout and the run continues", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/usable-partial-hang.html`, successUrl: `${baseUrl}/done.html` });

    const response = await runTask({ page, task, initialNavigationTimeoutMs: 500 });

    // The fixture never finishes its document, so the run can't reach success -- what
    // matters is that the engine didn't give up before observing/deciding at all.
    assert.notEqual(response.diagnostics.finishReason, "initial_navigation_error");
    assert.ok(response.steps.length >= 1, "expected the loop to run at least one step after recovery");
    assert.equal(response.steps[0]?.observation.title, "Partial");

    const navFailures = response.captures.errors?.filter((e) => e.category === "navigation_failure") ?? [];
    assert.equal(navFailures.length, 1);
    assert.equal(navFailures[0]?.severity, "warning");
    assert.equal(navFailures[0]?.recoverable, true);
    assert.equal(navFailures[0]?.stoppedRun, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a page.goto timeout with no usable document still fails as a critical initial navigation error", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/blank-hang.html`, successUrl: `${baseUrl}/done.html` });

    const response = await runTask({ page, task, initialNavigationTimeoutMs: 500 });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "initial_navigation_error");
    assert.equal(response.steps.length, 0);

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

test("INITIAL_NAVIGATION_TIMEOUT_MS is honoured end to end when no explicit override is passed", async () => {
  const { baseUrl, close } = await startHangingServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const previousEnvValue = process.env.INITIAL_NAVIGATION_TIMEOUT_MS;
  process.env.INITIAL_NAVIGATION_TIMEOUT_MS = "500";

  try {
    const task = buildTask({ startUrl: `${baseUrl}/blank-hang.html`, successUrl: `${baseUrl}/done.html` });

    const started = Date.now();
    const response = await runTask({ page, task });
    const elapsedMs = Date.now() - started;

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "initial_navigation_error");
    // With the default 30000ms this run would take far longer; a ~500ms override proves
    // the environment variable actually reached the engine.
    assert.ok(elapsedMs < 5000, `expected the env-configured 500ms timeout to apply, took ${elapsedMs}ms`);
  } finally {
    if (previousEnvValue === undefined) {
      delete process.env.INITIAL_NAVIGATION_TIMEOUT_MS;
    } else {
      process.env.INITIAL_NAVIGATION_TIMEOUT_MS = previousEnvValue;
    }
    await page.close();
    await browser.close();
    await close();
  }
});
