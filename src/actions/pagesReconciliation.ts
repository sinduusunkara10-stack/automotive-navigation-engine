/**
 * browserContext.pages() reconciliation (surface-relevance corrective work, PR 2 -- see
 * CLAUDE.md and docs/architecture.md "Surface adoption"): the pure diffing step actions/
 * click.ts's polling loop uses on every tick. Kept separate and side-effect-free so it can be
 * exercised directly in a unit test without a real Playwright context (see
 * tests/unit/pagesReconciliation.test.ts) -- everything else about the reconciliation
 * mechanism (the poll interval, the 250ms cadence, when it starts/stops) lives in click.ts
 * itself, since it depends on real timers and a real BrowserContext.
 */

/**
 * Returns every entry in `after` that is not present (by reference) in `before` -- a new page
 * that appeared in browserContext.pages() since the snapshot was taken. Reference equality is
 * deliberate and sufficient: Playwright hands back the same Page object instance for the same
 * underlying browser page across repeated context.pages() calls and "popup" events alike.
 */
export function findNewPages<T>(before: readonly T[], after: readonly T[]): T[] {
  const beforeSet = new Set(before);
  return after.filter((candidate) => !beforeSet.has(candidate));
}
