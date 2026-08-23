import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";

export async function executeScroll(page: Page, action: SelectedAction): Promise<ActionResult> {
  const deltaY = typeof action.params?.deltaY === "number" ? action.params.deltaY : 400;
  try {
    await page.mouse.wheel(0, deltaY);
    return { success: true, resultingUrl: page.url() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
