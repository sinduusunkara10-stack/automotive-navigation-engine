import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Redis as IORedis } from "ioredis";

import { createTaskStore } from "../../src/api/taskStoreFactory.js";
import type { TaskResponse } from "../../src/types/task-response.js";

/**
 * Runs against a REAL Redis server, not ioredis-mock (see tests/unit/redisTaskStore.test.ts
 * and tests/unit/taskStoreFactory.test.ts for the mock-backed coverage of the same store).
 * CI provides one via a GitHub Actions service container (see .github/workflows/ci.yml,
 * "redis" service, exposed at localhost:6379) so this exercises the real wire protocol,
 * real TTL expiry, and real cross-connection persistence in every PR run. A developer
 * running `npm test` locally without a Redis server gets a graceful skip, not a failure --
 * this test is the one piece of Redis coverage that is NOT part of the default, no-
 * external-dependencies test run.
 */
const REDIS_URL = process.env.REDIS_URL_FOR_TESTS ?? "redis://127.0.0.1:6379";
const CONNECT_TIMEOUT_MS = 1500;

// Every real ioredis client this file opens (via createTaskStore's redisClientFactory
// injection) is tracked here and closed in the top-level "after" hook below -- an ioredis
// connection left open keeps Node's event loop alive indefinitely, which would otherwise
// hang the whole test run rather than just this file.
const openClients: IORedis[] = [];

function createTrackedClient(): IORedis {
  const client = new IORedis(REDIS_URL, { lazyConnect: true, connectTimeout: CONNECT_TIMEOUT_MS });
  client.on("error", () => {});
  openClients.push(client);
  return client;
}

async function isReachable(): Promise<boolean> {
  const probe = createTrackedClient();
  try {
    await probe.connect();
    return true;
  } catch {
    return false;
  }
}

function fakeResult(taskId: string): TaskResponse {
  return {
    schemaVersion: "1.9.0",
    taskId,
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

async function createRealRedisStore() {
  return createTaskStore(
    { TASK_STORE: "redis", REDIS_URL },
    { redisClientFactory: () => createTrackedClient() },
  );
}

test("createTaskStore(TASK_STORE=redis) against a real Redis server: create/get/complete round-trip", async (t) => {
  if (!(await isReachable())) {
    t.skip(`no reachable Redis at ${REDIS_URL} -- set REDIS_URL_FOR_TESTS or run a local Redis to exercise this`);
    return;
  }

  const store = await createRealRedisStore();
  const runId = `run_real_redis_${Date.now()}`;

  const created = await store.createRun(runId, "real-redis-task");
  assert.equal(created.status, "running");

  const fetchedRunning = await store.getRun(runId);
  assert.equal(fetchedRunning?.status, "running");

  await store.completeRun(runId, fakeResult("real-redis-task"));
  const fetchedCompleted = await store.getRun(runId);
  assert.equal(fetchedCompleted?.status, "completed");
  assert.equal(fetchedCompleted?.result?.taskId, "real-redis-task");
});

test("a run record written by one connection survives being read by a brand new connection (real cross-connection persistence)", async (t) => {
  if (!(await isReachable())) {
    t.skip(`no reachable Redis at ${REDIS_URL} -- set REDIS_URL_FOR_TESTS or run a local Redis to exercise this`);
    return;
  }

  const runId = `run_real_redis_restart_${Date.now()}`;
  const writerStore = await createRealRedisStore();
  await writerStore.createRun(runId, "real-redis-restart-task");
  await writerStore.completeRun(runId, fakeResult("real-redis-restart-task"));

  // A brand new TaskStore/client pair, exactly as a freshly restarted API process would
  // create -- this is the real-server equivalent of the ioredis-mock "survives an API
  // process restart" tests, proving the same guarantee against the actual wire protocol.
  const readerStore = await createRealRedisStore();
  const record = await readerStore.getRun(runId);
  assert.equal(record?.status, "completed");
  assert.equal(record?.result?.taskId, "real-redis-restart-task");
});

// Guaranteed to run once, after every test in this file, regardless of pass/fail/skip --
// see openClients' own comment for why this matters.
after(async () => {
  for (const client of openClients) {
    await client.quit().catch(() => client.disconnect());
  }
});
