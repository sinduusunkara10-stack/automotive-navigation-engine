import { chromium } from "playwright";
import { runTask } from "../core/engine.js";
import { createReasoningProvider } from "../reasoning/providerFactory.js";
import type { TaskRequest } from "../types/task-request.js";
import * as taskStore from "./taskStore.js";

/**
 * Runs the existing engine loop and records the outcome in the task store.
 * Intentionally not awaited by the HTTP handler that starts it — POST /v1/tasks returns
 * as soon as the run is accepted, per the submit-and-poll design in
 * docs/n8n-integration.md. The reasoning provider is selected per run from
 * REASONING_PROVIDER (mock by default; see docs/architecture.md §6 and README.md) —
 * never touches a real website, n8n, Google Sheets, or BigQuery regardless of provider.
 */
export async function executeTaskAsync(runId: string, task: TaskRequest): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const reasoning = createReasoningProvider();
    browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const result = await runTask({ page, task, reasoning });
      taskStore.completeRun(runId, result);
    } finally {
      await page.close();
    }
  } catch {
    taskStore.failRun(runId, "Task execution failed before a result could be produced.");
  } finally {
    await browser?.close().catch(() => {});
  }
}
