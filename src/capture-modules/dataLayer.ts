import type { Page } from "playwright";
import type { DataLayerCapture } from "../types/task-response.js";
import { MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT } from "../config/captureLimits.js";

/**
 * Bounded to the most recent MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT entries: this reads
 * the *entire* current window.dataLayer every step (not a delta -- see dataLayerDelta.ts
 * for the delta variant used elsewhere), so on a page whose dataLayer keeps growing, an
 * unbounded snapshot here means step N stores a full copy of an array that has itself grown
 * to roughly size N -- worse than linear growth within a single run. The cap keeps the
 * most recent entries (the ones most likely relevant to whatever just happened), never the
 * oldest -- see src/core/boundedArray.ts.
 */
export async function captureDataLayer(page: Page, stepIndex: number): Promise<DataLayerCapture> {
  const raw = await page.evaluate(() => {
    const dataLayer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    return Array.isArray(dataLayer) ? dataLayer : [];
  });
  const bounded = (raw as Record<string, unknown>[]).slice(-MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT);

  return {
    stepIndex,
    url: page.url(),
    timestamp: new Date().toISOString(),
    raw: bounded,
  };
}
