import type { Page } from "playwright";
import type { ResolvedTaskRequest } from "../types/task-request.js";
import type { Captures, ErrorCategory, Observation, StepLog } from "../types/task-response.js";
import type { SelectedAction } from "../types/actions.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { buildObservation, readElementState } from "../observation/observationBuilder.js";
import type { Decision, ReasoningProvider } from "../reasoning/reasoningProvider.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import { checkLimitsBreach, validateDecision, type LimitBreach, type SafetyCheckResult } from "../safety/index.js";
import { dispatchAction } from "../actions/index.js";
import { captureDataLayer } from "../capture-modules/dataLayer.js";
import { diffDataLayer, readDataLayerSnapshot, type DataLayerSnapshot } from "../capture-modules/dataLayerDelta.js";
import { buildCtaClickCapture, readClickedElementDetails } from "../capture-modules/ctaClicks.js";
import { GA4_ACTION_WINDOW_MS } from "../capture-modules/ga4NetworkEvents.js";
import { buildJourneyPathEntry } from "../capture-modules/journeyPath.js";
import { classifyActionFailure, recordDiagnosticError } from "../capture-modules/errors.js";
import { captureHostContextSnapshot } from "../capture-modules/hostContext.js";
import { evaluateSuccessCriteria, getMissingRequiredCriteriaIds, type SuccessCriteriaEvidence } from "./successEvaluator.js";
import type { ActionAnalytics } from "../types/task-response.js";
import type { RunState } from "./state.js";

export type TerminalStatus =
  | "success"
  | "blocked"
  | "failure"
  | "max_steps_reached"
  | "max_backtracks_reached"
  | "max_duration_reached"
  | "container_memory_threshold_reached";

// Bounds both stages of blocker/stale-target recovery (item 4 of the fix): how many extra
// decision/revalidation cycles a step's pre-dispatch check may spend before dispatching
// anyway, and how many *consecutive* dispatched-but-stale failures the run tolerates
// before giving up with a precise reason. Fixed and generic -- not consent-specific, not
// task-configurable -- because it exists purely to stop an unproductive loop, not to
// express any policy about what the reasoning layer should do.
const MAX_STALE_TARGET_RECOVERY_ATTEMPTS = 3;

export interface LoopStepOutcome {
  stepLog: StepLog;
  terminal?: TerminalStatus;
  finishReason?: string;
}

