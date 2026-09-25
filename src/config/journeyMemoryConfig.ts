// Env-based configuration for Persistent Cross-Run Journey Memory. Mirrors this repo's
// existing config-module conventions (see taskStoreConfig.ts): read once, fail-fast on a
// malformed value, hard ceilings independent of what's configured. Gated behind
// JOURNEY_MEMORY_ENABLED (and the finer-grained READ/WRITE flags below) so an unset
// environment reproduces today's behaviour byte-for-byte -- see docs/journey-memory.md.

export interface JourneyMemoryFlags {
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
}

function readBoolEnv(env: NodeJS.ProcessEnv, varName: string, defaultValue: boolean): boolean {
  const raw = env[varName]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return defaultValue;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return defaultValue;
}

/**
 * The four supported read/write combinations (see docs/journey-memory.md): both off is a
 * complete rollback (no journey-memory code path is ever touched, byte-for-byte identical
 * to before this feature existed); JOURNEY_MEMORY_ENABLED gates both read and write at the
 * top level -- an operator sets it plus REDIS_URL to opt in at all, then independently
 * tunes READ/WRITE.
 */
export function readJourneyMemoryFlags(env: NodeJS.ProcessEnv = process.env): JourneyMemoryFlags {
  const enabled = readBoolEnv(env, "JOURNEY_MEMORY_ENABLED", false);
  if (!enabled) {
    return { enabled: false, readEnabled: false, writeEnabled: false };
  }
  return {
    enabled: true,
    readEnabled: readBoolEnv(env, "JOURNEY_MEMORY_READ_ENABLED", true),
    writeEnabled: readBoolEnv(env, "JOURNEY_MEMORY_WRITE_ENABLED", true),
  };
}

export class InvalidJourneyMemoryConfigError extends Error {
  constructor(varName: string, raw: string, defaultValue: number, maxValue: number) {
    super(
      `${varName} must be a positive integer, at most ${maxValue}. Received: "${raw}". Unset it to use the default (${defaultValue}).`,
    );
    this.name = "InvalidJourneyMemoryConfigError";
  }
}

function readPositiveIntEnv(env: NodeJS.ProcessEnv, varName: string, defaultValue: number, maxValue: number): number {
  const raw = env[varName];
  if (raw === undefined || raw.trim() === "") return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) throw new InvalidJourneyMemoryConfigError(varName, trimmed, defaultValue, maxValue);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maxValue) {
    throw new InvalidJourneyMemoryConfigError(varName, trimmed, defaultValue, maxValue);
  }
  return parsed;
}

export const DEFAULT_JOURNEY_MEMORY_LOOKUP_TIMEOUT_MS = 1000;
export const DEFAULT_JOURNEY_MEMORY_RECOVERY_TIMEOUT_MS = 1500;
export const DEFAULT_JOURNEY_MEMORY_MAX_RECOVERY_CALLS = 2;
export const DEFAULT_JOURNEY_MEMORY_MAX_RECORDS_PER_DOMAIN = 500;
export const DEFAULT_JOURNEY_MEMORY_RETENTION_DAYS = 90;
export const DEFAULT_JOURNEY_MEMORY_MAX_PROMPT_RECORDS = 5;
export const DEFAULT_JOURNEY_MEMORY_PROMPT_CHAR_CAP = 1600;
export const DEFAULT_JOURNEY_MEMORY_PROMPT_TOKEN_CAP = 400;
export const DEFAULT_JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND = 6;

const MAX_LOOKUP_TIMEOUT_MS = 5000;
const MAX_RECOVERY_TIMEOUT_MS = 8000;
const MAX_RECOVERY_CALLS = 5;
const MAX_RECORDS_PER_DOMAIN_CEILING = 5000;
const MAX_RETENTION_DAYS_CEILING = 365;
const MAX_PROMPT_RECORDS_CEILING = 20;
const MAX_PROMPT_CHAR_CAP_CEILING = 8000;
const MAX_PROMPT_TOKEN_CAP_CEILING = 2000;
const MAX_NO_PROGRESS_ACTION_BOUND_CEILING = 50;

export interface JourneyMemoryTimingConfig {
  lookupTimeoutMs: number;
  recoveryTimeoutMs: number;
  maxRecoveryCalls: number;
  maxRecordsPerDomain: number;
  retentionDays: number;
  maxPromptRecords: number;
  promptCharCap: number;
  promptTokenCap: number;
  noProgressActionBound: number;
}

export function readJourneyMemoryTimingConfig(env: NodeJS.ProcessEnv = process.env): JourneyMemoryTimingConfig {
  return {
    lookupTimeoutMs: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_LOOKUP_TIMEOUT_MS",
      DEFAULT_JOURNEY_MEMORY_LOOKUP_TIMEOUT_MS,
      MAX_LOOKUP_TIMEOUT_MS,
    ),
    recoveryTimeoutMs: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_RECOVERY_TIMEOUT_MS",
      DEFAULT_JOURNEY_MEMORY_RECOVERY_TIMEOUT_MS,
      MAX_RECOVERY_TIMEOUT_MS,
    ),
    maxRecoveryCalls: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_MAX_RECOVERY_CALLS",
      DEFAULT_JOURNEY_MEMORY_MAX_RECOVERY_CALLS,
      MAX_RECOVERY_CALLS,
    ),
    maxRecordsPerDomain: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_MAX_RECORDS_PER_DOMAIN",
      DEFAULT_JOURNEY_MEMORY_MAX_RECORDS_PER_DOMAIN,
      MAX_RECORDS_PER_DOMAIN_CEILING,
    ),
    retentionDays: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_RETENTION_DAYS",
      DEFAULT_JOURNEY_MEMORY_RETENTION_DAYS,
      MAX_RETENTION_DAYS_CEILING,
    ),
    maxPromptRecords: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_MAX_PROMPT_RECORDS",
      DEFAULT_JOURNEY_MEMORY_MAX_PROMPT_RECORDS,
      MAX_PROMPT_RECORDS_CEILING,
    ),
    promptCharCap: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_PROMPT_CHAR_CAP",
      DEFAULT_JOURNEY_MEMORY_PROMPT_CHAR_CAP,
      MAX_PROMPT_CHAR_CAP_CEILING,
    ),
    promptTokenCap: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_PROMPT_TOKEN_CAP",
      DEFAULT_JOURNEY_MEMORY_PROMPT_TOKEN_CAP,
      MAX_PROMPT_TOKEN_CAP_CEILING,
    ),
    noProgressActionBound: readPositiveIntEnv(
      env,
      "JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND",
      DEFAULT_JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND,
      MAX_NO_PROGRESS_ACTION_BOUND_CEILING,
    ),
  };
}
