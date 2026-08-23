import type { ActionResult } from "../types/task-response.js";

export async function executeStopBlocked(): Promise<ActionResult> {
  return { success: true };
}