export async function runStep(params: {
  page: Page;
  task: ResolvedTaskRequest;
  state: RunState;
  captures: Captures;
  reasoning: ReasoningProvider;
  actionNavigationTimeoutMs: number;
  semanticVerifier?: SemanticCriterionVerifier;
  /** See runTask's own param of the same name (src/core/engine.ts). */
  isMemoryThresholdBreached?: () => boolean;
}): Promise<LoopStepOutcome> {
  const { page, task, state, captures, reasoning, actionNavigationTimeoutMs, semanticVerifier, isMemoryThresholdBreached } =
    params;
  const stepIndex = state.stepCount;

  let observation = await buildObservation(page);
  state.recordVisit(observation.url);

  // Bounded, names-only cookie/storage footprint (never a value -- see
  // capture-modules/hostContext.ts), captured only on the step this run's hostname
  // actually changes (including the very first step, giving a landing-host baseline) --
  // lets a caller empirically confirm from Get Task Result whether state carried across a
  // cross-host navigation, without the engine ever guessing at what any of it means.
  let currentHostname: string | undefined;
  try {
    currentHostname = new URL(observation.url).hostname;
  } catch {
    currentHostname = undefined;
  }
  if (task.captureModules.includes("host_context_snapshot") && currentHostname !== state.lastObservedHostname) {
    const snapshot = await captureHostContextSnapshot(page, stepIndex);
    captures.host_context_snapshot = [...(captures.host_context_snapshot ?? []), snapshot];
  }
  state.lastObservedHostname = currentHostname;

  // Unlike the explicit `capture` action, dataLayer evidence must reflect every page in
  // the journey (its initial pushes and whatever accumulated by the time each step runs),
  // so it is sampled opportunistically on every step rather than only when requested.
  if (task.captureModules.includes("data_layer_evidence")) {
    const dataLayerEntry = await captureDataLayer(page, stepIndex);
    captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), dataLayerEntry];
  }

  (
    await evaluateSuccessCriteria(
      page,
      task.successCriteria,
      task.objective,
      semanticVerifier,
      state.satisfiedCriteriaIds,
      undefined,
      buildCriteriaEvidence(captures),
    )
  ).forEach((id) => state.satisfiedCriteriaIds.add(id));

  const limitsBreach = checkLimitsBreach(
    {
      limits: { stepCount: state.stepCount, backtrackCount: state.backtrackCount, startedAtMs: state.startedAtMs },
      actionHistory: state.actionHistory,
      visitedUrls: state.visitedUrls,
    },
    task.limits,
  );

  // Checked only when no hard limit has already fired -- a run that has simultaneously
  // exhausted, say, maxSteps and the memory threshold reports the pre-existing limit
  // breach, since that check already ran above and takes precedence by evaluation order.
  const memoryThresholdBreached = !limitsBreach && (isMemoryThresholdBreached?.() ?? false);

  if (limitsBreach || memoryThresholdBreached) {
    // Non-null: this branch only runs when limitsBreach || memoryThresholdBreached, so
    // when memoryThresholdBreached is false, limitsBreach must be truthy here.
    const breachReason: string = memoryThresholdBreached ? "container_memory_threshold" : (limitsBreach as LimitBreach);
    const forcedAction: SelectedAction = { type: limitsBreach === "max_backtracks" ? "stop_blocked" : "stop_failure" };
    state.recordAction(forcedAction);
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        stepIndex,
        category: "limit_stop",
        severity: "critical",
        pageUrl: observation.url,
        message: memoryThresholdBreached
          ? "Container memory circuit breaker threshold reached; stopping the run before the container's own memory limit is hit."
          : `Hard limit reached: ${limitsBreach}.`,
        recoverable: false,
        stoppedRun: true,
      });
    }
    const stepLog = buildStepLog({
      stepIndex,
      observation,
      decision: memoryThresholdBreached
        ? "Container memory circuit breaker threshold reached before another action could be taken."
        : "Hard limit reached before another action could be taken.",
      selectedAction: forcedAction,
      actionResult: { success: true },
      satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
      safetyFlags: [breachReason],
      reObservationAttempted: false,
      recoveryAttempts: 0,
    });
    recordJourneyPathEntry(captures, task.captureModules, stepLog);
    return {
      stepLog,
      terminal: memoryThresholdBreached
        ? "container_memory_threshold_reached"
        : limitsBreach === "max_steps"
          ? "max_steps_reached"
          : limitsBreach === "max_backtracks"
            ? "max_backtracks_reached"
            : "max_duration_reached",
      finishReason: breachReason,
    };
  }

  let { decision, safetyResult, effectiveAction } = await obtainDecision({ task, state, observation, reasoning });

  // Before dispatching a click, revalidate the target against the *live* page rather than
  // trusting the (possibly now-stale) observation the decision was made from -- the async
  // round trip to the reasoning provider is enough time for an SPA to re-render, an
  // overlay to appear/disappear, or an element to be removed entirely. A target that has
  // gone stale is never blindly clicked: the reasoning provider is asked again, with a
  // fresh observation, so it can pick a different, currently-valid target -- bounded (item
  // 4 of the blocker-recovery fix) so a page that keeps re-rendering a still-unusable
  // target cannot spin this step forever. If every attempt is exhausted, the *last*
  // decision is dispatched unchanged -- the click executor's own pre-dispatch check and
  // last-resort destinationUrl fallback (actions/click.ts) remain the final safety net,
  // and a resulting staleTarget failure is itself now non-fatal (see below) rather than
  // ending the whole run.
  // Accumulates destinationUrl evidence for every element id seen in *any* observation
  // taken this step (not just the latest one) -- a target that keeps getting re-proposed
  // across bounded recovery attempts can go from present-with-a-destinationUrl to fully
  // detached (dropped from the observation entirely) between one buildObservation call and
  // the next, and the click executor's last-resort fallback (actions/click.ts) still needs
  // that evidence even though the *current* observation no longer carries it.
  const knownDestinationUrls = new Map<string, string>();
  const rememberDestinationUrls = (obs: Observation) => {
    for (const el of obs.interactiveElements) {
      if (el.destinationUrl) {
        knownDestinationUrls.set(el.id, el.destinationUrl);
      }
    }
  };
  rememberDestinationUrls(observation);

  let reObservationAttempted = false;
  let recoveryAttempts = 0;
  while (
    effectiveAction.type === "click" &&
    effectiveAction.target &&
    recoveryAttempts < MAX_STALE_TARGET_RECOVERY_ATTEMPTS &&
    !(await readElementState(page, effectiveAction.target)).actionable
  ) {
    reObservationAttempted = true;
    recoveryAttempts += 1;
    const freshObservation = await buildObservation(page);
    rememberDestinationUrls(freshObservation);
    const retry = await obtainDecision({ task, state, observation: freshObservation, reasoning });
    observation = freshObservation;
    decision = retry.decision;
    safetyResult = retry.safetyResult;
    effectiveAction = retry.effectiveAction;
  }

  if (!safetyResult.allowed && task.captureModules.includes("errors")) {
    const limitFlags = new Set(["max_steps", "max_backtracks", "max_duration", "loop_detected"]);
    const category: ErrorCategory = safetyResult.flags.some((flag) => limitFlags.has(flag))
      ? "limit_stop"
      : "safety_guard_stop";
    recordDiagnosticError(captures, {
      stepIndex,
      category,
      severity: "critical",
      pageUrl: observation.url,
      actionType: decision.action.type,
      ...(decision.action.target ? { targetElementId: decision.action.target } : {}),
      message: `Run stopped by guardrail(s): ${safetyResult.flags.join(", ")}.`,
      recoverable: false,
      stoppedRun: true,
    });
  }

  // Element attributes must be read before the click executes: a click can navigate
  // away, taking the clicked element's DOM node with it.
  const wantsCtaClickCapture = task.captureModules.includes("cta_clicks");
  const wantsDataLayerDelta = wantsCtaClickCapture && task.captureModules.includes("data_layer_evidence");
  const wantsGa4Window = wantsCtaClickCapture && task.captureModules.includes("ga4_network_events");
  const isClick = effectiveAction.type === "click";
  const clickedElementDetails =
    wantsCtaClickCapture && isClick && effectiveAction.target
      ? await readClickedElementDetails(page, effectiveAction.target)
      : undefined;

  // Generic, action-attributed analytics capture (see docs/n8n-integration.md "Generic
  // action-attributed analytics capture"): before-state evidence for the dataLayer delta
  // and GA4 window correlation below is read now, immediately before dispatch, so it
  // reflects this click's true starting point rather than an earlier step's.
  const dataLayerBefore: DataLayerSnapshot | undefined =
    wantsDataLayerDelta && isClick ? await readDataLayerSnapshot(page).catch(() => ({ available: false, raw: [] })) : undefined;
  const ga4WindowStartIndex = wantsGa4Window && isClick ? (captures.ga4_network_events?.length ?? 0) : undefined;

  const actionResult = await dispatchAction({
    page,
    action: effectiveAction,
    captures,
    stepIndex,
    captureModules: task.captureModules,
    allowedDomains: task.allowedDomains,
    actionNavigationTimeoutMs,
    reObservationAttempted: effectiveAction.type === "click" ? reObservationAttempted : undefined,
    knownDestinationUrl:
      effectiveAction.type === "click" && effectiveAction.target
        ? knownDestinationUrls.get(effectiveAction.target)
        : undefined,
  });

  // A staleTarget-classified failure (see actions/click.ts) means the target went stale
  // between decision and dispatch, not that the decision was actually wrong -- it is
  // tracked as a bounded, non-fatal recovery condition (item 4 of the blocker-recovery
  // fix) rather than immediately ending the run, exactly like the reported production
  // failure needed. staleTargetExhausted is computed here and consulted again at the
  // terminal-status decision near the end of this function.
  let staleTargetExhausted = false;
  if (!actionResult.success && actionResult.staleTarget) {
    state.consecutiveStaleTargetFailures += 1;
    staleTargetExhausted = state.consecutiveStaleTargetFailures > MAX_STALE_TARGET_RECOVERY_ATTEMPTS;
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        stepIndex,
        category: "stale_target_recovery",
        severity: staleTargetExhausted ? "critical" : "warning",
        pageUrl: observation.url,
        actionType: effectiveAction.type,
        ...(effectiveAction.target ? { targetElementId: effectiveAction.target } : {}),
        message: staleTargetExhausted
          ? `Click target repeatedly went stale before dispatch could succeed ` +
            `(${state.consecutiveStaleTargetFailures} consecutive occurrences, limit ` +
            `${MAX_STALE_TARGET_RECOVERY_ATTEMPTS}); giving up. ${actionResult.error ?? ""}`
          : `Click target went stale before dispatch could succeed (${state.consecutiveStaleTargetFailures}/` +
            `${MAX_STALE_TARGET_RECOVERY_ATTEMPTS} consecutive occurrences); re-observing and continuing. ` +
            `${actionResult.error ?? ""}`,
        recoverable: !staleTargetExhausted,
        stoppedRun: staleTargetExhausted,
      });
    }
  } else if (!actionResult.success) {
    state.consecutiveStaleTargetFailures = 0;
    if (task.captureModules.includes("errors")) {
      const targetKnownMissing =
        effectiveAction.type === "click" &&
        (!effectiveAction.target || !observation.interactiveElements.some((el) => el.id === effectiveAction.target));
      const category = classifyActionFailure({
        actionType: effectiveAction.type,
        targetKnownMissing,
        errorMessage: actionResult.error,
      });
      recordDiagnosticError(captures, {
        stepIndex,
        category,
        severity: "critical",
        pageUrl: observation.url,
        actionType: effectiveAction.type,
        ...(effectiveAction.target ? { targetElementId: effectiveAction.target } : {}),
        message: actionResult.error ?? `${effectiveAction.type} action failed.`,
        recoverable: false,
        stoppedRun: true,
      });
    }
  } else {
    state.consecutiveStaleTargetFailures = 0;
  }

  // After-state evidence for this same click, gathered before success criteria are
  // re-evaluated below so newlySatisfiedCriteriaIds/verifierDecisions can be attributed to
  // it too. GA4 requests can lag slightly behind a click's synchronous return (especially
  // just before a navigation), so a short bounded wait is applied -- but only when a task
  // actually asked for ga4_network_events correlation; every other run is unaffected.
  let resultingTitle: string | undefined;
  let dataLayerAfter: DataLayerSnapshot | undefined;
  let ga4WindowEndIndex: number | undefined;
  if (wantsCtaClickCapture && isClick) {
    if (actionResult.success) {
      resultingTitle = await page.title().catch(() => undefined);
    }
    if (wantsGa4Window) {
      await page.waitForTimeout(GA4_ACTION_WINDOW_MS).catch(() => undefined);
      ga4WindowEndIndex = captures.ga4_network_events?.length ?? 0;
    }
    if (wantsDataLayerDelta) {
      dataLayerAfter = await readDataLayerSnapshot(page).catch(() => ({ available: false, raw: [] }));
    }
  }

  state.recordAction(effectiveAction);

  const satisfiedCountBeforeThisAction = state.satisfiedCriteriaIds.size;
  const verifierDecisionCountBefore = semanticVerifier?.getUsageDiagnostics?.()?.decisions?.length ?? 0;
  const newlySatisfied = await evaluateSuccessCriteria(
    page,
    task.successCriteria,
    task.objective,
    semanticVerifier,
    state.satisfiedCriteriaIds,
    wantsCtaClickCapture && isClick ? clickedElementDetails : undefined,
    buildCriteriaEvidence(captures),
  );
  newlySatisfied.forEach((id) => state.satisfiedCriteriaIds.add(id));

  if (wantsCtaClickCapture && isClick) {
    const advancedJourney =
      Boolean(actionResult.resultingUrl && actionResult.resultingUrl !== observation.url) ||
      Boolean(resultingTitle && resultingTitle !== observation.title) ||
      newlySatisfied.length > 0 ||
      state.satisfiedCriteriaIds.size > satisfiedCountBeforeThisAction;

    const verifierDecisions = wantsCtaClickCapture
      ? semanticVerifier?.getUsageDiagnostics?.()?.decisions?.slice(verifierDecisionCountBefore)
      : undefined;

    const actionAnalytics: ActionAnalytics = {
      ...(wantsDataLayerDelta && dataLayerBefore && dataLayerAfter
        ? { dataLayerDelta: diffDataLayer(dataLayerBefore, dataLayerAfter) }
        : {}),
      ...(wantsGa4Window
        ? {
            ga4RequestsObservedDuringActionWindow: (captures.ga4_network_events ?? []).slice(
              ga4WindowStartIndex,
              ga4WindowEndIndex,
            ),
          }
        : {}),
      advancedJourney,
      ...(newlySatisfied.length > 0 ? { newlySatisfiedCriteriaIds: newlySatisfied } : {}),
      ...(verifierDecisions && verifierDecisions.length > 0 ? { verifierDecisions } : {}),
    };

    const ctaClick = buildCtaClickCapture({
      stepIndex,
      sourcePageUrl: observation.url,
      sourcePageTitle: observation.title,
      details: clickedElementDetails,
      actionResult,
      resultingTitle,
      actionAnalytics,
    });
    captures.cta_clicks = [...(captures.cta_clicks ?? []), ctaClick];
  }

  // A stop_success decision is only ever a *proposal* from the reasoning layer -- the
  // engine is the sole authority on whether the objective was actually reached. Every
  // criterion with required: true (the schema default) must be present in
  // satisfiedCriteriaIds before stop_success is honoured; optional criteria remain
  // supporting evidence only and never gate this check. A task with no required
  // criteria (every entry explicitly required: false) always yields an empty list here,
  // so stop_success is accepted unconditionally -- identical to pre-enforcement behaviour.
  const missingRequiredCriteriaIds =
    effectiveAction.type === "stop_success"
      ? getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds)
      : [];
  const stopSuccessRejected = missingRequiredCriteriaIds.length > 0;

  // Generic, criterion-type-agnostic staleness guard: if this rejected stop_success has
  // the *exact same* evidence fingerprint (page URL + satisfied + missing required
  // criteria) as the immediately preceding rejected stop_success, nothing changed between
  // the two proposals -- another reasoning call would just be spent re-asking the same
  // question against the same evidence. One repeat is always allowed (a provider gets one
  // chance to receive updated satisfiedCriteriaIds and try again); a second consecutive
  // proposal with zero new evidence ends the run deterministically instead of waiting for
  // the generic repeated-action safety guard several steps later. See task requirements on
  // repeated-decision and cost control.
  let noProgressDetected = false;
  if (stopSuccessRejected) {
    const fingerprint = buildStopSuccessFingerprint(observation.url, missingRequiredCriteriaIds, [
      ...state.satisfiedCriteriaIds,
    ]);
    noProgressDetected = state.lastRejectedStopSuccessFingerprint === fingerprint;
    state.lastRejectedStopSuccessFingerprint = fingerprint;
  }

  const stepLog = buildStepLog({
    stepIndex,
    observation,
    decision: decision.rationale,
    selectedAction: effectiveAction,
    actionResult,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
    safetyFlags: stopSuccessRejected
      ? [
          ...safetyResult.flags,
          "required_criteria_unsatisfied",
          ...(noProgressDetected ? ["no_progress_detected"] : []),
        ]
      : safetyResult.flags,
    reObservationAttempted,
    recoveryAttempts,
  });
  recordJourneyPathEntry(captures, task.captureModules, stepLog);

  if (effectiveAction.type === "stop_success") {
    if (!stopSuccessRejected) {
      return { stepLog, terminal: "success", finishReason: "stop_success_action" };
    }
    if (noProgressDetected) {
      return { stepLog, terminal: "failure", finishReason: "no_progress_required_criteria_unmet" };
    }
    // Rejected, but this is the first time this exact evidence was seen: fall through
    // without setting `terminal` so the loop keeps running -- checkLimitsBreach (top of
    // the next runStep call) remains the hard ceiling regardless.
    return { stepLog };
  }
  if (effectiveAction.type === "stop_blocked") {
    return { stepLog, terminal: "blocked", finishReason: safetyResult.flags[0] ?? "stop_blocked_action" };
  }
  if (effectiveAction.type === "stop_failure") {
    return { stepLog, terminal: "failure", finishReason: "stop_failure_action" };
  }
  if (!actionResult.success) {
    // A staleTarget failure that hasn't exhausted its bounded allowance is not terminal:
    // fall through so the outer loop (core/engine.ts) calls runStep again, which starts
    // with a brand-new buildObservation and gives the reasoning provider another chance --
    // exactly the behaviour the reported production failure needed instead of ending the
    // whole task on one race. Once exhausted (or for any non-stale failure), this remains
    // a hard stop with a precise, distinct reason.
    if (actionResult.staleTarget && !staleTargetExhausted) {
      return { stepLog };
    }
    return {
      stepLog,
      terminal: "failure",
      finishReason: actionResult.staleTarget ? "stale_target_recovery_exhausted" : "action_execution_error",
    };
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
  reObservationAttempted: boolean;
  recoveryAttempts: number;
}): StepLog {
  const {
    stepIndex,
    observation,
    decision,
    selectedAction,
    actionResult,
    satisfiedCriteriaIds,
    safetyFlags,
    reObservationAttempted,
    recoveryAttempts,
  } = params;
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
    ...(reObservationAttempted ? { reObservationAttempted } : {}),
    ...(recoveryAttempts > 0 ? { recoveryAttempts } : {}),
  };
}

