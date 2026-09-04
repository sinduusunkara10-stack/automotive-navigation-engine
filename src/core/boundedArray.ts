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
