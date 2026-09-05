import type { Page } from "playwright";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { capturePageVisit } from "../capture-modules/pageVisits.js";
import { capturePageMetadata } from "../capture-modules/pageMetadata.js";
import { captureScreenshot } from "../capture-modules/screenshots.js";
import { captureFinishPageCtas } from "../capture-modules/finishPageCtas.js";
import { appendBoundedPreservingEnds } from "../core/boundedArray.js";
import { MAX_SCREENSHOTS_KEEP_FIRST, readMaxScreenshotsPerRun } from "../config/captureLimits.js";

export async function executeCapture(
  page: Page,
  captures: Captures,
  stepIndex: number,
  captureModules: CaptureModuleName[],
): Promise<ActionResult> {
  if (captureModules.includes("page_visits")) {
    const visit = await capturePageVisit(page, stepIndex);
    captures.page_visits = [...(captures.page_visits ?? []), visit];
  }

  if (captureModules.includes("page_metadata")) {
    const metadata = await capturePageMetadata(page, stepIndex);
    captures.page_metadata = [...(captures.page_metadata ?? []), metadata];
  }

  if (captureModules.includes("screenshots")) {
    const screenshot = await captureScreenshot(page, stepIndex, "capture_action");
    // Bounded to MAX_SCREENSHOTS_PER_RUN, preserving the first MAX_SCREENSHOTS_KEEP_FIRST
    // (how the run started) alongside the most recent ones (how it ended) -- see
    // src/core/boundedArray.ts and src/config/captureLimits.ts.
    captures.screenshots = appendBoundedPreservingEnds(
      captures.screenshots ?? [],
      screenshot,
      readMaxScreenshotsPerRun(),
      MAX_SCREENSHOTS_KEEP_FIRST,
    );
  }

  if (captureModules.includes("finish_page_ctas")) {
    const ctas = await captureFinishPageCtas(page, stepIndex);
    captures.finish_page_ctas = [...(captures.finish_page_ctas ?? []), ...ctas];
  }

  return { success: true, resultingUrl: page.url() };
}
