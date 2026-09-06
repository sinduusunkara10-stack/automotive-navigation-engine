// Reads env-based configuration for the opt-in container-memory circuit breaker (see
// src/safety/containerMemoryGuard.ts and docs/architecture.md "Container memory circuit
// breaker"). Off by default -- zero behavior change unless MEMORY_CIRCUIT_BREAKER_ENABLED
// is explicitly set to "true". See .env.example for the full variable list.

export const DEFAULT_MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION = 0.75;
export const DEFAULT_MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS = 3000;

// Hard ceilings, independent of what's configured -- same never-relaxed-ceiling pattern as
// src/config/initialNavigationConfig.ts and src/config/captureLimits.ts.
const MAX_SAMPLE_INTERVAL_MS = 60000;
const MIN_SAMPLE_INTERVAL_MS = 250;

/**
 * Only the literal string "true" (case-insensitive, surrounding whitespace ignored)
 * enables the breaker -- anything else, including unset, leaves it off. Matches
 * src/config/lowMemoryBrowserConfig.ts's readLowMemoryBrowserMode.
 */
export function readMemoryCircuitBreakerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORY_CIRCUIT_BREAKER_ENABLED?.trim().toLowerCase() === "true";
}

export class InvalidMemoryCircuitBreakerThresholdError extends Error {
  constructor(raw: string) {
    super(
      `MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION must be a number greater than 0 and at most 1. Received: ` +
        `"${raw}". Unset it to use the default (${DEFAULT_MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION}).`,
    );
    this.name = "InvalidMemoryCircuitBreakerThresholdError";
  }
}

/** Fraction of the container's memory limit at which the breaker stops the run. */
export function readMemoryCircuitBreakerThresholdFraction(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION;
  }
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new InvalidMemoryCircuitBreakerThresholdError(trimmed);
  }
  return parsed;
}

export class InvalidMemoryCircuitBreakerSampleIntervalError extends Error {
  constructor(raw: string) {
    super(
      `MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS must be a positive integer between ` +
        `${MIN_SAMPLE_INTERVAL_MS} and ${MAX_SAMPLE_INTERVAL_MS}. Received: "${raw}". Unset it to use the ` +
        `default (${DEFAULT_MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS}ms).`,
    );
    this.name = "InvalidMemoryCircuitBreakerSampleIntervalError";
  }
}

/** How often (ms) the breaker samples container memory while a run is active. */
export function readMemoryCircuitBreakerSampleIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidMemoryCircuitBreakerSampleIntervalError(trimmed);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < MIN_SAMPLE_INTERVAL_MS || parsed > MAX_SAMPLE_INTERVAL_MS) {
    throw new InvalidMemoryCircuitBreakerSampleIntervalError(trimmed);
  }
  return parsed;
}

export class InvalidMemoryCircuitBreakerLimitBytesError extends Error {
  constructor(raw: string) {
    super(
      `MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES must be a positive integer number of bytes. Received: "${raw}". ` +
        "Unset it to use the container's own cgroup-reported memory limit instead.",
    );
    this.name = "InvalidMemoryCircuitBreakerLimitBytesError";
  }
}

/**
 * Optional override for the container memory limit, in bytes -- used only when the
 * cgroup-reported limit is absent, unreadable, or needs to be overridden for a specific
 * deployment. Unset (the default) means "use whatever the cgroup reports."
 */
export function readMemoryCircuitBreakerLimitBytesOverride(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES;
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidMemoryCircuitBreakerLimitBytesError(trimmed);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidMemoryCircuitBreakerLimitBytesError(trimmed);
  }
  return parsed;
}
