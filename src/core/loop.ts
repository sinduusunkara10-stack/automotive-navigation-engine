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
import { MAIN_CONTEXT_ID } from "../capture-modules/captureContext.js";
import { diffDataLayer, readDataLayerSnapshot, type DataLayerSnapshot } from "../capture-modules/dataLayerDelta.js";
import { buildCtaClickCapture, readClickedElementDetails } from "../capture-modules/ctaClicks.js";
import { GA4_ACTION_WINDOW_MS } from "../capture-modules/ga4NetworkEvents.js";
import { buildJourneyPathEntry } from "../capture-modules/journeyPath.js";
import { classifyActionFailure, recordDiagnosticError } from "../capture-modules/errors.js";
import { captureHostContextSnapshot } from "../capture-modules/hostContext.js";
import { computeCandidateIdentity, computeDecisionPointFingerprint } from "./routeMemory.js";
import {
  computeEstimatedCompletion,
  computeMilestoneRollup,
  evaluateSuccessCriteria,
  getMissingRequiredCriteriaIds,
  type SuccessCriteriaEvidence,
} from "./successEvaluator.js";
import type { ActionAnalytics } from "../types/task-response.js";
import type { RunState } from "./state.js";
import {
  DEFAULT_MAX_BRANCH_DEPTH,
  MAX_CANDIDATE_BUDGET_PER_DECISION_POINT,
  assessBranchProgress,
  classifyClosureFromSafetyFlags,
  computeEffectiveBranchDepth,
  isAmbiguousMultiCandidateDecisionPoint,
  type BranchRecord,
} from "./branchExploration.js";

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

