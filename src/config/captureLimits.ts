/**
 * Bounded-growth ceilings for capture collections identified as unbounded during the
 * memory-stability investigation (see docs/architecture.md "Memory stability"): a page
 * whose window.dataLayer keeps growing was being re-snapshotted in full on every step
 * (worse than linear growth within a single run), and ga4_network_events/errors accumulate
 * for a run's entire lifetime with no cap at all. None of these limits are brand-, site-,
 * or language-specific -- they bound the *shape* of already-generic evidence collections,
 * identically for every task.
 */

/** Per-step window.dataLayer snapshot: keeps the most recent N entries of that snapshot. */
export const MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT = 200;

/** Whole-run cap on captures.ga4_network_events -- a persistent, run-lifetime listener. */
export const MAX_GA4_NETWORK_EVENTS = 500;

/** Whole-run cap on captures.errors -- a persistent, run-lifetime listener. */
export const MAX_ERROR_ENTRIES = 200;
