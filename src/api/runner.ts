import { chromium, type Page } from "playwright";
import { runTask } from "../core/engine.js";
import { createReasoningProvider } from "../reasoning/providerFactory.js";
import { readClaudeReasoningConfig } from "../reasoning/config.js";
import { ClaudeSemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { TaskRequest } from "../types/task-request.js";
import type { TaskStore } from "./taskStore.js";
import { recordMemorySample } from "../core/memoryDiagnostics.js";

// Reduces Chromium's own memory footprint without touching anything that affects
// rendering fidelity or multi-frame behavior (observationBuilder.ts depends on both being
// unchanged) -- see docs/architecture.md "Memory stability". Deliberately excludes
// --single-process (destabilizes multi-frame handling this engine relies on).
const MEMORY_SAFE_LAUNCH_ARGS = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--metrics-recording-only",
  "--mute-audio",
  "--no-first-run",
];

function createSemanticVerifier(env: NodeJS.ProcessEnv): SemanticCriterionVerifier | undefined {
  if (env.REASONING_PROVIDER?.trim() !== "claude") {
    return undefined;
  }
  return new ClaudeSemanticCriterionVerifier({ config: readClaudeReasoningConfig(env) });
}

/** The minimal browser surface this module actually uses -- a real Playwright Browser
 * satisfies it structurally. Kept narrow, and injectable via launchBrowser below, purely
 * so tests can exercise executeTaskAsync's cleanup ordering (e.g. a page.close() failure,
 * or a launch failure) without needing a real Chromium process for every scenario. */
export interface RunnerBrowser {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}

function defaultLaunchBrowser(): Promise<RunnerBrowser> {
  return chromium.launch({ args: MEMORY_SAFE_LAUNCH_ARGS });
}

export async function executeTaskAsync(
  runId: string,
  task: TaskRequest,
  store: TaskStore,
  initialNavigationTimeoutMs?: number,
  actionNavigationTimeoutMs?: number,
  heartbeatIntervalMs?: number,
  launchBrowser: () => Promise<RunnerBrowser> = defaultLaunchBrowser,
): Promise<void> {
  let browser: RunnerBrowser | undefined;
  // Refreshes the run record's updatedAt (and worker ownership) while this run is active,
  // so a reader can tell a genuinely in-progress run apart from one whose owning process
  // is gone -- see staleDetection.ts. Cleared unconditionally in the outer finally so it
  // never outlives this run, on any exit path.
  const heartbeat = setInterval(() => {
    void store.heartbeat(runId);
  }, heartbeatIntervalMs ?? 15000);
  try {
    const reasoning = createReasoningProvider();
    const semanticVerifier = createSemanticVerifier(process.env);
    browser = await launchBrowser();
    const page = await browser.newPage();
    let result;
    try {
      result = await runTask({
        page,
        task,
        reasoning,
        initialNavigationTimeoutMs,
        actionNavigationTimeoutMs,
        semanticVerifier,
      });
    } finally {
      // Never let a page.close() failure flip an otherwise-successful run to "failed" --
      // close is best-effort cleanup, not part of the run's own outcome.
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    // Cleared so the outer finally's own browser?.close() below doesn't double-close an
    // already-closed browser on this (successful) path.
    browser = undefined;
    result.diagnostics.memory = recordMemorySample(result.diagnostics.memory ?? [], "after_cleanup");
    await store.completeRun(runId, result);
  } catch {
    await store.failRun(runId, "Task execution failed before a result could be produced.");
  } finally {
    clearInterval(heartbeat);
    await browser?.close().catch(() => {});
  }
}
