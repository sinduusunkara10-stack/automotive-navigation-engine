import type { Page } from "playwright";
import type { PageVisitCapture } from "../types/task-response.js";

export async function capturePageVisit(page: Page, stepIndex: number): Promise<PageVisitCapture> {
  return {
    stepIndex,
    url: page.url(),
    title: await page.title(),
    timestamp: new Date().toISOString(),
  };
}
