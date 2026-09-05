import type { RunRecord, TaskStore } from "./taskStore.js";
import type { TaskResponse } from "../types/task-response.js";
import type { TaskStoreTimingConfig } from "../config/taskStoreConfig.js";
import { applyStaleDetection } from "./staleDetection.js";
import { WORKER_ID } from "./workerIdentity.js";

/**
 * Local-development/test task store: all runs are lost when the process restarts -- there
 * is no persistence layer here (see redisTaskStore.ts for the opt-in persistent backend
 * used in production). Applies the same TTL and stale-detection semantics as the Redis
 * store so behavior doesn't change shape depending on which backend is selected -- see
 * docs/architecture.md "Memory stability".
 */
export function createInMemoryTaskStore(timing: TaskStoreTimingConfig): TaskStore {
  const runs = new Map<string, RunRecord>();

  function isExpired(record: RunRecord, now: number): boolean {
    return now - new Date(record.updatedAt).getTime() > timing.ttlSeconds * 1000;
  }

  return {
    async createRun(runId, taskId) {
      const now = new Date().toISOString();
      const record: RunRecord = {
        runId,
        taskId,
        status: "running",
        createdAt: now,
        updatedAt: now,
        workerId: WORKER_ID,
      };
      runs.set(runId, record);
      // A copy, not the stored record itself: the Redis-backed store necessarily hands
      // back a freshly deserialized object on every read (see redisTaskStore.ts), so a
      // caller holding onto this return value must never observe a later in-place
      // mutation (e.g. from heartbeat()) either -- both backends behave value-like.
      return { ...record };
    },

    async getRun(runId) {
      const record = runs.get(runId);
      if (!record) return undefined;
      const now = Date.now();
      if (isExpired(record, now)) {
        runs.delete(runId);
        return undefined;
      }
      return { ...applyStaleDetection(record, timing.staleThresholdMs, now) };
    },

    async completeRun(runId, result: TaskResponse) {
      const record = runs.get(runId);
      if (!record) return;
      record.status = "completed";
      record.result = result;
      record.updatedAt = new Date().toISOString();
    },

    async failRun(runId, error) {
      const record = runs.get(runId);
      if (!record) return;
      record.status = "failed";
      record.error = error;
      record.updatedAt = new Date().toISOString();
    },

    async heartbeat(runId) {
      const record = runs.get(runId);
      if (!record || record.status !== "running") return;
      record.updatedAt = new Date().toISOString();
      record.workerId = WORKER_ID;
    },
  };
}
