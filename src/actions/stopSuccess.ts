import type { ActionResult } from "../types/task-response.js";

export async function executeStopSuccess(): Promise<ActionResult> {
  return { success: true };
}
