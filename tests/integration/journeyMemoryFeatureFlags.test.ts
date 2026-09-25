import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";

/**
 * Persistent Cross-Run Journey Memory feature flags (binding contract §8): with
 * JOURNEY_MEMORY_ENABLED unset (the default, and every existing task/test's environment),
 * the feature must be a complete rollback -- no journeyMemory diagnostics field, and no
 * behavioural difference from before this feature existed. No brand/market/CTA-specific
 * wording anywhere in this file, per CLAUDE.md's non-negotiable design rule; the fixture
 * server is entirely synthetic, on 127.0.0.1/an ephemeral port.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
    if (path === "/start.html") return void page("Start", '<a href="/done.html">Continue</a>');
    if (path === "/done.html") return void page("Done", "<h1>Done</h1>");
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Failed to determine fixture server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "journey-memory-flags",
    objective: "Reach the done page.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [{ id: "reached_done", type: "url_pattern", description: "URL matches done.", config: { pattern: `${startUrl.replace("/start.html", "/done.html")}` } }],
    captureModules: [],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

test("with JOURNEY_MEMORY_ENABLED unset, diagnostics.journeyMemory is entirely absent (complete rollback)", async () => {
  const originalEnv = { ...process.env };
  delete process.env.JOURNEY_MEMORY_ENABLED;
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const response = await runTask({ page, task: buildTask(`${baseUrl}/start.html`), reasoning: new MockReasoningProvider() });
    assert.equal(response.status, "success");
    assert.equal(response.diagnostics.journeyMemory, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
    process.env = originalEnv;
  }
});

test("with JOURNEY_MEMORY_ENABLED=true but no REDIS_URL, the run still succeeds and reports storage unavailable rather than throwing", async () => {
  const originalEnv = { ...process.env };
  process.env.JOURNEY_MEMORY_ENABLED = "true";
  delete process.env.REDIS_URL;
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const response = await runTask({ page, task: buildTask(`${baseUrl}/start.html`), reasoning: new MockReasoningProvider() });
    assert.equal(response.status, "success");
    assert.ok(response.diagnostics.journeyMemory);
    assert.equal(response.diagnostics.journeyMemory?.storageAvailable, false);
    assert.equal(response.diagnostics.journeyMemory?.unavailableReason, "storage_unavailable");
  } finally {
    await page.close();
    await browser.close();
    await close();
    process.env = originalEnv;
  }
});
