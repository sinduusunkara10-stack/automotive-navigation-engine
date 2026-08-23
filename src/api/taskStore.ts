import type { TaskResponse } from "../types/task-response.js";

export type RunStatus = "running" | "completed" | "failed";

export interface RunRecord {
  runId: string;
  taskId: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  result?: TaskResponse;
  error?: string;
}

/**
 * Proof-of-concept task store: in-memory only. All runs are lost when the process
 * restarts — there is no persistence layer in this phase (see docs/n8n-integration.md).
 */
const runs = new Map<string, RunRecord>();

export function createRun(runId: string, taskId: string): RunRecord {
  const now = new Date().toISOString();
  const record: RunRecord = { runId, taskId, status: "running", createdAt: now, updatedAt: now };
  runs.set(runId, record);
  return record;
}

export function getRun(runId: string): RunRecord | undefined {
  return runs.get(runId);
}

export function completeRun(runId: string, result: TaskResponse): void {
  const record = runs.get(runId);
  if (!record) return;
  record.status = "completed";
  record.result = result;
  record.updatedAt = new Date().toISOString();
}

export function failRun(runId: string, error: string): void {
  const record = runs.get(runId);
  if (!record) return;
  record.status = "failed";
  record.error = error;
  record.updatedAt = new Date().toISOString();
}
