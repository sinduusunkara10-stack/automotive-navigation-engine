// Reads env-based configuration for the engine's initial page navigation (the first
// page.goto() in src/core/engine.ts, before the observe/decide/act loop starts). See
// .env.example for the full variable list.

export const DEFAULT_INITIAL_NAVIGATION_TIMEOUT_MS = 30000;

// A hard ceiling, independent of what's configured, mirroring the never-relaxed-ceiling
// pattern src/safety uses for maxSteps/maxBacktracks and src/reasoning/config.ts uses for
// CLAUDE_MAX_RETRIES: a misconfigured env var can never turn "wait longer for a slow page"
// into an effectively unbounded hang.
const MAX_INITIAL_NAVIGATION_TIMEOUT_MS = 120000;

export class InvalidInitialNavigationTimeoutError extends Error {
  constructor(raw: string) {
    super(
      `INITIAL_NAVIGATION_TIMEOUT_MS must be a positive integer number of milliseconds, at most ` +
        `${MAX_INITIAL_NAVIGATION_TIMEOUT_MS}. Received: "${raw}". Unset it to use the default ` +
        `(${DEFAULT_INITIAL_NAVIGATION_TIMEOUT_MS}ms).`,
    );
    this.name = "InvalidInitialNavigationTimeoutError";
  }
}

/**
 * Reads only INITIAL_NAVIGATION_TIMEOUT_MS from the given env (defaulting to
 * process.env) -- never any other environment value -- and returns a validated timeout
 * in milliseconds. Missing/empty is the conservative default; anything else that isn't a
 * positive integer within the hard ceiling fails clearly rather than silently clamping or
 * falling back, so a typo'd deployment config is never silently misconfigured.
 */
export function readInitialNavigationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INITIAL_NAVIGATION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_INITIAL_NAVIGATION_TIMEOUT_MS;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidInitialNavigationTimeoutError(trimmed);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_INITIAL_NAVIGATION_TIMEOUT_MS) {
    throw new InvalidInitialNavigationTimeoutError(trimmed);
  }

  return parsed;
}
