import { chromium } from "playwright";
import { runTask } from "../core/engine.js";
import { createReasoningProvider } from "../reasoning/providerFactory.js";
import { readClaudeReasoningConfig } from "../reasoning/config.js";
import { ClaudeSemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { TaskRequest } from "../types/task-request.js";
import * as taskStore from "./taskStore.js";

/**
 * Wires up the optional multilingual semantic-criterion verifier for this run. Only when
 * REASONING_PROVIDER=claude: it reuses the exact same ANTHROPIC_API_KEY/model/timeout
 * config already required for navigation decisions (no new credential, no new external
 * dependency), via its own bounded, structured-output call, entirely separate from
 * navigation decisions (see src/reasoning/semanticCriterionVerifier.ts). The mock
 * provider (default, and every existing task/test that doesn't set REASONING_PROVIDER)
 * gets no verifier at all -- semantic_page_match stays exactly the deterministic
 * lexical-only check it always was, unchanged.
 */
function createSemanticVerifier(env: NodeJS.ProcessEnv): SemanticCriterionVerifier | undefined {
  if (env.REASONING_PROVIDER?.trim() !== "claude") {
    return undefined;
  }
  return new ClaudeSemanticCriterionVerifier({ config: readClaudeReasoningConfig(env) });
}

/**
 * Runs the existing engine loop and records the outcome in the task store.
 * Intentionally not awaited by the HTTP handler that starts it — POST /v1/tasks returns
 * as soon as the run is accepted, per the submit-and-poll design in
 * docs/n8n-integration.md. The reasoning provider is selected per run from
 * REASONING_PROVIDER (mock by default; see docs/architecture.md §6 and README.md) —
 * never touches a real website, n8n, Google Sheets, or BigQuery regardless of provider.
 */
export async function executeTaskAsync(
  runId: string,
  task: TaskRequest,
  initialNavigationTimeoutMs?: number,
  actionNavigationTimeoutMs?: number,
): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const reasoning = createReasoningProvider();
    const semanticVerifier = createSemanticVerifier(process.env);
    browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const result = await runTask({
        page,
        task,
        reasoning,
        initialNavigationTimeoutMs,
        actionNavigationTimeoutMs,
        semanticVerifier,
      });
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
