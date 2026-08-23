import type { Page } from "playwright";
import type { PageMetadataCapture } from "../types/task-response.js";

export async function capturePageMetadata(page: Page, stepIndex: number): Promise<PageMetadataCapture> {
  const meta = await page.evaluate(() => ({
    title: document.title || undefined,
    description: document.querySelector('meta[name="description"]')?.getAttribute("content") ?? undefined,
    lang: document.documentElement.lang || undefined,
  }));

  return {
    stepIndex,
    url: page.url(),
    timestamp: new Date().toISOString(),
    ...meta,
  };
}
