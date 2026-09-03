import type { Page } from "playwright";
import type { DataLayerDelta } from "../types/task-response.js";

export interface DataLayerSnapshot {
  available: boolean;
  raw: Record<string, unknown>[];
}

/**
 * Reads window.dataLayer's current contents, distinguishing "no such array exists on this
 * page" (available: false) from "it exists" (available: true, possibly empty). Used as a
 * before/after pair around one action -- see diffDataLayer below -- never reported on its
 * own as part of a capture.
 */
export async function readDataLayerSnapshot(page: Page): Promise<DataLayerSnapshot> {
  return page.evaluate(() => {
    const dataLayer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    if (!Array.isArray(dataLayer)) {
      return { available: false, raw: [] };
    }
    return { available: true, raw: dataLayer as Record<string, unknown>[] };
  });
}

/**
 * Generic, mechanical cursor/position delta between two dataLayer snapshots -- never a full
 * re-report of either snapshot except in the one case where a straightforward suffix-delta
 * isn't meaningful (replaced/reset). Three cases, in order:
 *
 * 1. Unavailable both before and after (most pages without a dataLayer at all): available
 *    false, no entries -- distinct from case 3's "available but nothing new".
 * 2. The after snapshot's array is shorter than before, or its first `before.length`
 *    entries no longer match the before snapshot entry-for-entry: the array was replaced or
 *    reset (a full page navigation always does this, since it starts a fresh JS context;
 *    a site reassigning window.dataLayer = [] does too). newEntries is the *entire* after
 *    array in this case (from a fresh context, everything present is new relative to this
 *    action), and replaced is true.
 * 3. Otherwise, the before snapshot's entries form a genuine prefix of the after snapshot:
 *    newEntries is just the appended suffix -- possibly empty, meaning "present but
 *    unchanged" (available stays true either way).
 */
export function diffDataLayer(before: DataLayerSnapshot, after: DataLayerSnapshot): DataLayerDelta {
  if (!before.available && !after.available) {
    return { available: false, newEntries: [] };
  }
  if (!after.available) {
    return { available: false, newEntries: [] };
  }

  const prefixMatches =
    before.available &&
    before.raw.length <= after.raw.length &&
    before.raw.every((entry, index) => JSON.stringify(entry) === JSON.stringify(after.raw[index]));

  if (!prefixMatches) {
    return { available: true, newEntries: after.raw, replaced: true };
  }

  return { available: true, newEntries: after.raw.slice(before.raw.length) };
}
