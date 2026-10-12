import type { ActionExecutorResult } from "../types/task-response.js";

export async function executeStopFailure(): Promise<ActionExecutorResult> {
  return { success: true };
}
