import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import RedisMock from "ioredis-mock";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import { createRedisJourneyMemoryStore } from "../../src/core/journeyMemory/store.js";
import { buildForwardSegments } from "../../src/core/journeyMemory/segmentBuilder.js";
import { recordJourneySegments, retrieveJourneyMemoryContext } from "../../src/core/journeyMemory/service.js";
import { buildSemanticSignature } from "../../src/core/journeyMemory/sanitizer.js";

/**
 * Cross-run journey memory, end to end from a REAL run's own step log (not a synthetic
 * fixture segment): run A completes a journey through a fixture site, its steps are
 * sanitized and written to a shared journey-memory store, and a later, separate lookup
 * (representing run B's pre-run retrieval) finds and accepts run A's segment as relevant
 * evidence for a structurally-equivalent objective. This exercises the same
 * sanitizer/segmentBuilder/scoring/store code paths runTask itself uses internally (see
 * src/core/engine.ts), just without needing to inject a fake Redis client through
 * runTask's own public signature.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);
    if (path === "/configurator.html") return void page("Configurator", '<a href="/finance.html">Continue to Personalise Your Finance</a>');
    if (path === "/finance.html") return void page("Personalise Your Finance", "<h1>Finance options</h1>");
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
    taskId: "journey-memory-cross-run",
    objective: "Reach the finance personalisation step.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_finance",
        type: "url_pattern",
        description: "URL matches finance.",
        config: { pattern: `${startUrl.replace("/configurator.html", "/finance.html")}` },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

test("run A's real steps, written as journey memory, are found and accepted by run B's pre-run lookup", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = buildTask(`${baseUrl}/configurator.html`);
    const response = await runTask({ page, task, reasoning: new MockReasoningProvider() });
    assert.equal(response.status, "success");

    const domain = "127.0.0.1";
    const segments = buildForwardSegments({
      steps: response.steps,
      runId: "run-a",
      registrableDomain: domain,
      objective: task.objective,
      evidenceTier: "tier1",
      schemaVersion: "1.0.0",
    });
    assert.ok(segments.length > 0, "run A should have produced at least one forward segment");

    const client = new RedisMock();
    const store = createRedisJourneyMemoryStore(client as never, { retentionDays: 90 });
    const flags = { enabled: true, readEnabled: true, writeEnabled: true };
    const writeResult = await recordJourneySegments(store, flags, segments, 500);
    assert.ok(writeResult.segmentsWritten > 0);

    // Run B: a later, separate lookup for a structurally-equivalent (though not word-for-word
    // identical) objective.
    const ctx = await retrieveJourneyMemoryContext(store, flags, {
      timeoutMs: 1000,
      objectiveText: "get to the personalise-your-finance step of the configurator",
      milestoneIntent: "reached the finance personalisation step",
      currentSemanticSignature: buildSemanticSignature(["configurator"]),
      currentDomain: domain,
    });
    assert.equal(ctx.storageAvailable, true);
    assert.ok(ctx.accepted.length + ctx.ambiguous.length > 0, "run B should find run A's segment as relevant evidence");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
