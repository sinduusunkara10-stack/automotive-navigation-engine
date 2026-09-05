import type { RunRecord } from "./taskStore.js";
import { WORKER_ID } from "./workerIdentity.js";

/**
 * Shared by every TaskStore backend so "running past the stale threshold" is detected
 * identically regardless of where the record lives. Mutates and returns the same record
 * (backends persist the mutation themselves after calling this) rather than returning a
 * boolean, so callers get the already-updated status/staleReason/updatedAt in one step.
 * Only ever inspects status/updatedAt/workerId -- never anything about the task or page
 * being run.
 */
export function applyStaleDetection(record: RunRecord, staleThresholdMs: number, now: number = Date.now()): RunRecord {
  if (record.status !== "running") {
    return record;
  }
  const idleMs = now - new Date(record.updatedAt).getTime();
  if (idleMs <= staleThresholdMs) {
    return record;
  }
  record.status = "stale";
  record.staleReason = record.workerId === WORKER_ID ? "run_stale" : "worker_lost";
  record.updatedAt = new Date(now).toISOString();
  return record;
}
