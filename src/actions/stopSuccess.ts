import type { ActionExecutorResult } from "../types/task-response.js";

export async function executeStopSuccess(): Promise<ActionExecutorResult> {
  return { success: true };
}
