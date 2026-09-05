import type { RunRecord, TaskStore } from "./taskStore.js";
import type { TaskStoreTimingConfig } from "../config/taskStoreConfig.js";
import { applyStaleDetection } from "./staleDetection.js";
import { WORKER_ID } from "./workerIdentity.js";

const KEY_PREFIX = "nav-engine:run:";

function keyFor(runId: string): string {
  return `${KEY_PREFIX}${runId}`;
}

/**
 * The minimal subset of the ioredis client this store actually calls -- kept narrow (and
 * structural, not a nominal ioredis import) so a test can inject any compatible client
 * (e.g. ioredis-mock) without needing to satisfy ioredis's full public type surface.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
}

/**
 * Production-opt-in persistent backend: a run record survives an API process restart
 * (e.g. an OOM kill -- see docs/architecture.md "Memory stability") because it lives in
 * Redis, not in the killed process's own memory. One key per run (nav-engine:run:<runId>),
 * the whole RunRecord as its JSON value, TTL refreshed on every write via `SET ... EX` so
 * a run's record naturally expires timing.ttlSeconds after its last update rather than
 * needing a separate reaper process.
 *
 * The read-then-write updates below are not atomic, but that's acceptable here: a given
 * runId is only ever written by the single run that owns it (see src/api/runner.ts) --
 * there is no concurrent-writer scenario to race against.
 */
export function createRedisTaskStore(client: RedisLike, timing: TaskStoreTimingConfig): TaskStore {
  async function write(record: RunRecord): Promise<void> {
    await client.set(keyFor(record.runId), JSON.stringify(record), "EX", timing.ttlSeconds);
  }

  async function read(runId: string): Promise<RunRecord | undefined> {
    const raw = await client.get(keyFor(runId));
    if (!raw) return undefined;
    return JSON.parse(raw) as RunRecord;
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
      await write(record);
      return record;
    },

    async getRun(runId) {
      const record = await read(runId);
      if (!record) return undefined;
      const wasRunning = record.status === "running";
      const detected = applyStaleDetection(record, timing.staleThresholdMs);
      if (wasRunning && detected.status === "stale") {
        await write(detected);
      }
      return detected;
    },

    async completeRun(runId, result) {
      const record = await read(runId);
      if (!record) return;
      record.status = "completed";
      record.result = result;
      record.updatedAt = new Date().toISOString();
      await write(record);
    },

    async failRun(runId, error) {
      const record = await read(runId);
      if (!record) return;
      record.status = "failed";
      record.error = error;
      record.updatedAt = new Date().toISOString();
      await write(record);
    },

    async heartbeat(runId) {
      const record = await read(runId);
      if (!record || record.status !== "running") return;
      record.updatedAt = new Date().toISOString();
      record.workerId = WORKER_ID;
      await write(record);
    },
  };
}