function buildStopSuccessFingerprint(url: string, missingRequiredCriteriaIds: string[], satisfiedCriteriaIds: string[]): string {
  return JSON.stringify({
    url,
    missing: [...missingRequiredCriteriaIds].sort(),
    satisfied: [...satisfiedCriteriaIds].sort(),
  });
}

/**
 * Builds the evidence a data_layer_event/network_event success criterion is checked
 * against (see core/successEvaluator.ts) from whatever this run's own captures have
 * already accumulated -- never a second, independent read. Absent when the corresponding
 * capture module wasn't requested (undefined field, not an empty array, so the evaluator
 * can tell "no evidence source" apart from "source present but empty" purely for clarity;
 * both behave the same way, no match).
 */
function buildCriteriaEvidence(captures: Captures): SuccessCriteriaEvidence {
  return {
    ...(captures.data_layer_evidence
      ? { dataLayerEntries: captures.data_layer_evidence.flatMap((entry) => entry.raw) }
      : {}),
    ...(captures.ga4_network_events
      ? { networkEvents: captures.ga4_network_events as unknown as readonly Record<string, unknown>[] }
      : {}),
  };
}

function recordJourneyPathEntry(captures: Captures, captureModules: CaptureModuleName[], stepLog: StepLog): void {
  if (!captureModules.includes("journey_path")) {
    return;
  }
  captures.journey_path = [...(captures.journey_path ?? []), buildJourneyPathEntry(stepLog)];
}

/**
 * Asks the reasoning provider for one decision against the given observation and runs it
 * through the safety layer, producing the action that will actually be dispatched.
 * Factored out so runStep can call it a second time -- with a freshly rebuilt observation
 * -- when the first decision's click target turns out to be stale (see runStep above).
 */
async function obtainDecision(params: {
  task: ResolvedTaskRequest;
  state: RunState;
  observation: Observation;
  reasoning: ReasoningProvider;
}): Promise<{ decision: Decision; safetyResult: SafetyCheckResult; effectiveAction: SelectedAction }> {
  const { task, state, observation, reasoning } = params;

  const decision = await reasoning.decide({
    objective: task.objective,
    successCriteria: task.successCriteria,
    allowedActions: task.safety.allowedActions,
    allowedDomains: task.allowedDomains,
    limits: {
      maxSteps: task.limits.maxSteps,
      maxBacktracks: task.limits.maxBacktracks,
      stepsUsed: state.stepCount,
      backtracksUsed: state.backtrackCount,
    },
    observation,
    recentActions: state.actionHistory,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
    consentInteractionPolicy: task.safety.consentInteractionPolicy ?? "reject_optional",
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
  return { decision, safetyResult, effectiveAction };
}
