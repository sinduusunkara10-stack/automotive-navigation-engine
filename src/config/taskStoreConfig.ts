// Reads env-based configuration for run-record persistence: how long a terminal record
// is retained (TTL), how long a "running" record can go without a heartbeat before it's
// treated as stale, and how often an active run refreshes its own heartbeat. See
// .env.example and docs/architecture.md "Memory stability" for the full picture -- this
// module only knows the three numbers, never which backend (in-memory/Redis) uses them.

export const DEFAULT_TASK_RECORD_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_RUN_STALE_THRESHOLD_MS = 90_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

// Hard ceilings, independent of what's configured -- same never-relaxed-ceiling pattern as
// src/config/initialNavigationConfig.ts. A misconfigured env var can widen retention or
// slow stale-detection, but never past a bound that would defeat the point of having one.
const MAX_TASK_RECORD_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_RUN_STALE_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export class InvalidTaskStoreConfigError extends Error {
  constructor(varName: string, raw: string, defaultValue: number, maxValue: number) {
    super(
      `${varName} must be a positive integer, at most ${maxValue}. Received: "${raw}". Unset it to use ` +
        `the default (${defaultValue}).`,
    );
    this.name = "InvalidTaskStoreConfigError";
  }
}

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  varName: string,
  defaultValue: number,
  maxValue: number,
): number {
  const raw = env[varName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidTaskStoreConfigError(varName, trimmed, defaultValue, maxValue);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new InvalidTaskStoreConfigError(varName, trimmed, defaultValue, maxValue);
  }
  return parsed;
}

export interface TaskStoreTimingConfig {
  ttlSeconds: number;
  staleThresholdMs: number;
  heartbeatIntervalMs: number;
}

export function readTaskStoreTimingConfig(env: NodeJS.ProcessEnv = process.env): TaskStoreTimingConfig {
  return {
    ttlSeconds: readPositiveIntEnv(
      env,
      "TASK_RECORD_TTL_SECONDS",
      DEFAULT_TASK_RECORD_TTL_SECONDS,
      MAX_TASK_RECORD_TTL_SECONDS,
    ),
    staleThresholdMs: readPositiveIntEnv(
      env,
      "RUN_STALE_THRESHOLD_MS",
      DEFAULT_RUN_STALE_THRESHOLD_MS,
      MAX_RUN_STALE_THRESHOLD_MS,
    ),
    heartbeatIntervalMs: readPositiveIntEnv(
      env,
      "HEARTBEAT_INTERVAL_MS",
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      MAX_HEARTBEAT_INTERVAL_MS,
    ),
  };
}
