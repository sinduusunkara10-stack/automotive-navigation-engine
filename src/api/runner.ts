import { chromium, type Page } from "playwright";
import { runTask } from "../core/engine.js";
import { createReasoningProvider } from "../reasoning/providerFactory.js";
import { readClaudeReasoningConfig } from "../reasoning/config.js";
import { ClaudeSemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { TaskRequest } from "../types/task-request.js";
import type { TaskStore } from "./taskStore.js";
import { recordMemorySample } from "../core/memoryDiagnostics.js";
import { readLowMemoryBrowserMode } from "../config/lowMemoryBrowserConfig.js";
import { attachLowMemoryResourceRouting } from "./browserResourceRouting.js";

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

// --disable-gpu (above) only turns off hardware acceleration -- WebGL content still gets
// software-rasterized (e.g. via SwiftShader) and its context/texture/framebuffer memory is
// still allocated. These two flags make canvas.getContext("webgl"/"webgl2") return null
// instead, so that allocation never happens at all. Applied only under
// LOW_MEMORY_BROWSER_MODE (see readLowMemoryBrowserMode) since it can visibly break a
// WebGL-rendered page (e.g. a 3D viewer) -- see docs/architecture.md "Low-memory browser
// mode".
const WEBGL_DISABLE_LAUNCH_ARGS = ["--disable-webgl", "--disable-webgl2"];

export function buildLaunchArgs(lowMemoryMode: boolean): string[] {
  return lowMemoryMode ? [...MEMORY_SAFE_LAUNCH_ARGS, ...WEBGL_DISABLE_LAUNCH_ARGS] : MEMORY_SAFE_LAUNCH_ARGS;
}

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
  newPage(options?: { serviceWorkers?: "allow" | "block" }): Promise<Page>;
  close(): Promise<void>;
}

function defaultLaunchBrowser(): Promise<RunnerBrowser> {
  return chromium.launch({ args: buildLaunchArgs(readLowMemoryBrowserMode(process.env)) });
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
    // Opt-in, off by default -- see docs/architecture.md "Low-memory browser mode". Blocks
    // image/media/font requests and disallows service worker registration; never touches
    // document/script/stylesheet/xhr/fetch, and never disables JavaScript.
    const lowMemoryMode = readLowMemoryBrowserMode(process.env);
    browser = await launchBrowser();
    const page = await browser.newPage(lowMemoryMode ? { serviceWorkers: "block" } : undefined);
    const routing = lowMemoryMode ? attachLowMemoryResourceRouting(page) : undefined;
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
      // Routing must be detached while the page is still open; page.close() is
      // best-effort cleanup and must never flip an otherwise-successful run to "failed".
      await routing?.detach().catch(() => {});
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
    // Cleared so the outer finally's own browser?.close() below doesn't double-close an
    // already-closed browser on this (successful) path.
    browser = undefined;
    if (routing) {
      result.diagnostics.resourceRouting = routing.diagnostics();
    }
    result.diagnostics.memory = recordMemorySample(result.diagnostics.memory ?? [], "after_cleanup");
    await store.completeRun(runId, result);
  } catch {
    await store.failRun(runId, "Task execution failed before a result could be produced.");
  } finally {
    clearInterval(heartbeat);
    await browser?.close().catch(() => {});
  }
}
