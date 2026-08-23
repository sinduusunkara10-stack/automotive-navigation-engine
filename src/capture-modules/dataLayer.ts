import type { Page } from "playwright";
import type { DataLayerCapture } from "../types/task-response.js";

export async function captureDataLayer(page: Page, stepIndex: number): Promise<DataLayerCapture> {
  const raw = await page.evaluate(() => {
    const dataLayer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
    return Array.isArray(dataLayer) ? dataLayer : [];
  });

  return {
    stepIndex,
    url: page.url(),
    timestamp: new Date().toISOString(),
    raw: raw as Record<string, unknown>[],
  };
}
