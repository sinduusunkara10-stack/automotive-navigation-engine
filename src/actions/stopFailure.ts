import type { ActionResult } from "../types/task-response.js";

export async function executeStopFailure(): Promise<ActionResult> {
  return { success: true };
}
