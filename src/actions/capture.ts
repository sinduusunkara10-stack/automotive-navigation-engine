import type { Page } from "playwright";
import type { ActionResult, Captures } from "../types/task-response.js";
import { capturePageVisit } from "../capture-modules/pageVisits.js";

export async function executeCapture(page: Page, captures: Captures, stepIndex: number): Promise<ActionResult> {
  const visit = await capturePageVisit(page, stepIndex);
  captures.page_visits = [...(captures.page_visits ?? []), visit];
  return { success: true, resultingUrl: page.url() };
}
