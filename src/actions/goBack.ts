import type { Page } from "playwright";
import type { ActionResult } from "../types/task-response.js";

export async function executeGoBack(page: Page): Promise<ActionResult> {
  try {
    await page.goBack({ timeout: 5000 });
    return { success: true, resultingUrl: page.url() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
