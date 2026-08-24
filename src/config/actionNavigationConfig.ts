// Reads env-based configuration for navigation triggered by in-loop actions (the
// `navigate` action and link clicks that cause a document navigation, both in
// src/actions), as distinct from the engine's one-off initial page navigation
// (INITIAL_NAVIGATION_TIMEOUT_MS, src/config/initialNavigationConfig.ts). See
// .env.example for the full variable list.

export const DEFAULT_ACTION_NAVIGATION_TIMEOUT_MS = 30000;

// Same never-relaxed-ceiling pattern as MAX_INITIAL_NAVIGATION_TIMEOUT_MS: a
// misconfigured env var can never turn "wait longer for a slow page" into an
// effectively unbounded hang of the navigation loop.
const MAX_ACTION_NAVIGATION_TIMEOUT_MS = 120000;

export class InvalidActionNavigationTimeoutError extends Error {
  constructor(raw: string) {
    super(
      `ACTION_NAVIGATION_TIMEOUT_MS must be a positive integer number of milliseconds, at most ` +
        `${MAX_ACTION_NAVIGATION_TIMEOUT_MS}. Received: "${raw}". Unset it to use the default ` +
        `(${DEFAULT_ACTION_NAVIGATION_TIMEOUT_MS}ms).`,
    );
    this.name = "InvalidActionNavigationTimeoutError";
  }
}

/**
 * Reads only ACTION_NAVIGATION_TIMEOUT_MS from the given env (defaulting to
 * process.env) -- never any other environment value -- and returns a validated timeout
 * in milliseconds. Missing/empty is the conservative default; anything else that isn't a
 * positive integer within the hard ceiling fails clearly rather than silently clamping or
 * falling back, so a typo'd deployment config is never silently misconfigured.
 */
export function readActionNavigationTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACTION_NAVIGATION_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_ACTION_NAVIGATION_TIMEOUT_MS;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidActionNavigationTimeoutError(trimmed);
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_ACTION_NAVIGATION_TIMEOUT_MS) {
    throw new InvalidActionNavigationTimeoutError(trimmed);
  }

  return parsed;
}