// Bounded journey replanning (see docs/architecture.md "Bounded journey replanning"): how
// many times one run may substitute the existing go_back action for a stop_blocked action
// -- proposed directly by the reasoning layer, or substituted by the safety layer for a
// decision it rejected (domain_blocked, action_not_allowed, repeated_action, loop_detected)
// -- before the engine finally honours stop_blocked and ends the run. Fixed and generic --
// not consent-specific, not task-configurable, and not a confidence threshold -- exists
// purely to give the reasoning layer a small number of chances to back up onto an
// already-seen page and try a different route before giving up. Never a way to relax the
// existing maxSteps/maxBacktracks hard ceilings: every substituted go_back is still recorded
// through the normal state.recordAction path any other go_back uses, so those ceilings
// (checked again at the very top of the next runStep call regardless) remain the actual stop.
const MAX_JOURNEY_REPLANNING_ATTEMPTS = 2;

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
  // See RunState.resolveLastActionProgress: fills in observedProgress on the action
  // recorded by the *previous* step, purely by comparing that action's before-state (also
  // just recorded url/title) against this fresh observation -- generic, no extra page
  // interaction beyond the buildObservation call every step already performs.
  state.resolveLastActionProgress(observation.url, observation.title);
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
    const dataLayerEntries = await captureDataLayer(page, stepIndex, { contextId: MAIN_CONTEXT_ID });
    captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), ...dataLayerEntries];
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
      { sink: state.milestoneEvidence, stepIndex, phase: "pre_action" },
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
    state.recordAction(forcedAction, { url: observation.url, title: observation.title });
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
      successCriteria: task.successCriteria,
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

  // Goal-Directed Bounded Branch Exploration (see core/branchExploration.ts): while a
  // branch is active, this block decides, before any reasoning call, whether to (a)
  // recognise the objective itself as already satisfied (closing the branch as "success"
  // and falling through to a completely ordinary decision this same step -- no forced
  // action, no return needed), (b) assess the branch's own progress from existing evidence
  // and close it early on a dead end (never a bare Claude assertion), or (c) perform the
  // next hop of an already-in-progress, fingerprint-verified return to the branch's own
  // origin decision point. Only ever engages when state.activeBranch is set; a run with no
  // branch active (every pre-existing task, and every ordinary decision point) skips this
  // block entirely and behaves exactly as it did before this phase.
  if (state.activeBranch) {
    const branch = state.activeBranch;
    const currentFingerprint = computeDecisionPointFingerprint(observation);

    if (!branch.result) {
      if (getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds).length === 0) {
        branch.result = "success";
        state.routeMemory.recordBranchResult(branch.decisionPointId, branch.candidateId, {
          depthReached: branch.depth,
          result: "success",
        });
        state.archiveActiveBranch();
      } else {
        const lastAction = state.actionHistory[state.actionHistory.length - 1];
        // A step whose last action produced no observable page-state change (
        // observedProgress === false) never left the current page in the first place --
        // re-observing the exact same, already-visited fingerprint here is not a genuine
        // "the branch looped back to an earlier state" revisit, just "nothing happened
        // yet". That distinct case is what the dedicated consecutive-no-progress check
        // (assessBranchProgress) exists to catch instead; only a fingerprint reached via
        // an action that *did* change something (a real navigation) is compared against
        // -- and recorded into -- visitedFingerprints, so the two DEAD END triggers stay
        // meaningfully distinct rather than the no-progress case always being pre-empted
        // by a trivial same-page "revisit".
        const stayedOnSamePage = lastAction?.observedProgress === false;
        const isRevisitFingerprint = !stayedOnSamePage && branch.visitedFingerprints.includes(currentFingerprint);
        if (!stayedOnSamePage && !isRevisitFingerprint) {
          branch.visitedFingerprints.push(currentFingerprint);
        }
        const newlySatisfiedThisStep = [...state.satisfiedCriteriaIds].filter(
          (id) => !branch.satisfiedCriteriaIdsAtEntry.includes(id) && !branch.newlySatisfiedCriteriaIds.includes(id),
        );
        if (newlySatisfiedThisStep.length > 0) {
          branch.newlySatisfiedCriteriaIds.push(...newlySatisfiedThisStep);
        }
        const assessment = assessBranchProgress({
          depth: branch.depth,
          maxDepth: branch.maxDepth,
          isRevisitFingerprint,
          lastActionObservedProgress: lastAction?.observedProgress,
          consecutiveNoProgress: branch.consecutiveNoProgress,
          newlySatisfiedCountThisStep: newlySatisfiedThisStep.length,
          hasAnyNewlySatisfiedInBranch: branch.newlySatisfiedCriteriaIds.length > 0,
        });
        branch.consecutiveNoProgress = assessment.consecutiveNoProgress;
        if (!assessment.shouldContinue) {
          branch.result = assessment.result;
          branch.returnHopsBudget = branch.depth + 1;
          state.routeMemory.recordBranchResult(branch.decisionPointId, branch.candidateId, {
            depthReached: branch.depth,
            result: assessment.result,
          });
          if (task.captureModules.includes("errors")) {
            recordDiagnosticError(captures, {
              stepIndex,
              category: "safety_guard_stop",
              severity: "warning",
              pageUrl: observation.url,
              message: `Bounded branch "${branch.candidateLabel}" ended (${assessment.result}): ${assessment.reason} Returning toward the original decision point.`,
              recoverable: true,
              stoppedRun: false,
            });
          }
        }
      }
    }

    if (branch.result && branch.result !== "success" && branch.returnStatus !== "restored") {
      // Branch closed unproductively: perform (or continue) the bounded,
      // fingerprint-verified return sequence toward its own recorded decisionPointId,
      // reusing the exact same go_back execution/accounting PR #41's own journey
      // replanning uses -- never more than the fixed number of hops this specific
      // branch's own recorded depth implies. Never assumes browser-history depth equals
      // branch depth: each hop is followed by a fresh fingerprint check (at the top of
      // the *next* runStep call, since that's when the next observation exists), not a
      // fixed count of go_backs dispatched blindly in a row.
      if (currentFingerprint === branch.decisionPointId) {
        branch.returnStatus = "restored";
        state.archiveActiveBranch();
        // Falls through below to a completely ordinary decision this same step.
      } else if (
        branch.returnHopsAttempted >= branch.returnHopsBudget ||
        !task.safety.allowedActions.includes("go_back") ||
        state.backtrackCount >= task.limits.maxBacktracks ||
        state.stepCount + 1 >= task.limits.maxSteps
      ) {
        branch.returnStatus = "restore_failed";
        state.archiveActiveBranch();
        const forcedAction: SelectedAction = { type: "stop_blocked" };
        state.recordAction(forcedAction, { url: observation.url, title: observation.title });
        if (task.captureModules.includes("errors")) {
          recordDiagnosticError(captures, {
            stepIndex,
            category: "safety_guard_stop",
            severity: "critical",
            pageUrl: observation.url,
            message:
              `Could not verify a return to the original decision point after bounded branch ` +
              `"${branch.candidateLabel}" ended (${branch.result}); stopping the run rather than ` +
              `continuing from an unverified position.`,
            recoverable: false,
            stoppedRun: true,
          });
        }
        const stepLog = buildStepLog({
          stepIndex,
          observation,
          decision:
            `The original decision point could not be safely restored after bounded branch ` +
            `"${branch.candidateLabel}" ended (${branch.result}); stopping.`,
          selectedAction: forcedAction,
          actionResult: { success: true },
          satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
          successCriteria: task.successCriteria,
          safetyFlags: ["branch_restore_failed"],
          reObservationAttempted: false,
          recoveryAttempts: 0,
        });
        recordJourneyPathEntry(captures, task.captureModules, stepLog);
        return { stepLog, terminal: "blocked", finishReason: "decision_point_restore_failed" };
      } else {
        branch.returnHopsAttempted += 1;
        const forcedAction: SelectedAction = { type: "go_back" };
        const returnActionResult = await dispatchAction({
          page,
          action: forcedAction,
          captures,
          stepIndex,
          captureModules: task.captureModules,
          allowedDomains: task.allowedDomains,
          actionNavigationTimeoutMs,
        });
        state.recordAction(forcedAction, { url: observation.url, title: observation.title });
        if (!returnActionResult.success) {
          branch.returnStatus = "restore_failed";
          state.archiveActiveBranch();
          if (task.captureModules.includes("errors")) {
            recordDiagnosticError(captures, {
              stepIndex,
              category: "safety_guard_stop",
              severity: "critical",
              pageUrl: observation.url,
              actionType: "go_back",
              message: `A return hop toward the original decision point failed to execute (${returnActionResult.error ?? "unknown error"}); stopping.`,
              recoverable: false,
              stoppedRun: true,
            });
          }
          const stepLog = buildStepLog({
            stepIndex,
            observation,
            decision: `Branch return hop ${branch.returnHopsAttempted}/${branch.returnHopsBudget} for bounded branch "${branch.candidateLabel}" failed to execute; the original decision point could not be restored.`,
            selectedAction: forcedAction,
            actionResult: returnActionResult,
            satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
            successCriteria: task.successCriteria,
            safetyFlags: ["branch_restore_failed"],
            reObservationAttempted: false,
            recoveryAttempts: 0,
          });
          recordJourneyPathEntry(captures, task.captureModules, stepLog);
          return { stepLog, terminal: "blocked", finishReason: "decision_point_restore_failed" };
        }
        const stepLog = buildStepLog({
          stepIndex,
          observation,
          decision: `Branch return (hop ${branch.returnHopsAttempted}/${branch.returnHopsBudget}): returning toward the original decision point after bounded branch "${branch.candidateLabel}" ended (${branch.result}).`,
          selectedAction: forcedAction,
          actionResult: returnActionResult,
          satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
          successCriteria: task.successCriteria,
          safetyFlags: ["branch_return_attempted"],
          reObservationAttempted: false,
          recoveryAttempts: 0,
        });
        recordJourneyPathEntry(captures, task.captureModules, stepLog);
        return { stepLog };
      }
    }
  }

  // Generic obstruction-persistence check (see RunState.lastBlocker* fields): if the
  // target that most recently failed as covered/intercepted is, per a fresh, direct
  // re-check, still covered by the exact same intercepting element, nothing about the
  // page has changed since that failure -- a fresh reasoning call is likely to just
  // encounter the same obstruction again under a different target, exactly as the
  // reported production incident did across four different targets. One repeat is always
  // allowed (a provider gets one chance to react); a second consecutive occurrence of the
  // identical signature skips the reasoning call entirely and is recorded as a
  // deterministic stale-target outcome instead -- feeding the same
  // consecutiveStaleTargetFailures ceiling maxSteps/maxBacktracks-style hard limits
  // already use, so a permanently stuck overlay still exhausts and stops the run (item 6),
  // just without spending further reasoning-provider calls to discover that. Keyed only on
  // the intercepting element's own generic signature, never on what kind of overlay it is
  // -- applies identically to consent and non-consent obstructions (item 8).
  if (state.lastBlockerTargetId && state.lastBlockerSignature) {
    const recheck = await readElementState(page, state.lastBlockerTargetId);
    const sameBlockerStillPresent = recheck.covered && recheck.coveredBySignature === state.lastBlockerSignature;
    if (sameBlockerStillPresent && state.blockerSignatureRepeatCount >= 1) {
      const blockedTargetId = state.lastBlockerTargetId;
      state.consecutiveStaleTargetFailures += 1;
      const staleTargetExhausted = state.consecutiveStaleTargetFailures > MAX_STALE_TARGET_RECOVERY_ATTEMPTS;
      const forcedAction: SelectedAction = { type: "click", target: blockedTargetId };
      state.recordAction(forcedAction, { url: observation.url, title: observation.title });
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "stale_target_recovery",
          severity: staleTargetExhausted ? "critical" : "warning",
          pageUrl: observation.url,
          actionType: "click",
          targetElementId: blockedTargetId,
          message: staleTargetExhausted
            ? `The same obstruction (intercepting-element signature unchanged) persisted across ` +
              `${state.consecutiveStaleTargetFailures} consecutive occurrences, limit ` +
              `${MAX_STALE_TARGET_RECOVERY_ATTEMPTS}; giving up without spending another reasoning call.`
            : `The same obstruction (intercepting-element signature unchanged) is still present; ` +
              `skipping a reasoning call against an unchanged blocked page state.`,
          recoverable: !staleTargetExhausted,
          stoppedRun: staleTargetExhausted,
        });
      }
      const stepLog = buildStepLog({
        stepIndex,
        observation,
        decision:
          "Skipped a reasoning call: the element that intercepted the previous attempt still blocks the same target.",
        selectedAction: forcedAction,
        actionResult: { success: false, staleTarget: true, error: "persistent_blocker_signature_unchanged" },
        satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
        successCriteria: task.successCriteria,
        safetyFlags: ["persistent_blocker_detected"],
        reObservationAttempted: false,
        recoveryAttempts: 0,
      });
      recordJourneyPathEntry(captures, task.captureModules, stepLog);
      return {
        stepLog,
        ...(staleTargetExhausted
          ? { terminal: "failure" as TerminalStatus, finishReason: "stale_target_recovery_exhausted" }
          : {}),
      };
    }
    if (sameBlockerStillPresent) {
      state.blockerSignatureRepeatCount += 1;
    } else {
      state.lastBlockerTargetId = undefined;
      state.lastBlockerSignature = undefined;
      state.blockerSignatureRepeatCount = 0;
    }
  }
  // Nothing tracked yet: intentionally left untracked here rather than seeding from
  // whichever covered element happens to appear first in DOM order. An observationally
  // covered element carries no evidence it is actually relevant to this run's objective --
  // seeding from it let an early, unrelated covered element (e.g. a page header link
  // sitting under a full-page overlay) become the tracked "blocker target" purely because
  // of its DOM position, well before any real decision or dispatched action ever touched
  // it, and the deterministic-skip path above would then march toward
  // stale_target_recovery_exhausted against that irrelevant target without the reasoning
  // provider ever getting a real attempt at the objective-relevant control. Tracking is
  // seeded exactly once elsewhere in this function: after a real click actually fails as
  // covered/intercepted (see the post-dispatch staleTarget handling below), which anchors
  // it to the target a real decision selected or the effective action that actually
  // failed, never to an arbitrary DOM-order guess.

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
  // Local to this one step's retry budget (distinct from RunState.lastBlockerSignature's
  // cross-step tracking above): if the exact same intercepting element blocks two
  // consecutive candidate targets *within this same while loop*, a further reasoning call
  // is unlikely to help -- stop retrying here rather than spending the full
  // MAX_STALE_TARGET_RECOVERY_ATTEMPTS reasoning calls probing different targets all
  // blocked by an unchanged page state. The loop still falls through to dispatch the last
  // decision, exactly as before -- only the number of reasoning calls spent getting there
  // changes.
  let withinStepBlockerSignature: string | undefined;
  while (effectiveAction.type === "click" && effectiveAction.target && recoveryAttempts < MAX_STALE_TARGET_RECOVERY_ATTEMPTS) {
    const liveState = await readElementState(page, effectiveAction.target);
    if (liveState.actionable) {
      break;
    }
    if (liveState.covered && liveState.coveredBySignature && liveState.coveredBySignature === withinStepBlockerSignature) {
      break;
    }
    withinStepBlockerSignature = liveState.coveredBySignature;

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

  // Goal-Directed Bounded Branch Exploration: while a branch is actively being explored, a
  // safety-layer rejection of the decision that would have continued it (or the reasoning
  // layer itself proposing stop_blocked mid-branch) closes the branch immediately --
  // "dead_end"/"blocked"/"unsafe" per classifyClosureFromSafetyFlags -- and begins its own
  // bounded, fingerprint-verified return sequence (continued, hop by hop, by the block at
  // the top of this function) in place of PR #41's own single-hop stop_blocked
  // substitution just below, which remains the fallback only for a stop_blocked situation
  // *outside* any active branch, exactly as before this phase.
  const branchActiveAndExploring = Boolean(state.activeBranch && !state.activeBranch.result);
  let branchReturnAttempted = false;
  // Captured here (rather than re-read from state.branchHistory/activeBranch later) since
  // the branch may or may not have been archived yet by the time the step log is built --
  // this keeps that later text correct regardless of which path below was taken.
  let branchClosureResultForLog: BranchRecord["result"];
  if (branchActiveAndExploring && effectiveAction.type === "stop_blocked") {
    const branch = state.activeBranch as BranchRecord;
    const closureResult = safetyResult.allowed ? "dead_end" : classifyClosureFromSafetyFlags(safetyResult.flags);
    branch.result = closureResult;
    branchClosureResultForLog = closureResult;
    state.routeMemory.recordBranchResult(branch.decisionPointId, branch.candidateId, {
      depthReached: branch.depth,
      result: closureResult,
    });
    if (task.safety.allowedActions.includes("go_back")) {
      branch.returnHopsBudget = branch.depth + 1;
      branch.returnHopsAttempted += 1;
      effectiveAction = { type: "go_back" };
      branchReturnAttempted = true;
    } else {
      // go_back is not an allowed action at all -- there is no way to even attempt a
      // return, so the branch is closed unrestored and the existing stop_blocked handling
      // below runs unmodified (effectiveAction is still stop_blocked).
      branch.returnStatus = "restore_failed";
      state.archiveActiveBranch();
    }
  }

  // Bounded journey replanning (see MAX_JOURNEY_REPLANNING_ATTEMPTS above): decided here,
  // before the safety-guard diagnostic immediately below is written, so that diagnostic
  // accurately reflects whether the run is actually about to stop or is instead being given
  // one more bounded chance. Applies identically whether stop_blocked was proposed directly
  // by the reasoning layer or substituted by the safety layer for a rejected decision -- the
  // engine never inspects which. Only engaged when go_back is itself one of this task's
  // allowedActions (never a way around that restriction), when there is a previous *distinct*
  // page to actually go back to, and when one more go_back would not itself already exceed
  // maxBacktracks/maxSteps -- those hard ceilings are re-checked independently at the top of
  // the next runStep call regardless, so this is a conservative early check, never the sole
  // enforcement of either. Never engaged while a branch is actively exploring
  // (branchActiveAndExploring above already handled or is handling that case) -- PR #41
  // remains the fallback only outside an active branch.
  //
  // Safe replanning / go_back fix: state.distinctVisitedUrls.size (not visitedUrls.length,
  // and not a step count) is what actually answers "has the browser genuinely been on more
  // than one page this run" -- visitedUrls grows by one every single step regardless of
  // whether the URL changed, which previously let a run stuck re-observing the same
  // (falsely-reported-successful) page for several steps look identical to one that had
  // genuinely visited a second page. The explicit "not already on about:blank" check is
  // additional, defense-in-depth protection against ever selecting go_back from a
  // content-free state at all -- see actions/goBack.ts, which now also refuses to execute
  // such a call itself, making a blind go_back from about:blank impossible regardless of
  // which of these two layers would otherwise have let it through.
  const journeyReplanningEligible =
    !branchActiveAndExploring &&
    !branchReturnAttempted &&
    effectiveAction.type === "stop_blocked" &&
    state.journeyReplanningAttempts < MAX_JOURNEY_REPLANNING_ATTEMPTS &&
    task.safety.allowedActions.includes("go_back") &&
    state.distinctVisitedUrls.size > 1 &&
    observation.url !== "about:blank" &&
    state.backtrackCount < task.limits.maxBacktracks &&
    state.stepCount + 1 < task.limits.maxSteps;

  if (!safetyResult.allowed && task.captureModules.includes("errors")) {
    const limitFlags = new Set(["max_steps", "max_backtracks", "max_duration", "loop_detected"]);
    const category: ErrorCategory = safetyResult.flags.some((flag) => limitFlags.has(flag))
      ? "limit_stop"
      : "safety_guard_stop";
    const willRecover = journeyReplanningEligible || branchReturnAttempted;
    recordDiagnosticError(captures, {
      stepIndex,
      category,
      severity: willRecover ? "warning" : "critical",
      pageUrl: observation.url,
      actionType: decision.action.type,
      ...(decision.action.target ? { targetElementId: decision.action.target } : {}),
      message: journeyReplanningEligible
        ? `Guardrail(s) rejected this decision: ${safetyResult.flags.join(", ")}. Attempting bounded journey replanning (go_back) before giving up.`
        : branchReturnAttempted
          ? `Guardrail(s) rejected this decision: ${safetyResult.flags.join(", ")}. Closing the active bounded branch and returning to its original decision point.`
          : `Run stopped by guardrail(s): ${safetyResult.flags.join(", ")}.`,
      recoverable: willRecover,
      stoppedRun: !willRecover,
    });
  }

  // The proposed/substituted stop_blocked action itself is recorded below (buildStepLog's
  // `decision` text and safetyFlags) purely for diagnostics -- captured here, before a
  // successful override replaces effectiveAction, so those diagnostics can still say what
  // was actually blocked.
  const journeyReplanningAttempted = journeyReplanningEligible;
  const blockedDecisionWasProposedDirectly = decision.action.type === "stop_blocked";
  if (journeyReplanningAttempted) {
    state.journeyReplanningAttempts += 1;
    effectiveAction = { type: "go_back" };
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

    // Independently re-checks whether this specific failure was actually an obstruction
    // (covered/intercepted) rather than trusting actions/click.ts's own internal category
    // classification -- reuses the exact same generic readElementState/covered mechanism
    // already used elsewhere in this file, so no new field is needed anywhere in the
    // response contract. Only a covered failure has a signature to track; a detached/
    // hidden/timeout/frame-unavailable stale failure clears any prior tracking instead,
    // since there is nothing to compare against for those categories (item 3, item 7).
    if (effectiveAction.type === "click" && effectiveAction.target) {
      const postFailureCheck = await readElementState(page, effectiveAction.target);
      if (postFailureCheck.covered && postFailureCheck.coveredBySignature) {
        state.lastBlockerTargetId = effectiveAction.target;
        state.lastBlockerSignature = postFailureCheck.coveredBySignature;
      } else {
        state.lastBlockerTargetId = undefined;
        state.lastBlockerSignature = undefined;
        state.blockerSignatureRepeatCount = 0;
      }
    }

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

  state.recordAction(effectiveAction, { url: observation.url, title: observation.title }, actionResult.surfaceChangeType);

  // Goal-Directed Bounded Branch Exploration: this step's own dispatched action counts as
  // one downstream action against the active branch's depth budget, but only while a
  // branch is both active and still exploring (never while it's already closed and
  // returning, e.g. the go_back dispatched by the branch-closure block above) -- the
  // branch's own entry action itself (dispatched the step state.startBranch was called,
  // further below) is never counted here, since state.activeBranch isn't set yet at that
  // point in *this* function.
  if (state.activeBranch && !state.activeBranch.result) {
    state.activeBranch.depth += 1;
  }

  // Route Memory (Phase 1, see core/routeMemory.ts): records what happened to whichever
  // candidate the reasoning layer actually chose (decision.action) at this decision point,
  // identified by its stable role+accessibleName/URL identity rather than the ephemeral
  // per-observation element id -- so the same choice is still recognisable if this exact
  // decision point recurs later (e.g. after a go_back). Only click/navigate are tracked
  // (computeCandidateIdentity returns undefined for every other action type -- nothing to
  // choose between at a decision point for those). Three outcomes are known immediately:
  // "blocked" (the safety layer rejected decision.action before it was ever dispatched --
  // effectiveAction differs from decision.action in this case, so actionResult below
  // reflects a substituted action, not this candidate) and "failed" (dispatched but did not
  // execute successfully); a successful dispatch is recorded provisionally as "no_change"
  // and upgraded to "advanced" by state.resolveLastActionProgress, once the next
  // observation confirms the page actually moved on -- mirroring
  // RecordedAction.observedProgress's own generic, deferred url/title-diff evidence exactly.
  const routeCandidate = computeCandidateIdentity(decision.action, observation);
  const preDispatchDecisionPointFingerprint = routeCandidate ? computeDecisionPointFingerprint(observation) : undefined;
  if (routeCandidate && preDispatchDecisionPointFingerprint) {
    if (!safetyResult.allowed) {
      state.recordRouteMemoryOutcome(preDispatchDecisionPointFingerprint, routeCandidate, "blocked");
    } else if (!actionResult.success) {
      state.recordRouteMemoryOutcome(preDispatchDecisionPointFingerprint, routeCandidate, "failed");
    }
    // A successful dispatch's own outcome ("advanced" vs "no_change") is classified
    // synchronously further below, once newlySatisfied (milestone progress) and this
    // action's own side-effect/fallback-verification evidence are both known -- see the
    // route-progress classification fix after evaluateSuccessCriteria. Never classified
    // here purely from dispatch success, and never deferred to the *next* step's
    // observation (the previous, URL/title-diff-only mechanism this replaces).
  }

  // Goal-Directed Bounded Branch Exploration: entry detection. Deliberately conservative
  // and structural -- see isAmbiguousMultiCandidateDecisionPoint/computeEffectiveBranchDepth
  // (core/branchExploration.ts) -- so an ordinary, unambiguous decision (any page where a
  // candidate's own label already lexically matches the objective/successCriteria, or where
  // fewer than two distinct candidates exist at all) never enters branch mode: this is what
  // keeps a simple, existing single-criterion journey's behaviour byte-for-byte unchanged.
  // Only ever considered for the exact candidate the reasoning layer actually chose and
  // that was dispatched successfully and without any safety rejection -- entry never
  // changes *which* action gets taken, only whether the engine starts tracking it as a
  // bounded branch afterward.
  if (
    !state.activeBranch &&
    routeCandidate &&
    preDispatchDecisionPointFingerprint &&
    safetyResult.allowed &&
    actionResult.success &&
    task.safety.allowedActions.includes("go_back") &&
    getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds).length > 0 &&
    state.getBranchAttempts(preDispatchDecisionPointFingerprint) < MAX_CANDIDATE_BUDGET_PER_DECISION_POINT &&
    !state.routeMemory.hasBranchResult(preDispatchDecisionPointFingerprint, routeCandidate.id) &&
    isAmbiguousMultiCandidateDecisionPoint({
      observation,
      relevanceText: [task.objective, ...task.successCriteria.map((c) => c.description)].filter(Boolean).join(" "),
    })
  ) {
    const effectiveMaxDepth = computeEffectiveBranchDepth({
      requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
      stepsRemaining: task.limits.maxSteps - state.stepCount,
      backtracksRemaining: task.limits.maxBacktracks - state.backtrackCount,
      maxDurationSeconds: task.limits.maxDurationSeconds,
      elapsedMs: Date.now() - state.startedAtMs,
    });
    if (effectiveMaxDepth > 0) {
      const branchRecord: BranchRecord = {
        branchId: state.nextBranchId(),
        decisionPointId: preDispatchDecisionPointFingerprint,
        candidateId: routeCandidate.id,
        candidateLabel: routeCandidate.label,
        entryStepIndex: stepIndex,
        depth: 0,
        maxDepth: effectiveMaxDepth,
        visitedFingerprints: [],
        satisfiedCriteriaIdsAtEntry: [...state.satisfiedCriteriaIds],
        newlySatisfiedCriteriaIds: [],
        consecutiveNoProgress: 0,
        returnHopsAttempted: 0,
        returnHopsBudget: 0,
      };
      state.startBranch(branchRecord);
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          actionType: effectiveAction.type,
          ...(effectiveAction.target ? { targetElementId: effectiveAction.target } : {}),
          message: `Entering bounded branch "${branchRecord.branchId}" through candidate ${routeCandidate.label} (depth budget ${effectiveMaxDepth}, candidate ${state.getBranchAttempts(preDispatchDecisionPointFingerprint)}/${MAX_CANDIDATE_BUDGET_PER_DECISION_POINT} at this decision point).`,
          recoverable: true,
          stoppedRun: false,
        });
      }
    }
  }

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
    { sink: state.milestoneEvidence, stepIndex, phase: "post_action" },
    // PR 1D (surface-scoped evidence, docs/architecture.md §21): scope semantic_page_match
    // evidence to the currently-uncovered surface whenever this step's own action just
    // opened one (PR 1C-a's ActionResult.surfaceChangeDetected) -- never for an ordinary
    // click/navigate with no detected surface change, which behaves exactly as before.
    actionResult.surfaceChangeDetected === true,
  );
  newlySatisfied.forEach((id) => state.satisfiedCriteriaIds.add(id));

  // Route-progress classification fix (see CLAUDE.md and docs/architecture.md "Route
  // progress classification", requirement E): a successful click/navigate candidate's
  // Route Memory outcome is never classified as "advanced" purely because the URL or title
  // changed -- that alone is exactly the signal a same-document destinationUrl fallback can
  // produce without ever running the site's own click handler (see actions/click.ts's
  // fallback-verification fix), which is precisely what misled the reasoning layer in the
  // reported production incident (a route that never reached the objective kept looking
  // like real progress). Advancement now requires at least one of: a milestone/success
  // criterion newly satisfied by this action; generic post-click evidence that a real
  // interaction-state change happened (a new/changed dialog, or a materially different set
  // of visible controls -- actionResult.clickSideEffectDetected, populated by
  // actions/click.ts for both a direct click and the interception-recovery path); or a URL
  // change that was not itself an unverified fallback (actionResult.fallbackVerified, when
  // present, must not be false). A URL/title change from an ordinary direct click or
  // navigate action -- the overwhelming common case -- still counts exactly as before,
  // since fallbackVerified is only ever present at all when a fallback was actually used.
  if (routeCandidate && preDispatchDecisionPointFingerprint && safetyResult.allowed && actionResult.success) {
    const urlChanged = Boolean(actionResult.resultingUrl && actionResult.resultingUrl !== observation.url);
    const milestoneProgress = newlySatisfied.length > 0;
    const clickSideEffect = actionResult.clickSideEffectDetected === true;
    const fallbackUnverified = actionResult.fallbackVerified === false;
    const advanced = milestoneProgress || clickSideEffect || (urlChanged && !fallbackUnverified);
    state.routeMemory.record(preDispatchDecisionPointFingerprint, routeCandidate, advanced ? "advanced" : "no_change");
  }

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
    decision: journeyReplanningAttempted
      ? `Bounded journey replanning (attempt ${state.journeyReplanningAttempts}/${MAX_JOURNEY_REPLANNING_ATTEMPTS}): substituting go_back for a stop_blocked action ${
          blockedDecisionWasProposedDirectly ? "proposed by the reasoning layer" : "substituted by the safety layer for a rejected decision"
        }, to try an alternate path before giving up. Original rationale: ${decision.rationale}`
      : branchReturnAttempted
        ? `Bounded branch closed (${branchClosureResultForLog}): substituting go_back for a stop_blocked action to return to the branch's original decision point. Original rationale: ${decision.rationale}`
        : decision.rationale,
    selectedAction: effectiveAction,
    actionResult,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
    successCriteria: task.successCriteria,
    safetyFlags: journeyReplanningAttempted
      ? [...safetyResult.flags, "journey_replanning_attempted"]
      : branchReturnAttempted
        ? [...safetyResult.flags, "branch_return_attempted"]
        : stopSuccessRejected
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

  if (journeyReplanningAttempted && !actionResult.success) {
    // The substituted go_back itself failed to execute (e.g. no browser history entry was
    // actually available despite visitedUrls suggesting one) -- fall through to the same
    // blocked outcome the original stop_blocked action would have produced, rather than the
    // unrelated action_execution_error the generic action-failure handling below would
    // otherwise report for a failed go_back.
    return {
      stepLog,
      terminal: "blocked",
      finishReason: safetyResult.flags[0] ?? "stop_blocked_action",
    };
  }

  if (branchReturnAttempted && !actionResult.success) {
    // The branch-closure return's own first go_back failed to execute -- the branch was
    // already archived with returnStatus left unset (not yet restored); treat this exactly
    // like PR #41's own failed-substitution case: fall through to a blocked outcome rather
    // than the unrelated action_execution_error the generic handling below would report.
    return {
      stepLog,
      terminal: "blocked",
      finishReason: safetyResult.flags[0] ?? "stop_blocked_action",
    };
  }

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

    // Goal-Directed Bounded Branch Exploration: a non-recoverable failure of a downstream
    // action taken *inside* an actively-exploring branch (never the branch's own entry
    // action, which only starts being tracked after a successful dispatch -- see the
    // entry-detection block above) closes the branch as "blocked" -- a recoverable,
    // mechanical obstruction, per the task's own BLOCKED definition -- rather than ending
    // the whole run. The step is not terminal: the next runStep call's top-of-function
    // block picks up from here and begins the bounded, fingerprint-verified return.
    if (state.activeBranch && !state.activeBranch.result) {
      const branch = state.activeBranch;
      branch.result = "blocked";
      branch.returnHopsBudget = branch.depth + 1;
      state.routeMemory.recordBranchResult(branch.decisionPointId, branch.candidateId, {
        depthReached: branch.depth,
        result: "blocked",
      });
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
  successCriteria: ResolvedTaskRequest["successCriteria"];
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
    successCriteria,
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
      estimatedCompletion: computeEstimatedCompletion(successCriteria, new Set(satisfiedCriteriaIds)),
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

  // Route Memory (Phase 1, see core/routeMemory.ts): before asking for a decision, surface
  // whichever candidates have already been tried at this exact decision point -- possibly
  // several steps ago, or after a go_back returned here -- so a repeated dead end is
  // visible to the reasoning layer as evidence, not just silently re-offered. Omitted
  // entirely when nothing has been tried here yet, matching this repo's existing
  // optional-context-field convention.
  const decisionPointFingerprint = computeDecisionPointFingerprint(observation);
  const triedCandidates = state.routeMemory.getTriedCandidates(decisionPointFingerprint);

  // Goal-Directed Bounded Branch Exploration: milestones reuses existing successCriteria
  // (see computeMilestoneRollup, core/successEvaluator.ts) as the objective's milestones --
  // never a second, parallel milestone system. branch is present only while a branch is
  // both active and still exploring (never while it's closed and returning, since no
  // further reasoning call is made during a return sequence -- see runStep above).
  const milestoneRollup = computeMilestoneRollup(task.successCriteria, state.satisfiedCriteriaIds);
  const branch = state.activeBranch;
  const branchContext =
    branch && !branch.result
      ? {
          candidateLabel: branch.candidateLabel,
          depthUsed: branch.depth,
          depthRemaining: Math.max(0, branch.maxDepth - branch.depth),
          newlySatisfiedCriteriaIds: branch.newlySatisfiedCriteriaIds,
          candidateBudgetUsed: state.getBranchAttempts(branch.decisionPointId),
          candidateBudgetRemaining: Math.max(
            0,
            MAX_CANDIDATE_BUDGET_PER_DECISION_POINT - state.getBranchAttempts(branch.decisionPointId),
          ),
        }
      : undefined;

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
    ...(triedCandidates.length > 0 ? { routeMemory: triedCandidates } : {}),
    milestones: milestoneRollup,
    ...(branchContext ? { branch: branchContext } : {}),
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
    consentControlIntent: decision.consentControlIntent,
  });

  const effectiveAction: SelectedAction = safetyResult.allowed ? decision.action : { type: "stop_blocked" };
  return { decision, safetyResult, effectiveAction };
}
