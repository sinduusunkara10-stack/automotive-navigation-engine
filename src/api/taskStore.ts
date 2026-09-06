import type { ContainerMemoryDiagnostics, TaskResponse } from "../types/task-response.js";

export type RunStatus = "running" | "completed" | "failed" | "stale";

/**
 * "worker_lost": the record's last heartbeat came from a process instance that is not the
 * one currently reading it (see workerIdentity.ts) -- the run's owning process is gone,
 * most likely killed (e.g. an OOM restart) rather than merely slow. "run_stale": the same
 * process is still the record's owner, but it stopped heartbeating past the configured
 * threshold anyway (e.g. a hung run). See staleDetection.ts.
 */
export type StaleReason = "worker_lost" | "run_stale";

export interface RunRecord {
  runId: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  result?: TaskResponse;
  error?: string;
  staleReason?: StaleReason;
  /** The workerIdentity.ts WORKER_ID of the process that last created/heartbeated this run. */
  workerId: string;
  /**
   * The opt-in container-memory circuit breaker's latest sample for this still-running (or
   * just-stopped) run -- see src/safety/containerMemoryGuard.ts. Refreshed on each
   * heartbeat while MEMORY_CIRCUIT_BREAKER_ENABLED is set; absent otherwise. This is a
   * single latest snapshot, not a growing history.
   */
  latestContainerMemorySample?: ContainerMemoryDiagnostics;
}

/**
 * Persistence contract for run records, deliberately backend-agnostic: an in-memory
 * implementation (inMemoryTaskStore.ts, used for local development and tests) and an
 * opt-in Redis-backed implementation (redisTaskStore.ts, used in production) both
 * implement this same interface -- see taskStoreFactory.ts for backend selection and
 * docs/architecture.md "Memory stability" for why a persistent backend exists at all
 * (an in-memory-only store loses every run record on a process restart, e.g. an OOM
 * kill -- see the incident this module was introduced to address).
 */
export interface TaskStore {
  createRun(runId: string, taskId: string): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | undefined>;
  completeRun(runId: string, result: TaskResponse): Promise<void>;
  failRun(runId: string, error: string): Promise<void>;
  /**
   * Refreshes updatedAt (and this process's ownership) for an actively-running run.
   * Optionally also persists the container-memory circuit breaker's latest sample
   * (containerMemorySample) -- passed only when MEMORY_CIRCUIT_BREAKER_ENABLED is set;
   * omitted otherwise, leaving any previously-stored sample untouched.
   */
  heartbeat(runId: string, containerMemorySample?: ContainerMemoryDiagnostics): Promise<void>;
}
