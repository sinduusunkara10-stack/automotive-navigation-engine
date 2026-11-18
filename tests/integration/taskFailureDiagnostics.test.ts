import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { executeTaskAsync, type RunnerBrowser } from "../../src/api/runner.js";
import { createInMemoryTaskStore } from "../../src/api/inMemoryTaskStore.js";
import { startStaticServer } from "../helpers/staticServer.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "task-failure-diagnostics",
    objective: "Reach a page this fixture never actually provides.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "unreachable",
        type: "url_pattern",
        description: "A page this run never reaches.",
        config: { pattern: "**never-reached.html" },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.53.0",
  };
}

/** A ReasoningProvider that throws on its `callToThrowOn`-th decide() call (1-indexed),
 * returning an ordinary "wait" decision on every call before that -- lets a test put the
 * engine a known number of steps into a run before the underlying failure this diagnostics
 * work is about to log/preserve actually happens. */
function throwingReasoningProvider(callToThrowOn: number, failure: Error): ReasoningProvider {
  let calls = 0;
  return {
    async decide(_context: ReasoningContext): Promise<Decision> {
      calls += 1;
      if (calls === callToThrowOn) {
        throw failure;
      }
      return { action: { type: "wait" }, rationale: "test fixture: waiting before the injected failure." };
    },
  };
}

test("runTask logs and preserves the underlying exception instead of only a generic message", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const originalConsoleError = console.error;
  const loggedCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedCalls.push(args);
  };

  try {
    const task = buildTask(`${fixtures.baseUrl}/start.html`);
    const failure = new Error("simulated reasoning provider failure");

    await assert.rejects(
      runTask({ page, task, reasoning: throwingReasoningProvider(1, failure) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        // The real exception's own message must survive untouched -- never replaced by a
        // generic placeholder.
        assert.equal(error.message, "simulated reasoning provider failure");
        const context = (error as Error & { engineFailureContext?: Record<string, unknown> }).engineFailureContext;
        assert.ok(context, "expected engineFailureContext to be attached to the rethrown error");
        assert.equal(context?.stepCount, 0);
        assert.equal(typeof context?.currentUrl, "string");
        assert.ok((context?.currentUrl as string).includes("start.html"));
        return true;
      },
    );

    assert.ok(loggedCalls.length > 0, "expected console.error to have logged the failure");
    const loggedError = loggedCalls[0]?.find((arg) => arg instanceof Error);
    assert.ok(loggedError instanceof Error && loggedError.message === "simulated reasoning provider failure");
  } finally {
    console.error = originalConsoleError;
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixtures.close();
  }
});

test("runTask's failure context reflects steps already completed before the injected failure", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const task = buildTask(`${fixtures.baseUrl}/start.html`);
    const failure = new Error("simulated failure after one completed step");

    await assert.rejects(
      // Second decide() call throws -- the first ("wait") step completes normally first,
      // so state.stepCount/lastAttemptedAction both reflect real progress by then.
      runTask({ page, task, reasoning: throwingReasoningProvider(2, failure) }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "simulated failure after one completed step");
        const context = (error as Error & { engineFailureContext?: Record<string, unknown> }).engineFailureContext;
        assert.ok(context);
        assert.equal(context?.stepCount, 1);
        const lastAttemptedAction = context?.lastAttemptedAction as { actionType?: string } | undefined;
        assert.equal(lastAttemptedAction?.actionType, "wait");
        return true;
      },
    );
  } finally {
    console.error = originalConsoleError;
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    await fixtures.close();
  }
});

test("a browser launch/newPage failure preserves the underlying error message and stack via the task-status endpoint's errorDetails", async () => {
  const store = createInMemoryTaskStore(TIMING);
  const task = buildTask("http://127.0.0.1:1/start.html");
  const originalConsoleError = console.error;
  const loggedCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    loggedCalls.push(args);
  };

  const browser: RunnerBrowser = {
    async newPage() {
      throw new Error("simulated newPage() failure");
    },
    async close() {},
  };

  try {
    await store.createRun("run_diagnostic_newpage_failure", task.taskId);
    await executeTaskAsync("run_diagnostic_newpage_failure", task, store, undefined, undefined, undefined, () =>
      Promise.resolve(browser),
    );

    const record = await store.getRun("run_diagnostic_newpage_failure");
    assert.equal(record?.status, "failed");
    // The real exception's message is preserved, not replaced by the generic placeholder.
    assert.equal(record?.error, "simulated newPage() failure");
    assert.equal(record?.errorDetails?.taskId, task.taskId);
    assert.ok(record?.errorDetails?.stack?.includes("simulated newPage() failure"));

    assert.ok(loggedCalls.length > 0, "expected console.error to have logged runId/taskId and the exception");
    const loggedText = loggedCalls.map((args) => args.join(" ")).join("\n");
    assert.ok(loggedText.includes("run_diagnostic_newpage_failure"));
    assert.ok(loggedText.includes(task.taskId));
  } finally {
    console.error = originalConsoleError;
  }
});
