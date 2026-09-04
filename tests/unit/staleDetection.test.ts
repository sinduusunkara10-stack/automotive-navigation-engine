import { test } from "node:test";
import assert from "node:assert/strict";

import { applyStaleDetection } from "../../src/api/staleDetection.js";
import { WORKER_ID } from "../../src/api/workerIdentity.js";
import type { RunRecord } from "../../src/api/taskStore.js";

function runningRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run_stale-detection-1",
    taskId: "stale-detection-task",
    status: "running",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    workerId: WORKER_ID,
    ...overrides,
  };
}

test("applyStaleDetection leaves a running record untouched while inside the stale threshold", () => {
  const now = 10_000;
  const record = runningRecord({ updatedAt: new Date(now - 100).toISOString() });
  const result = applyStaleDetection(record, 5000, now);
  assert.equal(result.status, "running");
  assert.equal(result.staleReason, undefined);
});

test("applyStaleDetection marks a same-worker record stale with run_stale once idle past the threshold", () => {
  const now = 10_000;
  const record = runningRecord({ updatedAt: new Date(now - 6000).toISOString(), workerId: WORKER_ID });
  const result = applyStaleDetection(record, 5000, now);
  assert.equal(result.status, "stale");
  assert.equal(result.staleReason, "run_stale");
});

test("applyStaleDetection marks a different-worker record stale with worker_lost once idle past the threshold", () => {
  const now = 10_000;
  const record = runningRecord({
    updatedAt: new Date(now - 6000).toISOString(),
    workerId: "1234-some-other-process-boot-token",
  });
  const result = applyStaleDetection(record, 5000, now);
  assert.equal(result.status, "stale");
  assert.equal(result.staleReason, "worker_lost");
});

test("applyStaleDetection never touches a non-running record", () => {
  const now = 10_000;
  for (const status of ["completed", "failed", "stale"] as const) {
    const record = runningRecord({ status, updatedAt: new Date(0).toISOString() });
    const result = applyStaleDetection(record, 5000, now);
    assert.equal(result.status, status);
  }
});

test("applyStaleDetection updates updatedAt to the detection time when transitioning to stale", () => {
  const now = 10_000;
  const record = runningRecord({ updatedAt: new Date(now - 6000).toISOString() });
  const result = applyStaleDetection(record, 5000, now);
  assert.equal(result.updatedAt, new Date(now).toISOString());
});
