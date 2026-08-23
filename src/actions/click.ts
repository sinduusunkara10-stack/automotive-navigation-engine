import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";
import { elementLocatorSelector } from "../observation/observationBuilder.js";

export async function executeClick(page: Page, action: SelectedAction): Promise<ActionResult> {
  if (!action.target) {
    return { success: false, error: "click action requires a target element id" };
  }
  const selector = elementLocatorSelector(action.target);
  try {
    await Promise.all([
      page.waitForNavigation({ timeout: 5000 }).catch(() => undefined),
      page.click(selector, { timeout: 5000 }),
    ]);
    return { success: true, resultingUrl: page.url() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
