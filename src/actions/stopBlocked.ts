import type { ActionExecutorResult } from "../types/task-response.js";

export async function executeStopBlocked(): Promise<ActionExecutorResult> {
  return { success: true };
}
