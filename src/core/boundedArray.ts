/**
 * Generic, content-agnostic append-with-cap: keeps at most `max` entries, dropping the
 * *oldest* once the cap is reached (a sliding window, not a hard stop) -- recent evidence
 * is generally more diagnostically useful than the earliest, and this is the same
 * keep-most-recent-N shape every other bounded collection in this codebase already uses
 * (e.g. observation/frames.ts's MAX_REPORTED_INACCESSIBLE_FRAME_ORIGINS). Never brand,
 * capture-type, or field-specific -- callers decide what `max` means for their own data;
 * this function only knows "array, entry, cap".
 */
export function appendBounded<T>(array: readonly T[], entry: T, max: number): T[] {
  const next = [...array, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Like appendBounded, but for evidence where the *earliest* entries matter as much as the
 * most recent ones -- a journey's screenshots and step history, for example, are only
 * useful for validating a run if both "where it started" and "where it ended" survive
 * bounding. Keeps the first `keepFirst` entries permanently, then applies a keep-most-
 * recent-N window (appendBounded's own strategy) to the remaining `max - keepFirst` slots.
 * Once `array` already holds `keepFirst` or more entries, the head is frozen and every
 * further append only slides the tail window -- so calling this repeatedly, once per new
 * entry, never grows past `max` total entries at any point. Never brand, capture-type, or
 * field-specific -- callers decide what `max`/`keepFirst` mean for their own data.
 *
 * `keepFirst` is clamped to at most half of `max`: a caller-supplied (or configured)
 * `keepFirst` that's large relative to a small `max` never fully consumes the budget, so
 * "preserve the final evidence" holds regardless of how `max`/`keepFirst` end up
 * configured relative to each other -- the one exception is max === 1, where a single
 * surviving slot necessarily goes to the most recent entry, matching appendBounded's own
 * recency bias.
 */
export function capPreservingEnds<T>(array: readonly T[], max: number, keepFirst: number): T[] {
  if (array.length <= max) {
    return [...array];
  }
  const effectiveKeepFirst = Math.min(keepFirst, Math.floor(max / 2));
  const head = array.slice(0, effectiveKeepFirst);
  const tailMax = max - effectiveKeepFirst;
  const tail = tailMax <= 0 ? [] : array.slice(array.length - tailMax);
  return [...head, ...tail];
}

/** appendBounded's counterpart for capPreservingEnds -- see that function's own comment. */
export function appendBoundedPreservingEnds<T>(array: readonly T[], entry: T, max: number, keepFirst: number): T[] {
  return capPreservingEnds([...array, entry], max, keepFirst);
}
