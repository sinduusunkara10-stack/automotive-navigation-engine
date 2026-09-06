import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Exercises the loop-level mechanism directly (runTask's isMemoryThresholdBreached
 * param) rather than the full runner.ts wiring (sampling interval + real cgroup files +
 * Redis persistence, covered separately by tests/unit/containerMemoryGuard.test.ts and
 * tests/unit/containerMemoryCircuitBreakerConfig.test.ts). This proves the actual
 * safety-critical behavior: a breached signal stops the run safely, at the same
 * checkpoint maxSteps/maxBacktracks/maxDuration already use, preserving whatever journey
 * evidence had already been captured -- see src/core/loop.ts.
 */
test("a breached memory threshold stops the run safely and preserves partial evidence", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.10.0",
      taskId: "container-memory-breach-task",
      objective: "Reach an unreachable success state so the memory circuit breaker is exercised instead.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/unreachable.html` },
        },
      ],
      captureModules: ["page_visits", "journey_path", "errors"],
      limits: { maxSteps: 10, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
      outputSchemaVersion: "1.9.0",
    };

    const response = await runTask({ page, task, isMemoryThresholdBreached: () => true });

    assert.equal(response.status, "container_memory_threshold_reached");
    assert.equal(response.statusReason, "container_memory_threshold");
    assert.equal(response.diagnostics.finishReason, "container_memory_threshold");
    // The breach fires on the very first step (before any real action is dispatched), so
    // exactly one stepLog is produced -- proving the loop stopped immediately rather than
    // continuing to spend steps once already breached.
    assert.equal(response.steps.length, 1);
    assert.deepEqual(response.steps[0]?.safetyFlags, ["container_memory_threshold"]);
    assert.equal(response.steps[0]?.selectedAction.type, "stop_failure");

    // Evidence captured before the stop is preserved, not discarded.
    assert.ok(response.captures.journey_path && response.captures.journey_path.length > 0);
    const limitStopErrors = (response.captures.errors ?? []).filter((e) => e.category === "limit_stop");
    assert.equal(limitStopErrors.length, 1);
    assert.match(limitStopErrors[0]!.message, /container memory circuit breaker/i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("without a breach signal, the same task proceeds normally (no false positives)", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.10.0",
      taskId: "container-memory-no-breach-task",
      objective: "Reach an unreachable success state so the step ceiling is exercised instead of the breaker.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/unreachable.html` },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
      outputSchemaVersion: "1.9.0",
    };

    const response = await runTask({ page, task, isMemoryThresholdBreached: () => false });

    assert.equal(response.status, "max_steps_reached", "an always-false breaker must never affect the run");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
