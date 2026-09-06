import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { executeTaskAsync, type RunnerBrowser } from "../../src/api/runner.js";
import { createInMemoryTaskStore } from "../../src/api/inMemoryTaskStore.js";
import { checkCgroupMemoryAvailability } from "../../src/config/cgroupMemoryDiagnostic.js";
import { startStaticServer } from "../helpers/staticServer.js";
import type { TaskRequest } from "../../src/types/task-request.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "container-memory-runner-task",
    objective: "Reach an unreachable success state so the memory circuit breaker is exercised.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "unreachable",
        type: "url_pattern",
        description: "A page that is never navigated to in this fixture.",
        config: { pattern: `${startUrl}/unreachable.html` },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 10, maxBacktracks: 0 },
    safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
  };
}

function trackedRealBrowser(): RunnerBrowser {
  let realBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  return {
    async newPage(options) {
      realBrowser = realBrowser ?? (await chromium.launch());
      return realBrowser.newPage(options);
    },
    async close() {
      await realBrowser?.close();
    },
  };
}

/**
 * Exercises the full runner.ts wiring end to end -- real cgroup sampling (via a
 * deliberately tiny MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES override, guaranteed to be
 * exceeded by this process's actual current usage), the resulting abort signal reaching
 * runTask, diagnostics.containerMemory being attached to the completed result, and the
 * sample being persisted via TaskStore.heartbeat. Skips gracefully (not a failure) if
 * this environment doesn't expose readable cgroup memory files at all -- same convention
 * as tests/integration/redisRealServer.test.ts for an unavailable real dependency.
 */
test("executeTaskAsync stops early, attaches diagnostics.containerMemory, and persists a sample via heartbeat", async (t) => {
  if (!checkCgroupMemoryAvailability().available) {
    t.skip("this environment does not expose readable cgroup memory files");
    return;
  }

  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const store = createInMemoryTaskStore(TIMING);
  const runId = "container-memory-runner-run";
  await store.createRun(runId, "container-memory-runner-task");

  const savedEnv = {
    enabled: process.env.MEMORY_CIRCUIT_BREAKER_ENABLED,
    limit: process.env.MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES,
    interval: process.env.MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS,
  };
  process.env.MEMORY_CIRCUIT_BREAKER_ENABLED = "true";
  // A 1-byte limit guarantees this process's real current cgroup usage already exceeds
  // it -- deterministic, no fake filesystem needed.
  process.env.MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES = "1";
  process.env.MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS = "250";

  try {
    await executeTaskAsync(runId, buildTask(`${baseUrl}/start.html`), store, undefined, undefined, undefined, () =>
      Promise.resolve(trackedRealBrowser()),
    );

    const record = await store.getRun(runId);
    assert.equal(record?.status, "completed");
    assert.equal(record?.result?.status, "container_memory_threshold_reached");
    assert.equal(record?.result?.diagnostics.containerMemory?.enabled, true);
    assert.equal(record?.result?.diagnostics.containerMemory?.available, true);
    assert.equal(record?.result?.diagnostics.containerMemory?.breached, true);
    assert.equal(record?.result?.diagnostics.containerMemory?.limitBytes, 1);

    // The heartbeat-persisted sample on the run record itself, independent of the final
    // result -- proving persistence happened during the run, not only at completion.
    assert.equal(record?.latestContainerMemorySample?.breached, true);
  } finally {
    if (savedEnv.enabled === undefined) delete process.env.MEMORY_CIRCUIT_BREAKER_ENABLED;
    else process.env.MEMORY_CIRCUIT_BREAKER_ENABLED = savedEnv.enabled;
    if (savedEnv.limit === undefined) delete process.env.MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES;
    else process.env.MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES = savedEnv.limit;
    if (savedEnv.interval === undefined) delete process.env.MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS;
    else process.env.MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS = savedEnv.interval;
    await close();
  }
});

test("executeTaskAsync leaves diagnostics.containerMemory absent when the breaker is disabled (default)", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const store = createInMemoryTaskStore(TIMING);
  const runId = "container-memory-runner-disabled-run";
  await store.createRun(runId, "container-memory-runner-task");

  const previous = process.env.MEMORY_CIRCUIT_BREAKER_ENABLED;
  delete process.env.MEMORY_CIRCUIT_BREAKER_ENABLED;

  try {
    await executeTaskAsync(runId, buildTask(`${baseUrl}/start.html`), store, undefined, undefined, undefined, () =>
      Promise.resolve(trackedRealBrowser()),
    );

    const record = await store.getRun(runId);
    assert.equal(record?.status, "completed");
    assert.equal(record?.result?.diagnostics.containerMemory, undefined);
    assert.equal(record?.latestContainerMemorySample, undefined);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_CIRCUIT_BREAKER_ENABLED;
    else process.env.MEMORY_CIRCUIT_BREAKER_ENABLED = previous;
    await close();
  }
});
