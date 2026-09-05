// Reads LOW_MEMORY_BROWSER_MODE: an opt-in toggle (default off, zero behavior change
// unless explicitly enabled) that blocks image/media/font network requests and disables
// service worker registration for the run's page -- see src/api/browserResourceRouting.ts
// and docs/architecture.md "Low-memory browser mode". Deliberately a plain boolean, not a
// numeric/enum config: there is exactly one on/off lever here, not a tunable range.

/**
 * Only the literal string "true" (case-insensitive, surrounding whitespace ignored)
 * enables the mode -- anything else, including unset, an empty string, "1", or a typo,
 * leaves it off. A boolean toggle has no invalid-value case to fail fast on the way the
 * numeric configs elsewhere in src/config do; an unrecognized value simply doesn't opt in,
 * the same conservative default as never setting the variable at all.
 */
export function readLowMemoryBrowserMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LOW_MEMORY_BROWSER_MODE?.trim().toLowerCase() === "true";
}
