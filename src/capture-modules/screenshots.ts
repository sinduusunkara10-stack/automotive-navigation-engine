import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";
import type { ScreenshotCapture } from "../types/task-response.js";

export const DEFAULT_SCREENSHOT_DIR = join(process.cwd(), "test-artifacts", "screenshots");

export async function captureScreenshot(
  page: Page,
  stepIndex: number,
  reason: string,
  outputDir: string = DEFAULT_SCREENSHOT_DIR,
): Promise<ScreenshotCapture> {
  await mkdir(outputDir, { recursive: true });
  const fileName = `step-${stepIndex}-${reason}-${Date.now()}.png`;
  const filePath = join(outputDir, fileName);
  await page.screenshot({ path: filePath });

  return {
    stepIndex,
    ref: filePath,
    reason,
    timestamp: new Date().toISOString(),
  };
}
