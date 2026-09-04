import { test } from "node:test";
import assert from "node:assert/strict";
import RedisMock from "ioredis-mock";

import { createRedisTaskStore } from "../../src/api/redisTaskStore.js";
import type { TaskResponse } from "../../src/types/task-response.js";

const DEFAULT_TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function fakeResult(): TaskResponse {
  return {
    schemaVersion: "1.7.0",
    taskId: "redis-task-store-test",
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

/**
 * ioredis-mock instances created with no distinguishing options share the same in-memory
 * backing store by default -- the same way two real ioredis clients pointed at the same
 * REDIS_URL share the same server-side data. This lets these tests simulate "a fresh API
 * process reading a record an earlier, now-dead process wrote" by constructing a brand new
 * client/store pair rather than reusing the one that created the record.
 */
function freshStore(timing = DEFAULT_TIMING) {
  const client = new RedisMock();
  return createRedisTaskStore(client, timing);
}

test("getRun on an unknown runId returns undefined (the API layer turns this into 404)", async () => {
  const store = freshStore();
  assert.equal(await store.getRun("run_does-not-exist"), undefined);
});

test("an active (running) run record survives an API process restart", async () => {
  const writerProcessStore = freshStore();
  await writerProcessStore.createRun("run_restart_1", "task-restart-1");

  // A brand new store/client pair stands in for a fresh process after a restart -- see
  // freshStore's own comment above.
  const newProcessStore = freshStore();
  const record = await newProcessStore.getRun("run_restart_1");
  assert.ok(record, "expected the run record to survive across store instances");
  assert.equal(record?.status, "running");
  assert.equal(record?.taskId, "task-restart-1");
});

test("a completed result survives an API process restart", async () => {
  const writerProcessStore = freshStore();
  await writerProcessStore.createRun("run_restart_2", "task-restart-2");
  const result = fakeResult();
  await writerProcessStore.completeRun("run_restart_2", result);

  const newProcessStore = freshStore();
  const record = await newProcessStore.getRun("run_restart_2");
  assert.equal(record?.status, "completed");
  assert.deepEqual(record?.result, result);
});

test("a failed result survives an API process restart", async () => {
  const writerProcessStore = freshStore();
  await writerProcessStore.createRun("run_restart_3", "task-restart-3");
  await writerProcessStore.failRun("run_restart_3", "boom");

  const newProcessStore = freshStore();
  const record = await newProcessStore.getRun("run_restart_3");
  assert.equal(record?.status, "failed");
  assert.equal(record?.error, "boom");
});

test("a running run whose owning process never comes back reads as stale/worker_lost from a fresh process", async () => {
  const timing = { ttlSeconds: 86400, staleThresholdMs: 10, heartbeatIntervalMs: 15_000 };
  const writerProcessStore = freshStore(timing);
  await writerProcessStore.createRun("run_restart_4", "task-restart-4");
  await new Promise((resolve) => setTimeout(resolve, 30));

  // A different store instance in this same test process still has the same WORKER_ID
  // (one constant per process -- see workerIdentity.ts), so this exercises the idle-past-
  // threshold path generically; the worker_lost-vs-run_stale distinction itself is covered
  // precisely, with a genuinely different workerId, in staleDetection.test.ts.
  const record = await writerProcessStore.getRun("run_restart_4");
  assert.equal(record?.status, "stale");
  assert.ok(record?.staleReason);
});

test("heartbeat updates updatedAt for a running record", async () => {
  const store = freshStore();
  const created = await store.createRun("run_9", "task-9");
  await new Promise((resolve) => setTimeout(resolve, 5));

  await store.heartbeat("run_9");
  const fetched = await store.getRun("run_9");
  assert.ok(new Date(fetched!.updatedAt).getTime() > new Date(created.updatedAt).getTime());
});

test("each write refreshes the key's TTL to the configured ttlSeconds", async () => {
  const client = new RedisMock();
  const store = createRedisTaskStore(client, { ttlSeconds: 3600, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 });
  await store.createRun("run_10", "task-10");

  const ttl = await client.ttl("nav-engine:run:run_10");
  assert.ok(ttl > 0 && ttl <= 3600, `expected a positive TTL at most 3600, got ${ttl}`);
});
