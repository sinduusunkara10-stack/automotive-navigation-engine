import type { Page } from "playwright";
import type { TaskRequest } from "../types/task-request.js";
import type { Captures, StepLog } from "../types/task-response.js";
import type { SelectedAction } from "../types/actions.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { buildObservation } from "../observation/observationBuilder.js";
import { MockReasoningProvider } from "../reasoning/mockReasoningProvider.js";
import type { ReasoningProvider } from "../reasoning/reasoningProvider.js";
import { checkLimitsBreach, validateDecision } from "../safety/index.js";
import { dispatchAction } from "../actions/index.js";
import { captureDataLayer } from "../capture-modules/dataLayer.js";
import { buildCtaClickCapture, readClickedElementDetails } from "../capture-modules/ctaClicks.js";
import { buildJourneyPathEntry } from "../capture-modules/journeyPath.js";
import { evaluateSuccessCriteria } from "./successEvaluator.js";
import type { RunState } from "./state.js";

export type TerminalStatus =
  | "success"
  | "blocked"
  | "failure"
  | "max_steps_reached"
  | "max_backtracks_reached"
  | "max_duration_reached";

export interface LoopStepOutcome {
  stepLog: StepLog;
  terminal?: TerminalStatus;
  finishReason?: string;
}

export async function runStep(params: {
  page: Page;
  task: TaskRequest;
  state: RunState;
  captures: Captures;
  reasoning?: ReasoningProvider;
}): Promise<LoopStepOutcome> {
  const { page, task, state, captures } = params;
  const reasoning = params.reasoning ?? new MockReasoningProvider();
  const stepIndex = state.stepCount;

  const observation = await buildObservation(page);
  state.recordVisit(observation.url);

  // Unlike the explicit `capture` action, dataLayer evidence must reflect every page in
  // the journey (its initial pushes and whatever accumulated by the time each step runs),
  // so it is sampled opportunistically on every step rather than only when requested.
  if (task.captureModules.includes("data_layer_evidence")) {
    const dataLayerEntry = await captureDataLayer(page, stepIndex);
    captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), dataLayerEntry];
  }

  (await evaluateSuccessCriteria(page, task.successCriteria)).forEach((id) => state.satisfiedCriteriaIds.add(id));

  const limitsBreach = checkLimitsBreach(
    {
      limits: { stepCount: state.stepCount, backtrackCount: state.backtrackCount, startedAtMs: state.startedAtMs },
      actionHistory: state.actionHistory,
      visitedUrls: state.visitedUrls,
    },
    task.limits,
  );

  if (limitsBreach) {
    const forcedAction: SelectedAction = { type: limitsBreach === "max_backtracks" ? "stop_blocked" : "stop_failure" };
    state.recordAction(forcedAction);
    const stepLog = buildStepLog({
      stepIndex,
      observation,
      decision: "Hard limit reached before another action could be taken.",
      selectedAction: forcedAction,
      actionResult: { success: true },
      satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
      safetyFlags: [limitsBreach],
    });
    recordJourneyPathEntry(captures, task.captureModules, stepLog);
    return {
      stepLog,
      terminal:
        limitsBreach === "max_steps"
          ? "max_steps_reached"
          : limitsBreach === "max_backtracks"
            ? "max_backtracks_reached"
            : "max_duration_reached",
      finishReason: limitsBreach,
    };
  }

  const decision = await reasoning.decide({
    objective: task.objective,
    successCriteria: task.successCriteria,
    allowedActions: task.safety.allowedActions,
    observation,
    recentActions: state.actionHistory,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
  });

  const safetyResult = validateDecision({
    action: decision.action,
    safety: task.safety,
    limits: task.limits,
    allowedDomains: task.allowedDomains,
    state: {
      limits: { stepCount: state.stepCount, backtrackCount: state.backtrackCount, startedAtMs: state.startedAtMs },
      actionHistory: state.actionHistory,
      visitedUrls: state.visitedUrls,
    },
  });

  const effectiveAction: SelectedAction = safetyResult.allowed ? decision.action : { type: "stop_blocked" };

  // Element attributes must be read before the click executes: a click can navigate
  // away, taking the clicked element's DOM node with it.
  const wantsCtaClickCapture = task.captureModules.includes("cta_clicks");
  const clickedElementDetails =
    wantsCtaClickCapture && effectiveAction.type === "click" && effectiveAction.target
      ? await readClickedElementDetails(page, effectiveAction.target)
      : undefined;

  const actionResult = await dispatchAction({
    page,
    action: effectiveAction,
    captures,
    stepIndex,
    captureModules: task.captureModules,
  });

  if (wantsCtaClickCapture && effectiveAction.type === "click") {
    const ctaClick = buildCtaClickCapture({
      stepIndex,
      sourcePageUrl: observation.url,
      sourcePageTitle: observation.title,
      details: clickedElementDetails,
      actionResult,
    });
    captures.cta_clicks = [...(captures.cta_clicks ?? []), ctaClick];
  }

  state.recordAction(effectiveAction);
  (await evaluateSuccessCriteria(page, task.successCriteria)).forEach((id) => state.satisfiedCriteriaIds.add(id));

  const stepLog = buildStepLog({
    stepIndex,
    observation,
    decision: decision.rationale,
    selectedAction: effectiveAction,
    actionResult,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
    safetyFlags: safetyResult.flags,
  });
  recordJourneyPathEntry(captures, task.captureModules, stepLog);

  if (effectiveAction.type === "stop_success") {
    return { stepLog, terminal: "success", finishReason: "stop_success_action" };
  }
  if (effectiveAction.type === "stop_blocked") {
    return { stepLog, terminal: "blocked", finishReason: safetyResult.flags[0] ?? "stop_blocked_action" };
  }
  if (effectiveAction.type === "stop_failure") {
    return { stepLog, terminal: "failure", finishReason: "stop_failure_action" };
  }
  if (!actionResult.success) {
    return { stepLog, terminal: "failure", finishReason: "action_execution_error" };
  }

  return { stepLog };
}

function buildStepLog(params: {
  stepIndex: number;
  observation: StepLog["observation"];
  decision: string;
  selectedAction: SelectedAction;
  actionResult: StepLog["actionResult"];
  satisfiedCriteriaIds: string[];
  safetyFlags: string[];
}): StepLog {
  const { stepIndex, observation, decision, selectedAction, actionResult, satisfiedCriteriaIds, safetyFlags } =
    params;
  return {
    stepIndex,
    timestamp: new Date().toISOString(),
    currentUrl: observation.url,
    observation,
    decision,
    selectedAction,
    actionResult,
    progress: {
      satisfiedCriteriaIds,
      estimatedCompletion: satisfiedCriteriaIds.length === 0 ? 0 : 1,
    },
    ...(safetyFlags.length > 0 ? { safetyFlags } : {}),
  };
}

function recordJourneyPathEntry(captures: Captures, captureModules: CaptureModuleName[], stepLog: StepLog): void {
  if (!captureModules.includes("journey_path")) {
    return;
  }
  captures.journey_path = [...(captures.journey_path ?? []), buildJourneyPathEntry(stepLog)];
}
