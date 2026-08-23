import type { Page } from "playwright";
import type { TaskRequest } from "../types/task-request.js";
import type { Captures, EngineAssessment, StepLog, TaskResponse } from "../types/task-response.js";
import type { ReasoningProvider } from "../reasoning/reasoningProvider.js";
import { RunState } from "./state.js";
import { runStep, type TerminalStatus } from "./loop.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { attachGa4NetworkCapture } from "../capture-modules/ga4NetworkEvents.js";

const ENGINE_VERSION = "0.1.0-poc";

export async function runTask(params: {
  page: Page;
  task: TaskRequest;
  reasoning?: ReasoningProvider;
}): Promise<TaskResponse> {
  const { page, task } = params;
  const state = new RunState();
  const captures: Captures = {};

  if (!checkNavigationAllowed(task.startUrl, task.allowedDomains)) {
    return buildTerminalResponse({
      task,
      state,
      captures,
      steps: [],
      status: "blocked",
      finishReason: "domain_blocked",
      statusReason: "startUrl is outside allowedDomains",
      finalUrl: task.startUrl,
    });
  }

  // GA4-style requests can fire on the very first page load, so the listener must be
  // attached before that first navigation, and only when the task actually asked for it.
  const detachGa4Capture = task.captureModules.includes("ga4_network_events")
    ? attachGa4NetworkCapture(page, captures, () => state.stepCount)
    : undefined;

  try {
    try {
      await page.goto(task.startUrl, { timeout: 15000 });
    } catch (error) {
      return buildTerminalResponse({
        task,
        state,
        captures,
        steps: [],
        status: "failure",
        finishReason: "initial_navigation_error",
        statusReason: error instanceof Error ? error.message : String(error),
        finalUrl: task.startUrl,
      });
    }

    const steps: StepLog[] = [];
    let terminal: TerminalStatus | undefined;
    let finishReason = "loop_exhausted";

    while (!terminal) {
      const outcome = await runStep({ page, task, state, captures, reasoning: params.reasoning });
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
    });
  } finally {
    detachGa4Capture?.();
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
}): TaskResponse {
  const { task, state, captures, steps, status, finishReason, statusReason, finalUrl } = params;
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

  return {
    schemaVersion: "1.0.0",
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
    },
  };
}
