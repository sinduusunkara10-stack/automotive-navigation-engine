import type { Page } from "playwright";
import type { TaskRequest } from "../types/task-request.js";
import type { Captures, EngineAssessment, StepLog, TaskResponse } from "../types/task-response.js";
import type { ReasoningProvider } from "../reasoning/reasoningProvider.js";
import { MockReasoningProvider } from "../reasoning/mockReasoningProvider.js";
import { RunState } from "./state.js";
import { runStep, type TerminalStatus } from "./loop.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { attachGa4NetworkCapture } from "../capture-modules/ga4NetworkEvents.js";
import { attachErrorCapture, recordDiagnosticError } from "../capture-modules/errors.js";
import { navigateInitialPage } from "./initialNavigation.js";
import { readInitialNavigationTimeoutMs } from "../config/initialNavigationConfig.js";
import { readActionNavigationTimeoutMs } from "../config/actionNavigationConfig.js";

const ENGINE_VERSION = "0.1.0-poc";

export async function runTask(params: {
  page: Page;
  task: TaskRequest;
  reasoning?: ReasoningProvider;
  initialNavigationTimeoutMs?: number;
  actionNavigationTimeoutMs?: number;
}): Promise<TaskResponse> {
  const { page, task } = params;
  const state = new RunState();
  const captures: Captures = {};
  // Resolved once per run (rather than left to loop.ts's per-step default) so the same
  // provider instance -- and therefore its decision log -- is used for every step, which
  // diagnostics.reasoningProvider aggregation below depends on.
  const reasoning = params.reasoning ?? new MockReasoningProvider();
  // Overridable per-call for tests; the real API server resolves these once at startup
  // (src/api/server.ts) from INITIAL_NAVIGATION_TIMEOUT_MS / ACTION_NAVIGATION_TIMEOUT_MS
  // so a misconfigured value fails clearly at boot rather than per-run.
  const initialNavigationTimeoutMs = params.initialNavigationTimeoutMs ?? readInitialNavigationTimeoutMs();
  const actionNavigationTimeoutMs = params.actionNavigationTimeoutMs ?? readActionNavigationTimeoutMs();

  if (!checkNavigationAllowed(task.startUrl, task.allowedDomains)) {
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        category: "safety_guard_stop",
        severity: "critical",
        pageUrl: task.startUrl,
        message: "startUrl is outside allowedDomains; run blocked before navigation.",
        recoverable: false,
        stoppedRun: true,
      });
    }
    return buildTerminalResponse({
      task,
      state,
      captures,
      steps: [],
      status: "blocked",
      finishReason: "domain_blocked",
      statusReason: "startUrl is outside allowedDomains",
      finalUrl: task.startUrl,
      reasoning,
    });
  }

  // GA4-style requests (and, when requested, page errors/console errors/failed network
  // requests) can fire on the very first page load, so listeners must be attached before
  // that first navigation, and only when the task actually asked for them.
  const detachGa4Capture = task.captureModules.includes("ga4_network_events")
    ? attachGa4NetworkCapture(page, captures, () => state.stepCount)
    : undefined;
  const detachErrorCapture = task.captureModules.includes("errors")
    ? attachErrorCapture(page, captures, () => state.stepCount)
    : undefined;

  try {
    const initialNavigation = await navigateInitialPage({
      page,
      startUrl: task.startUrl,
      allowedDomains: task.allowedDomains,
      timeoutMs: initialNavigationTimeoutMs,
    });

    if (initialNavigation.status === "failed") {
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          category: "navigation_failure",
          severity: "critical",
          pageUrl: task.startUrl,
          message: initialNavigation.message ?? "Initial navigation failed.",
          recoverable: false,
          stoppedRun: true,
        });
      }
      return buildTerminalResponse({
        task,
        state,
        captures,
        steps: [],
        status: "failure",
        finishReason: "initial_navigation_error",
        statusReason: initialNavigation.message ?? "Initial navigation failed.",
        finalUrl: initialNavigation.url,
        reasoning,
      });
    }

    if (initialNavigation.status === "recovered" && task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        category: "navigation_failure",
        severity: "warning",
        pageUrl: initialNavigation.url,
        message: initialNavigation.message ?? "Initial navigation timed out but recovered.",
        recoverable: true,
        stoppedRun: false,
      });
    }

    const steps: StepLog[] = [];
    let terminal: TerminalStatus | undefined;
    let finishReason = "loop_exhausted";

    while (!terminal) {
      const outcome = await runStep({ page, task, state, captures, reasoning, actionNavigationTimeoutMs });
      steps.push(outcome.stepLog);
      if (outcome.terminal) {
        terminal = outcome.terminal;
        finishReason = outcome.finishReason ?? terminal;
      }
    }

    const lastStep = steps[steps.length - 1];
    return buildTerminalResponse({
      task,
      state,
      captures,
      steps,
      status: terminal,
      finishReason,
      statusReason: finishReason,
      finalUrl: lastStep ? lastStep.currentUrl : task.startUrl,
      reasoning,
    });
  } finally {
    detachGa4Capture?.();
    detachErrorCapture?.();
  }
}

function buildTerminalResponse(params: {
  task: TaskRequest;
  state: RunState;
  captures: Captures;
  steps: StepLog[];
  status: TerminalStatus;
  finishReason: string;
  statusReason: string;
  finalUrl: string;
  reasoning: ReasoningProvider;
}): TaskResponse {
  const { task, state, captures, steps, status, finishReason, statusReason, finalUrl, reasoning } = params;
  const lastStep = steps[steps.length - 1];
  const objectiveAchieved = status === "success";

  const engineAssessment: EngineAssessment = {
    objectiveAchieved,
    confidence: objectiveAchieved ? 1 : 0,
    summary: objectiveAchieved
      ? "The engine reached a step where all required success criteria were satisfied and selected stop_success."
      : `The run ended with status "${status}" (${finishReason}).`,
    ...(lastStep ? { satisfiedSuccessCriteriaIds: lastStep.progress.satisfiedCriteriaIds } : {}),
  };

  const reasoningProviderDiagnostics = reasoning.getUsageDiagnostics?.();

  return {
    schemaVersion: "1.1.0",
    taskId: task.taskId,
    status,
    statusReason,
    startUrl: task.startUrl,
    finalUrl,
    steps,
    captures,
    engineAssessment,
    diagnostics: {
      stepCount: state.stepCount,
      backtrackCount: state.backtrackCount,
      totalDurationMs: Date.now() - state.startedAtMs,
      finishReason,
      engineVersion: ENGINE_VERSION,
      ...(reasoningProviderDiagnostics ? { reasoningProvider: reasoningProviderDiagnostics } : {}),
    },
  };
}
