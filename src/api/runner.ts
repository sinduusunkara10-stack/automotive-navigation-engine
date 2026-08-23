import { chromium } from "playwright";
import { runTask } from "../core/engine.js";
import { MockReasoningProvider } from "../reasoning/mockReasoningProvider.js";
import type { TaskRequest } from "../types/task-request.js";
import * as taskStore from "./taskStore.js";

const reasoning = new MockReasoningProvider();

/**
 * Runs the existing engine loop against the mock reasoning provider and records the
 * outcome in the task store. Intentionally not awaited by the HTTP handler that starts
 * it — POST /v1/tasks returns as soon as the run is accepted, per the submit-and-poll
 * design in docs/n8n-integration.md.
 */
export async function executeTaskAsync(runId: string, task: TaskRequest): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
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
