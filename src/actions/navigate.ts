import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";

export async function executeNavigate(page: Page, action: SelectedAction): Promise<ActionResult> {
  if (!action.target) {
    return { success: false, error: "navigate action requires a target URL" };
  }
  try {
    await page.goto(action.target, { timeout: 10000 });
    return { success: true, resultingUrl: page.url() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
