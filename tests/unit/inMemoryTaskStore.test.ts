import { test } from "node:test";
import assert from "node:assert/strict";

import { createInMemoryTaskStore } from "../../src/api/inMemoryTaskStore.js";
import { WORKER_ID } from "../../src/api/workerIdentity.js";
import type { TaskResponse } from "../../src/types/task-response.js";

const DEFAULT_TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function fakeResult(): TaskResponse {
  return {
    schemaVersion: "1.8.0",
    taskId: "task-store-test",
    status: "success",
    statusReason: "stop_success_action",
    startUrl: "http://127.0.0.1/start.html",
    finalUrl: "http://127.0.0.1/success.html",
    steps: [],
    captures: {},
    engineAssessment: { objectiveAchieved: true, confidence: 1, summary: "done" },
    diagnostics: { stepCount: 0, backtrackCount: 0, totalDurationMs: 0, finishReason: "stop_success_action" },
  };
}

test("getRun on an unknown runId returns undefined (the API layer turns this into 404)", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  assert.equal(await store.getRun("run_does-not-exist"), undefined);
});

test("createRun then getRun round-trips a running record owned by this process", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  const created = await store.createRun("run_1", "task-1");
  assert.equal(created.status, "running");
  assert.equal(created.workerId, WORKER_ID);

  const fetched = await store.getRun("run_1");
  assert.ok(fetched);
  assert.equal(fetched?.runId, "run_1");
  assert.equal(fetched?.taskId, "task-1");
  assert.equal(fetched?.status, "running");
});

test("completeRun stores the result and moves status to completed", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  await store.createRun("run_2", "task-2");
  const result = fakeResult();
  await store.completeRun("run_2", result);

  const fetched = await store.getRun("run_2");
  assert.equal(fetched?.status, "completed");
  assert.deepEqual(fetched?.result, result);
});

test("failRun stores the error and moves status to failed", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  await store.createRun("run_3", "task-3");
  await store.failRun("run_3", "boom");

  const fetched = await store.getRun("run_3");
  assert.equal(fetched?.status, "failed");
  assert.equal(fetched?.error, "boom");
});

test("heartbeat updates updatedAt for a running record", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  const created = await store.createRun("run_4", "task-4");
  await new Promise((resolve) => setTimeout(resolve, 5));

  await store.heartbeat("run_4");
  const fetched = await store.getRun("run_4");
  assert.ok(fetched);
  assert.ok(new Date(fetched!.updatedAt).getTime() > new Date(created.updatedAt).getTime());
});

test("heartbeat on a non-running (already terminal) record is a no-op", async () => {
  const store = createInMemoryTaskStore(DEFAULT_TIMING);
  await store.createRun("run_5", "task-5");
  await store.completeRun("run_5", fakeResult());
  const before = await store.getRun("run_5");

  await store.heartbeat("run_5");
  const after = await store.getRun("run_5");
  assert.equal(after?.updatedAt, before?.updatedAt);
  assert.equal(after?.status, "completed");
});

test("a running record idle past the stale threshold reads back as stale with a staleReason", async () => {
  const store = createInMemoryTaskStore({ ttlSeconds: 86400, staleThresholdMs: 10, heartbeatIntervalMs: 15_000 });
  await store.createRun("run_6", "task-6");
  await new Promise((resolve) => setTimeout(resolve, 30));

  const fetched = await store.getRun("run_6");
  assert.equal(fetched?.status, "stale");
  assert.equal(fetched?.staleReason, "run_stale");
});

test("a record older than the TTL is evicted and reads back as unknown (undefined), same as 404", async () => {
  const store = createInMemoryTaskStore({ ttlSeconds: 0.02, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 });
  await store.createRun("run_7", "task-7");
  await new Promise((resolve) => setTimeout(resolve, 40));

  const fetched = await store.getRun("run_7");
  assert.equal(fetched, undefined);
});

test("all runs default to the in-memory store never persisting across separate store instances (contrast with redisTaskStore.test.ts)", async () => {
  const storeA = createInMemoryTaskStore(DEFAULT_TIMING);
  await storeA.createRun("run_8", "task-8");

  const storeB = createInMemoryTaskStore(DEFAULT_TIMING);
  assert.equal(await storeB.getRun("run_8"), undefined);
});
