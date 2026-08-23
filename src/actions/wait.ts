import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";

const MAX_WAIT_MS = 5000;

export async function executeWait(page: Page, action: SelectedAction): Promise<ActionResult> {
  const durationMs = typeof action.params?.durationMs === "number" ? action.params.durationMs : 250;
  await page.waitForTimeout(Math.min(durationMs, MAX_WAIT_MS));
  return { success: true, resultingUrl: page.url() };
}
