import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Page } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { executeTaskAsync, type RunnerBrowser } from "../../src/api/runner.js";
import { createInMemoryTaskStore } from "../../src/api/inMemoryTaskStore.js";
import { startStaticServer } from "../helpers/staticServer.js";
import type { TaskRequest } from "../../src/types/task-request.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function buildTask(startUrl: string, allowedDomains: string[]): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "runner-cleanup-task",
    objective: "Reach the fixture's success page by following the visible continue control.",
    startUrl,
    allowedDomains,
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        // "**" is this schema's own wildcard syntax (see successEvaluator.ts's
        // matchesUrlPattern, which anchors the whole pattern against the whole URL) --
        // matches regardless of the fixture server's host/port for this test run.
        config: { pattern: "**success.html" },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.9.0",
  };
}

/** Wraps a real Playwright browser so tests can observe/interfere with close() and
 * newPage() without needing a second fake implementation of navigation itself. */
function trackedRealBrowser() {
  const stats = { newPageCalls: 0, closeCalls: 0 };
  let realBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const browser: RunnerBrowser = {
    async newPage() {
      realBrowser = realBrowser ?? (await chromium.launch());
      stats.newPageCalls += 1;
      return realBrowser.newPage();
    },
    async close() {
      stats.closeCalls += 1;
      await realBrowser?.close();
    },
  };
  return { browser, stats };
}

test("a successful run completes the record and closes the browser/page", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  try {
    const store = createInMemoryTaskStore(TIMING);
    const task = buildTask(`${fixtures.baseUrl}/start.html`, ["127.0.0.1"]);
    const { browser, stats } = trackedRealBrowser();

    await store.createRun("run_success", task.taskId);
    await executeTaskAsync("run_success", task, store, undefined, undefined, undefined, () =>
      Promise.resolve(browser),
    );

    const record = await store.getRun("run_success");
    assert.equal(record?.status, "completed");
    assert.equal(record?.result?.status, "success");
    assert.equal(stats.newPageCalls, 1);
    assert.equal(stats.closeCalls, 1, "expected the browser to be closed exactly once after cleanup");
  } finally {
    await fixtures.close();
  }
});

test("a page.close() failure after a successful run does not flip the record to failed (regression test)", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  try {
    const store = createInMemoryTaskStore(TIMING);
    const task = buildTask(`${fixtures.baseUrl}/start.html`, ["127.0.0.1"]);

    const realBrowser = await chromium.launch();
    const browser: RunnerBrowser = {
      async newPage() {
        const page = await realBrowser.newPage();
        // Simulate the exact failure mode the original bug mishandled: cleanup itself
        // fails after a result was already successfully produced.
        const originalClose = page.close.bind(page);
        (page as Page).close = async () => {
          await originalClose().catch(() => {});
          throw new Error("simulated page.close() failure");
        };
        return page;
      },
      async close() {
        await realBrowser.close();
      },
    };

    await store.createRun("run_close_throws", task.taskId);
    await executeTaskAsync("run_close_throws", task, store, undefined, undefined, undefined, () =>
      Promise.resolve(browser),
    );

    const record = await store.getRun("run_close_throws");
    assert.equal(record?.status, "completed", "a page.close() failure must never overwrite a completed run");
    assert.equal(record?.result?.status, "success");
  } finally {
    await fixtures.close();
  }
});

test("a browser launch/newPage failure fails the run and still closes the browser", async () => {
  const store = createInMemoryTaskStore(TIMING);
  const task = buildTask("http://127.0.0.1:1/start.html", ["127.0.0.1"]);
  const stats = { closeCalls: 0 };
  const browser: RunnerBrowser = {
    async newPage() {
      throw new Error("simulated newPage() failure");
    },
    async close() {
      stats.closeCalls += 1;
    },
  };

  await store.createRun("run_launch_throws", task.taskId);
  await executeTaskAsync("run_launch_throws", task, store, undefined, undefined, undefined, () =>
    Promise.resolve(browser),
  );

  const record = await store.getRun("run_launch_throws");
  assert.equal(record?.status, "failed");
  assert.equal(stats.closeCalls, 1, "expected the browser to still be closed after the failure");
});

test("a non-throwing failure result (domain blocked) still completes the record and closes the browser/page", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  try {
    const store = createInMemoryTaskStore(TIMING);
    // startUrl outside allowedDomains -> engine.ts returns a status:"failure" TaskResponse
    // without ever throwing (see core/engine.ts's early domain_blocked return).
    const task = buildTask(`${fixtures.baseUrl}/start.html`, ["example-unrelated-domain.test"]);
    const { browser, stats } = trackedRealBrowser();

    await store.createRun("run_domain_blocked", task.taskId);
    await executeTaskAsync("run_domain_blocked", task, store, undefined, undefined, undefined, () =>
      Promise.resolve(browser),
    );

    const record = await store.getRun("run_domain_blocked");
    assert.equal(record?.status, "completed");
    assert.equal(record?.result?.status, "blocked");
    assert.equal(stats.closeCalls, 1);
  } finally {
    await fixtures.close();
  }
});

test("an initial-navigation timeout still completes the record and closes the browser/page", async () => {
  // A bespoke server that never finishes the HTTP response, forcing initial navigation to
  // time out -- same technique as tests/integration/initialNavigation.test.ts.
  const server: Server = createServer((req, res) => {
    if ((req.url ?? "/").startsWith("/hang")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      // Deliberately never call res.end().
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const store = createInMemoryTaskStore(TIMING);
    const task = buildTask(`${baseUrl}/hang`, ["127.0.0.1"]);
    const { browser, stats } = trackedRealBrowser();

    await store.createRun("run_timeout", task.taskId);
    await executeTaskAsync(
      "run_timeout",
      task,
      store,
      /* initialNavigationTimeoutMs */ 300,
      undefined,
      undefined,
      () => Promise.resolve(browser),
    );

    const record = await store.getRun("run_timeout");
    assert.equal(record?.status, "completed");
    assert.equal(record?.result?.status, "failure");
    assert.equal(stats.closeCalls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
