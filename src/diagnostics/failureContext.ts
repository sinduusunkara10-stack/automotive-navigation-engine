import type { Page } from "playwright";
import type { RunState } from "../core/state.js";
import { getMissingRequiredCriteriaIds } from "../core/successEvaluator.js";
import { capPreservingEnds } from "../core/boundedArray.js";
import type { ReasoningProvider } from "../reasoning/reasoningProvider.js";
import type { TaskRequest } from "../types/task-request.js";
import type { StepLog } from "../types/task-response.js";
import type {
  EngineFailureContext,
  FailurePartialDiagnostics,
  FailureStepSummary,
} from "../types/failureDiagnostics.js";

/** Cap applied to each exported record collection that has no tighter limit of its own. */
export const MAX_FAILURE_RECORDS = 50;
const KEEP_FIRST_RECORDS = 10;
const MAX_RATIONALE_CHARS = 500;
const MAX_ERROR_CHARS = 300;

function cap<T>(items: readonly T[]): T[] {
  return capPreservingEnds(items, MAX_FAILURE_RECORDS, KEEP_FIRST_RECORDS);
}

function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function summarizeStep(step: StepLog): FailureStepSummary {
  const action = step.selectedAction;
  const targetElementId = "target" in action && typeof action.target === "string" ? action.target : undefined;
  const result = step.actionResult;
  return {
    stepIndex: step.stepIndex,
    at: step.timestamp,
    urlBefore: step.currentUrl,
    ...(result.resultingUrl ? { urlAfter: result.resultingUrl } : {}),
    actionType: action.type,
    ...(targetElementId ? { targetElementId } : {}),
    rationale: step.decision.slice(0, MAX_RATIONALE_CHARS),
    success: result.success,
    ...(result.error ? { error: result.error.slice(0, MAX_ERROR_CHARS) } : {}),
    ...(result.interactionOutcome ? { interactionOutcome: result.interactionOutcome } : {}),
    ...(result.surfaceAdopted !== undefined ? { surfaceAdopted: result.surfaceAdopted } : {}),
    ...(step.safetyFlags && step.safetyFlags.length > 0 ? { safetyFlags: step.safetyFlags } : {}),
  };
}

function buildPartialDiagnostics(state: RunState, steps: readonly StepLog[], reasoning: ReasoningProvider): FailurePartialDiagnostics {
  const decisions = attempt(() => reasoning.getUsageDiagnostics?.()?.decisions ?? [], []);
  return {
    steps: cap(steps.map(summarizeStep)),
    surfaceAdoption: { attempts: cap(state.surfaceAdoptionDiagnostics), returnAttempts: state.surfaceReturnAttempts },
    recovery: { attempts: cap(state.recoveryAttemptDiagnostics), routeAttempts: cap(state.routeAttemptDiagnostics) },
    alternativeExploration: { candidates: cap(state.alternativeCandidateDiagnostics) },
    reasoningDecisions: cap(
      decisions.map((d) => ({
        ...(d.stepIndex !== undefined ? { stepIndex: d.stepIndex } : {}),
        attempt: d.attempt,
        outcome: d.outcome,
        ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
        latencyMs: d.latencyMs,
      })),
    ),
    milestoneEvidence: cap(state.milestoneEvidence),
    journeyMemory: {
      guidanceUsed: state.journeyMemoryGuidanceUsed,
      influencedDecisions: cap(state.journeyMemoryInfluencedDecisions),
      fallbackExplorationUsed: state.journeyMemoryFallbackExplorationUsed,
      ...(state.journeyMemoryRecoveryCallDiagnostic ? { recoveryCall: state.journeyMemoryRecoveryCallDiagnostic } : {}),
    },
  };
}

/**
 * Collects everything a thrown run already gathered, text/metadata only, every collection
 * capped. Best-effort throughout: a failure while collecting diagnostics never masks the
 * original error.
 */
export function buildEngineFailureContext(params: {
  task: TaskRequest;
  state: RunState;
  mainPage: Page;
  steps: readonly StepLog[];
  reasoning: ReasoningProvider;
}): EngineFailureContext {
  const { task, state, mainPage, steps, reasoning } = params;
  const activePage = state.effectivePage ?? mainPage;
  const currentUrl = attempt(() => activePage.url(), undefined);
  const mainPageUrl = attempt(() => mainPage.url(), undefined);
  const missingRequiredCriteriaIds = attempt(
    () => getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds),
    [] as string[],
  );
  return {
    stepCount: state.stepCount,
    ...(currentUrl ? { currentUrl } : {}),
    ...(mainPageUrl ? { mainPageUrl } : {}),
    activeSurface: state.activeSurface,
    activePageId: state.pageLifecycle.pageId(activePage),
    activePageClosed: attempt(() => activePage.isClosed(), true),
    ...(state.lastAttemptedAction ? { lastAttemptedAction: state.lastAttemptedAction } : {}),
    ...(missingRequiredCriteriaIds.length > 0 ? { missingRequiredCriteriaIds } : {}),
    partialDiagnostics: attempt(() => buildPartialDiagnostics(state, steps, reasoning), undefined),
    pageLifecycle: state.pageLifecycle.getEvents(),
    actionTrace: state.pageLifecycle.getActionTrace(),
  };
}
