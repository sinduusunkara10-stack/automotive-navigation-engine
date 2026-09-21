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
import { waitForActionWindowQuietPeriod } from "../capture-modules/actionWindowSettle.js";
import { readConsentStorageEvidence } from "../capture-modules/consentEvidence.js";
import { computeCaptureHealth, classifyActionAnalyticsCapture } from "../capture-modules/analyticsCaptureClassification.js";
import type { ActionTimingOut } from "../actions/click.js";
import { buildJourneyPathEntry } from "../capture-modules/journeyPath.js";
import { classifyActionFailure, recordDiagnosticError } from "../capture-modules/errors.js";
import { captureHostContextSnapshot } from "../capture-modules/hostContext.js";
import type { SurfaceAdoptionRequest } from "../capture-modules/popupCapture.js";
import { computeCandidateIdentity, computeDecisionPointFingerprint } from "./routeMemory.js";
import type { RouteMemoryOutcome } from "../types/routeMemory.js";
import { waitForAdaptiveSettle } from "./robustNavigation.js";
import {
  buildRecoveryAnchor,
  computeCriterionOrder,
  computeTargetMilestoneCriterionIds,
  selectRecoveryAnchor,
} from "./recoveryAnchors.js";
import type { RecoveryAnchor, RouteStatus } from "../types/recovery.js";
import { assessConsentSurface, resolveAmbiguousConsentSurface, type ConsentAmbiguityResolver } from "../safety/consentClassifier.js";
import type { SurfaceRelevanceAmbiguityResolver } from "./surfaceRelevance.js";
import {
  computeEstimatedCompletion,
  computeMilestoneRollup,
  evaluateSuccessCriteria,
  getMissingRequiredCriteriaIds,
  type PanelMatchContext,
  type SuccessCriteriaEvidence,
} from "./successEvaluator.js";
import type { ActionAnalytics, ActionResult } from "../types/task-response.js";
import { MAIN_SURFACE_ID, type RunState, type SurfaceCausingAction } from "./state.js";
import { detectClosedAdoptedSurfaces, returnToParentSurface } from "./surfaceReturn.js";
import { shouldEnterInDocumentSurface, shouldLeaveInDocumentSurface } from "./inDocumentSurface.js";
import { gatherPanelEvidence, looksLikeGenericDismissControl, type PanelEvidence } from "./panelEvidence.js";
import { tokenize } from "../discovery/relevance.js";
import {
  DEFAULT_MAX_BRANCH_DEPTH,
  MAX_CANDIDATE_BUDGET_PER_DECISION_POINT,
  assessBranchProgress,
  classifyClosureFromSafetyFlags,
  computeEffectiveBranchDepth,
  hasBranchAchievedTargetMilestone,
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

// Milestone-anchored recovery (see docs/architecture.md "Milestone-anchored recovery"):
// total go_back hops one run may spend restoring toward any recovery anchor, across every
// anchor tried -- independent of, and separate from, MAX_JOURNEY_REPLANNING_ATTEMPTS above
// (which remains the fallback for a decision point with no recovery anchor available at
// all, e.g. before any milestone has been satisfied yet). Sized generously enough for a
// small number of anchors each needing a couple of hops, while staying a small, fixed,
// non-task-configurable ceiling -- always still subject to maxBacktracks/maxSteps regardless.
const MAX_ANCHOR_RESTORE_HOPS_TOTAL = 6;

// Alternative Route Exploration (see docs/architecture.md "Alternative route exploration"):
// default bounded budget of distinct candidates tried at one recovery anchor's decision
// point before that anchor is considered exhausted and a further-back anchor (or, if none
// remains, today's existing fallback) is used instead. Matches the task requirement of "up
// to three distinct relevant candidates where three valid candidates exist" -- never a
// count inflated by retrying an already-exhausted candidate, and never a reason to invent
// an irrelevant click merely to reach this number.
export const MAX_ALTERNATIVE_CANDIDATES_PER_ANCHOR = 3;

// Consent-interruption handling (see docs/architecture.md "Consent behaviour"): bounded,
// fixed allowance for the engine's own proactive accept-all click under
// consentInteractionPolicy "accept_optional" -- deliberately small and separate from every
// navigation-exploration budget above, so resolving a genuine, recurring consent surface
// can never consume the alternative-route-exploration or journey-replanning allowance.
// Sized to comfortably cover a real journey's own worth of distinct consent surfaces (a
// widget re-appearing after navigating to a new page/origin, entering a new component, or
// re-rendering after a same-document route change -- see docs/architecture.md "Consent
// behaviour -- consent at any journey stage") without being unbounded.
const MAX_CONSENT_RETRIES = 8;

/**
 * PR 1C (Alternative Route Exploration): a trivial, dedicated reader for
 * RunState.pendingAlternativeExploration, called instead of reading the property
 * directly at its one read-after-clear use site below. TypeScript's control-flow
 * narrowing of a `state.foo`-shaped expression can otherwise persist across the many
 * intervening statements between where this field is cleared (unconditionally, inside an
 * `if (state.pendingAlternativeExploration) { ... state.pendingAlternativeExploration =
 * undefined; }` block) and where it is next read here -- a fresh parameter binding avoids
 * that entirely, since it carries no narrowing history of its own.
 */
function readPendingAlternativeExploration(state: RunState): RunState["pendingAlternativeExploration"] {
  return state.pendingAlternativeExploration;
}

/** Drawer/modal formalization (Phase 3 PR 5): the id prefix core/state.ts's nextInDocumentSurfaceId always uses -- see withActiveSurface below. */
const IN_DOCUMENT_SURFACE_ID_PREFIX = "in_document-";

/**
 * Active surface tracking scaffolding (Phase 3 PR 2, see CLAUDE.md and
 * docs/architecture.md "Active surface tracking"): attaches Observation.activeSurface,
 * derived from state.activeSurface, onto every observation this loop builds -- the single
 * place that mapping happens, so every call site below stays byte-for-byte identical to a
 * plain buildObservation(page) except for this one added field. `"adopted_context"` is a
 * genuinely separate Page (Phase 3 PR 3); `"in_document"` is a same-document drawer/modal/
 * side panel (Phase 3 PR 5, core/inDocumentSurface.ts) -- told apart purely by the surface
 * id's own prefix, never by re-deriving it from the observation itself.
 */
function withActiveSurface(observation: Observation, state: RunState): Observation {
  const surfaceId = state.activeSurface;
  if (surfaceId === MAIN_SURFACE_ID) {
    return { ...observation, activeSurface: { kind: "main" } };
  }
  return {
    ...observation,
    activeSurface: {
      kind: surfaceId.startsWith(IN_DOCUMENT_SURFACE_ID_PREFIX) ? "in_document" : "adopted_context",
      identity: surfaceId,
    },
  };
}

/**
 * Panel-attribution corrective pass (item 1, see CLAUDE.md and the BMW-enquire-panel
 * investigation §13): builds the PanelMatchContext core/successEvaluator.ts's
 * evaluateSuccessCriteria consults for a semantic_page_match criterion, whenever the active
 * surface is (or, for `justOpenedThisStep`, was just this step made) in_document.
 * `justOpenedThisStep` is used only by the immediate post-click check, in the same step the
 * click dispatched -- surface-entry formalisation (RunState.pushSurface) deliberately
 * happens one step later (see the investigation's §9E, preserved unchanged by this pass), so
 * without this the same-step post-click evaluation could never see any panel evidence at
 * all, defeating item 5's same-evidence-transition chaining. Every later call (the pre_action
 * check at the top of a subsequent step, or a post_action recheck once the surface is
 * already formally tracked) uses the ordinary `observation.activeSurface`/RunState path.
 */
async function buildPanelMatchContext(params: {
  page: Page;
  state: RunState;
  task: ResolvedTaskRequest;
  observation: Observation;
  justOpenedThisStep?: SurfaceCausingAction;
}): Promise<PanelMatchContext | undefined> {
  const { page, state, task, observation, justOpenedThisStep } = params;
  const objectiveText = [task.objective, ...task.successCriteria.map((c) => c.description)]
    .filter(Boolean)
    .join(" ");

  if (justOpenedThisStep) {
    const evidence = await gatherPanelEvidence(page, { kind: "in_document" }, objectiveText);
    return {
      evidence,
      causallyLinked: justOpenedThisStep.verifiedSuccessType !== undefined,
      ...(justOpenedThisStep.accessibleName || justOpenedThisStep.ctaText
        ? { causingControlLabel: justOpenedThisStep.accessibleName ?? justOpenedThisStep.ctaText }
        : {}),
    };
  }

  if (observation.activeSurface?.kind !== "in_document") {
    return undefined;
  }
  const causingAction = state.getSurfaceCausingAction(state.activeSurface);
  const evidence = await gatherPanelEvidence(page, observation.activeSurface, objectiveText);
  return {
    evidence,
    causallyLinked: Boolean(causingAction && causingAction.verifiedSuccessType !== undefined),
    ...(causingAction?.accessibleName || causingAction?.ctaText
      ? { causingControlLabel: causingAction.accessibleName ?? causingAction.ctaText }
      : {}),
  };
}

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
  consentAmbiguityResolver?: ConsentAmbiguityResolver;
  /** See runTask's own param of the same name (src/core/engine.ts). */
  relevanceAmbiguityResolver?: SurfaceRelevanceAmbiguityResolver;
  /** See runTask's own param of the same name (src/core/engine.ts). */
  isMemoryThresholdBreached?: () => boolean;
}): Promise<LoopStepOutcome> {
  const {
    task,
    state,
    captures,
    reasoning,
    actionNavigationTimeoutMs,
    semanticVerifier,
    consentAmbiguityResolver,
    relevanceAmbiguityResolver,
    isMemoryThresholdBreached,
  } = params;
  // Return-to-parent recovery (Phase 3 PR 4, see CLAUDE.md and docs/architecture.md
  // "Return-to-parent recovery"): unexpected-closure detection -- the site itself may have
  // closed the active adopted surface's own Page (e.g. window.close() from a "Continue"
  // button inside it) since the previous step, without this engine ever dispatching a
  // go_back. Checked before `page` is resolved below, so the rest of this step never
  // observes/dispatches against an already-closed Page; each closed surface popped this way
  // is recorded as a "closed_unexpectedly" diagnostic.
  const closedSurfaces = detectClosedAdoptedSurfaces(state);
  for (const closed of closedSurfaces) {
    state.surfaceAdoptionDiagnostics.push({
      stepIndex: state.stepCount,
      surfaceId: closed.poppedSurfaceId,
      event: "closed_unexpectedly",
    });
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        stepIndex: state.stepCount,
        category: "safety_guard_stop",
        severity: "info",
        pageUrl: params.page.url(),
        message:
          `Adopted surface "${closed.poppedSurfaceId}" was found closed (the site itself closed it, ` +
          `not a go_back this engine dispatched); returned to surface "${closed.parentSurfaceId}".`,
        recoverable: true,
        stoppedRun: false,
      });
    }
  }

  // Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
  // adoption"): every read/write of `page` for the rest of this step -- buildObservation,
  // dispatchAction, evaluateSuccessCriteria, readElementState, all of it -- now resolves
  // against whichever Page RunState.activePage names (an adopted popup/new-tab), falling
  // back to the run's own originally-tracked params.page whenever activeSurface is "main".
  // This is the *entire* mechanism that makes "the reasoning loop now observes/acts against
  // the adopted surface" true: every one of this function's ~20 existing page-using call
  // sites needed zero further changes to pick that up, since they were already written
  // against a single local `page` binding.
  const page = state.activePage ?? params.page;
  const stepIndex = state.stepCount;
  // Surface adoption: the effective allowedDomains for whichever surface is currently
  // active -- task.allowedDomains, plus a per-surface extended-trust hostname when one was
  // recorded for it (safety.surfaceAdoptionDomainPolicy "extend_trust_from_landing"). Equals
  // task.allowedDomains itself (same reference) for every run that never adopts a surface
  // under that policy.
  const effectiveAllowedDomains = state.effectiveAllowedDomains(task.allowedDomains);
  // Alternative Route Exploration: the candidate budget per decision point is configurable
  // per task (Safety.maxAlternativeCandidatesPerDecisionPoint, types/task-request.ts),
  // defaulting to MAX_ALTERNATIVE_CANDIDATES_PER_ANCHOR when omitted -- never itself a way
  // around maxSteps/maxBacktracks/the other safety controls, which remain independently
  // enforced regardless of this value.
  const alternativeCandidateBudget = task.safety.maxAlternativeCandidatesPerDecisionPoint ?? MAX_ALTERNATIVE_CANDIDATES_PER_ANCHOR;
  // Adaptive settling (see CLAUDE.md and docs/architecture.md "Adaptive settling"): resolved
  // once per step and threaded into every settle point below (dispatchAction's own
  // navigate/click settling, and this step's own low-confidence-retry re-observation wait),
  // so a task.settling.maxSettleMs override applies uniformly regardless of which settle
  // point actually runs. undefined (the common case) means "use the engine default" all the
  // way down to waitForAdaptiveSettle itself.
  const settleCeilingMs = task.settling?.maxSettleMs;

  const rawObservation = await buildObservation(page);

  // Drawer/modal formalization (Phase 3 PR 5, see CLAUDE.md and docs/architecture.md
  // "Drawer/modal formalization"): decided from this step's own fresh observation, before
  // withActiveSurface wraps it below, so a drawer/modal that just appeared (or just closed)
  // is reported as "in_document" (or back to "main") starting on this exact step -- never a
  // step late. Only one level deep: a drawer opening from within an already-tracked
  // in_document surface is out of scope (see core/inDocumentSurface.ts's own doc comment).
  const lastRecordedAction = state.actionHistory[state.actionHistory.length - 1];
  // See RunState.suppressNextInDocumentEntry's own doc comment: consumed (read-and-clear)
  // exactly once here, immediately after a return from a Page-less in_document surface, so
  // that return gets one real step on "main" before the same still-visible drawer/modal
  // evidence would otherwise immediately re-trigger entry.
  const suppressEntryThisStep = state.consumeSuppressInDocumentEntry();
  if (
    !suppressEntryThisStep &&
    shouldEnterInDocumentSurface({
      onMain: state.activeSurface === MAIN_SURFACE_ID,
      activeDialogPresent: Boolean(rawObservation.activeDialog),
      lastActionSurfaceChangeType: lastRecordedAction?.surfaceChangeType,
    })
  ) {
    const newSurfaceId = state.nextInDocumentSurfaceId();
    state.pushSurface(newSurfaceId);
    if (rawObservation.activeDialog) {
      state.markInDocumentEnteredViaActiveDialog(newSurfaceId);
    }
    // Panel-attribution corrective pass (item 2): the causing click was necessarily the
    // *previous* step's own recorded action (surface entry is detected exactly one step
    // after the click that opened it -- see the investigation's §9E off-by-one, confirmed
    // intentional and preserved unchanged by this pass). lastDispatchedClickDetails is set
    // unconditionally on every click dispatch, so this is never gated on cta_clicks.
    if (state.lastDispatchedClickDetails && state.lastDispatchedClickDetails.stepIndex === stepIndex - 1) {
      state.recordSurfaceCausingAction(newSurfaceId, state.lastDispatchedClickDetails);
    }
    if (state.pendingJustOpenedPanelVerified) {
      state.pendingJustOpenedPanelVerified = false;
      state.markSurfaceVerifiedAgainstMilestone(newSurfaceId);
    }
    state.surfaceAdoptionDiagnostics.push({
      stepIndex,
      surfaceId: newSurfaceId,
      event: "adopted",
      pageUrl: rawObservation.url,
    });
  } else if (
    shouldLeaveInDocumentSurface({
      activeSurfaceIsInDocument: state.activeSurface.startsWith(IN_DOCUMENT_SURFACE_ID_PREFIX),
      enteredViaActiveDialog: state.wasInDocumentEnteredViaActiveDialog(state.activeSurface),
      activeDialogPresent: Boolean(rawObservation.activeDialog),
    })
  ) {
    const leftSurfaceId = state.activeSurface;
    state.popSurface();
    state.surfaceAdoptionDiagnostics.push({
      stepIndex,
      surfaceId: leftSurfaceId,
      event: "closed_unexpectedly",
      pageUrl: rawObservation.url,
    });
  }

  let observation = withActiveSurface(rawObservation, state);
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

  // Panel-attribution corrective pass (item 1, see CLAUDE.md and the BMW-enquire-panel
  // investigation): the pre_action check can legitimately be what confirms a
  // resulting-surface milestone -- e.g. a later step's recheck of an already-open,
  // already-causally-linked panel (not only the immediate post-click check) -- so panel
  // evidence is gathered here too, never just once.
  const panelContextPreAction = await buildPanelMatchContext({ page, state, task, observation });
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
      undefined,
      panelContextPreAction,
      { surfaceGeneration: state.surfaceGeneration, stepIndex },
    )
  ).forEach((id) => {
    state.satisfiedCriteriaIds.add(id);
    if (observation.activeSurface?.kind === "in_document") {
      state.markSurfaceVerifiedAgainstMilestone(state.activeSurface);
    }
  });

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

  // Consent-interruption handling (see CLAUDE.md and docs/architecture.md "Consent
  // behaviour"): independent of, and prior to, every other block below -- a genuine consent
  // surface can appear at any point in the journey (initial load, or re-appearing later
  // from another component/frame) and must be resolved as an interrupting surface, then the
  // existing journey state (activeBranch/activeAnchorRestore, satisfiedCriteriaIds, all of
  // it) resumed completely untouched. Engine-enforced only for "accept_optional" -- an
  // explicit, caller-opted-in instruction to actually grant optional consent (see
  // ConsentInteractionPolicy) -- where accepting is unambiguously the desired action
  // whenever a genuine surface is confidently detected; every other policy remains
  // advisory-only prompt guidance plus the existing reactive
  // consentPolicyGuard/isConsentIntentCompliant backstop, since the engine has no safe,
  // generic way to independently decide *which* narrower action (decline vs a specific
  // settings choice) a caller wants without guessing. Bounded by MAX_CONSENT_RETRIES,
  // entirely separate from the navigation-exploration/journey-replanning budgets below (item
  // 8 of Alternative Route Exploration's own requirements) -- resolving consent can never
  // consume either.
  if (task.safety.consentInteractionPolicy === "accept_optional" && state.consentRetriesUsed < MAX_CONSENT_RETRIES) {
    const consentAssessment = assessConsentSurface(observation);
    // Multilingual consent handling (corrective pass, see docs/architecture.md "Consent
    // behaviour -- unsupported/ambiguous languages"): when the deterministic,
    // configured-language wording table cannot resolve a confident choice shape but the
    // page still shows genuine consent-context evidence, a caller-supplied
    // consentAmbiguityResolver gets one bounded, independently-verified chance to interpret
    // the exact same observed surface before the engine gives up on this surface entirely --
    // see resolveAmbiguousConsentSurface's own doc comment for the verification it performs.
    // Absent (no resolver configured) or unresolved, this is a silent no-op and behaviour is
    // byte-for-byte the same as before this extension.
    const resolvedCandidate =
      consentAssessment.acceptAllCandidate ??
      (consentAmbiguityResolver
        ? await resolveAmbiguousConsentSurface(observation, consentAssessment, consentAmbiguityResolver)
        : undefined);
    const resolvedViaModelAssist = !consentAssessment.acceptAllCandidate && Boolean(resolvedCandidate);
    if (resolvedCandidate) {
      state.consentRetriesUsed += 1;
      const forcedAction: SelectedAction = { type: "click", target: resolvedCandidate.elementId };
      const consentActionResult = await dispatchAction({
        page,
        action: forcedAction,
        captures,
        stepIndex,
        captureModules: task.captureModules,
        allowedDomains: effectiveAllowedDomains,
        actionNavigationTimeoutMs,
        settleCeilingMs,
      });
      state.recordAction(forcedAction, { url: observation.url, title: observation.title }, consentActionResult.surfaceChangeType);
      // Verify the click was attributable to that control and the surface actually closed
      // or changed -- never assumed from the click alone. A fresh observation is the same
      // generic evidence every other post-action check in this file already uses.
      const postConsentObservation = await buildObservation(page).catch(() => observation);
      const stillDetected = assessConsentSurface(postConsentObservation).surfaceDetected;
      const engineActionVerified = consentActionResult.success && !stillDetected;
      // Consent-interruption handling pauses an active candidate route without ever
      // resetting or exhausting it (see docs/architecture.md "Consent at any journey
      // step") -- state.activeBranch is left completely untouched by this whole block
      // (this step returns before ever reaching the branch-evaluation code above); only
      // this diagnostic counter is incremented, purely for visibility.
      if (state.activeBranch) {
        state.activeBranch.consentInterruptionsHandled += 1;
      }
      state.consentSurfaceDiagnostics.push({
        stepIndex,
        pageUrl: observation.url,
        surfaceDetected: true,
        evidence: consentAssessment.consentContextEvidence,
        acceptAllCandidateFound: true,
        engineActionTaken: "clicked_accept_all",
        engineActionVerified,
        ...(resolvedViaModelAssist ? { resolvedViaModelAssist: true } : {}),
        ...(consentAssessment.pageLanguage ? { pageLanguage: consentAssessment.pageLanguage } : {}),
      });
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          actionType: "click",
          targetElementId: resolvedCandidate.elementId,
          message: `Detected a genuine consent surface (${consentAssessment.consentContextEvidence.join("; ")}) under consentInteractionPolicy "accept_optional"; ${resolvedViaModelAssist ? "used bounded, independently-verified model assistance (the page's own wording matched no configured language) to identify" : "proactively clicked"} the accept-all-equivalent control (${resolvedCandidate.label}). Verified closed/changed: ${engineActionVerified}.`,
          recoverable: true,
          stoppedRun: false,
        });
      }
      const stepLog = buildStepLog({
        stepIndex,
        observation,
        decision: `Engine-detected consent surface; proactively accepted optional consent under consentInteractionPolicy "accept_optional" before continuing the existing journey.`,
        selectedAction: forcedAction,
        actionResult: consentActionResult,
        satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
        successCriteria: task.successCriteria,
        safetyFlags: ["consent_surface_auto_accepted"],
        reObservationAttempted: false,
        recoveryAttempts: 0,
      });
      recordJourneyPathEntry(captures, task.captureModules, stepLog);
      return { stepLog };
    }
    if (consentAssessment.consentContextEvidence.length > 0) {
      state.consentSurfaceDiagnostics.push({
        stepIndex,
        pageUrl: observation.url,
        surfaceDetected: consentAssessment.surfaceDetected,
        evidence: consentAssessment.consentContextEvidence,
        acceptAllCandidateFound: Boolean(consentAssessment.acceptAllCandidate),
        ...(consentAssessment.languageAmbiguous ? { languageAmbiguous: true } : {}),
        ...(consentAssessment.pageLanguage ? { pageLanguage: consentAssessment.pageLanguage } : {}),
      });
    }
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
      // Complete-route-exploration proof: accumulate this branch's own url/surface
      // history on every step it is actively evaluated (never during the return-sequence
      // calls below, which run only after branch.result is already set) -- the raw
      // evidence pushRouteAttemptDiagnostic reports, proving the engine actually followed
      // the route rather than only dispatching its entry click and checking once.
      if (!branch.urlsVisited.includes(observation.url)) {
        branch.urlsVisited.push(observation.url);
      }
      const lastActionForHistory = state.actionHistory[state.actionHistory.length - 1];
      if (lastActionForHistory?.surfaceChangeType && !branch.surfacesOpened.includes(lastActionForHistory.surfaceChangeType)) {
        branch.surfacesOpened.push(lastActionForHistory.surfaceChangeType);
      }

      if (getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds).length === 0) {
        branch.result = "success";
        state.routeMemory.recordBranchResult(branch.decisionPointId, branch.candidateId, {
          depthReached: branch.depth,
          result: "success",
        });
        pushRouteAttemptDiagnostic({
          state,
          branch,
          stepIndex,
          status: "route_succeeded",
          progressEvidence: "every required success criterion is now satisfied",
        });
        pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
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
          pushRouteAttemptDiagnostic({
            state,
            branch,
            stepIndex,
            status: "route_blocked",
            progressEvidence: assessment.reason,
            terminationReason: assessment.result,
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
        } else {
          pushRouteAttemptDiagnostic({
            state,
            branch,
            stepIndex,
            status: hasBranchAchievedTargetMilestone(branch) ? "route_succeeded" : "route_progressing",
            progressEvidence: assessment.reason,
          });
        }
      }
    }

    // Milestone-anchored recovery (corrective pass, see docs/architecture.md "Alternative
    // route exploration -- complete route following"): a "milestone_recovery"-entered
    // branch that has already satisfied the specific milestone it was pursuing is never
    // forced back to its own recovery anchor, even if its *own* later outcome (e.g. a
    // further downstream depth-budget exhaustion, chasing an even-later milestone) would
    // otherwise have closed it unproductively -- "do not return to the earlier anchor
    // merely because the route needs more than one step" / "continue towards the next
    // milestone without being reset". An "ambiguity"-entered branch never has
    // targetMilestoneCriterionIds set, so hasBranchAchievedTargetMilestone is always false
    // for it -- zero behavioural change to that pre-existing path.
    if (branch.result && branch.result !== "success" && hasBranchAchievedTargetMilestone(branch) && branch.returnStatus !== "restored") {
      branch.returnStatus = "restored";
      pushRouteAttemptDiagnostic({
        state,
        branch,
        stepIndex,
        status: "anchor_restored",
        progressEvidence: "the targeted milestone was already achieved; no return to the recovery anchor was needed",
      });
      pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
      state.archiveActiveBranch();
      state.markAnchorRecovered(branch.decisionPointId, stepIndex);
      // Falls through below to a completely ordinary decision this same step.
    } else if (branch.result && branch.result !== "success" && branch.returnStatus !== "restored") {
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
        pushRouteAttemptDiagnostic({ state, branch, stepIndex, status: "anchor_restored" });
        pushRouteAttemptDiagnostic({
          state,
          branch,
          stepIndex,
          status: "candidate_exhausted",
          terminationReason: branch.result,
        });
        pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
        state.archiveActiveBranch();
        state.markAnchorRecovered(branch.decisionPointId, stepIndex);
        // Falls through below to a completely ordinary decision this same step.
      } else if (
        branch.returnHopsAttempted >= branch.returnHopsBudget ||
        !task.safety.allowedActions.includes("go_back") ||
        state.backtrackCount >= task.limits.maxBacktracks ||
        state.stepCount + 1 >= task.limits.maxSteps
      ) {
        branch.returnStatus = "restore_failed";
        pushRouteAttemptDiagnostic({
          state,
          branch,
          stepIndex,
          status: "candidate_exhausted",
          progressEvidence: "the recovery anchor could not be safely restored",
          terminationReason: "anchor_restore_failed",
        });
        pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
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
        pushRouteAttemptDiagnostic({
          state,
          branch,
          stepIndex,
          status: "anchor_restore_required",
          progressEvidence: `return hop ${branch.returnHopsAttempted}/${branch.returnHopsBudget}`,
        });
        const forcedAction: SelectedAction = { type: "go_back" };
        // Return-to-parent recovery (Phase 3 PR 4): off "main", a go_back means leaving the
        // adopted surface, never an ordinary browser-history navigation on it -- substitute
        // returnToParentSurface, which the top-of-function unexpected-closure check and the
        // shared dispatch site below both also use, so all three go_back paths agree on what
        // "returning" means once a surface has been adopted. On "main", nothing changes.
        const returnActionResult =
          state.activeSurface !== MAIN_SURFACE_ID
            ? await (async () => {
                state.surfaceReturnAttempts += 1;
                const result = await returnToParentSurface({ state, mainPage: params.page });
                state.surfaceAdoptionDiagnostics.push({
                  stepIndex,
                  surfaceId: result.poppedSurfaceId,
                  event: result.restored ? "returned" : "return_failed",
                  ...(result.parentUrl ? { pageUrl: result.parentUrl } : {}),
                  ...(result.reason ? { reason: result.reason } : {}),
                });
                const returnResult: ActionResult = { success: result.restored, resultingUrl: result.parentUrl, error: result.reason };
                return returnResult;
              })()
            : await dispatchAction({
                page,
                action: forcedAction,
                captures,
                stepIndex,
                captureModules: task.captureModules,
                allowedDomains: effectiveAllowedDomains,
                actionNavigationTimeoutMs,
                settleCeilingMs,
              });
        state.recordAction(forcedAction, { url: observation.url, title: observation.title });
        if (!returnActionResult.success) {
          branch.returnStatus = "restore_failed";
          pushRouteAttemptDiagnostic({
            state,
            branch,
            stepIndex,
            status: "candidate_exhausted",
            progressEvidence: "the return hop itself failed to execute",
            terminationReason: "go_back_failed",
          });
          pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
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

  // PR 1C: Low-confidence recovery (see docs/architecture.md "Low-confidence recovery").
  // A stop_blocked decision caused specifically by the reasoning layer's own confidence
  // falling below its configured threshold (Decision.fallbackReason === "low_confidence")
  // is diagnosed as the Nissan-investigation failure mode specifically when the
  // immediately preceding dispatched action showed evidence of a newly-opened surface
  // (RecordedAction.surfaceChangeType, PR 1C-a) -- the model may simply not have had
  // enough settle time, or explicit framing, to recognise what it was looking at. Rather
  // than immediately falling through to journey replanning's retreat-only recovery, give
  // the run one bounded, fingerprint-scoped chance to settle further and re-observe.
  // Bounded to once per decision-point fingerprint (state.lowConfidenceRetriedFingerprints)
  // so a recurring ambiguous surface can never spend unbounded extra reasoning-provider
  // calls, and deliberately never engaged for a low-confidence result with no preceding
  // surface change -- this stays scoped to the diagnosed failure mode, not a blanket extra
  // retry for every low-confidence case.
  const lastRecordedActionBeforeThisDecision = state.actionHistory[state.actionHistory.length - 1];
  const isLowConfidenceFallback = effectiveAction.type === "stop_blocked" && decision.fallbackReason === "low_confidence";
  state.consecutiveLowConfidenceCount = isLowConfidenceFallback ? state.consecutiveLowConfidenceCount + 1 : 0;
  if (isLowConfidenceFallback && lastRecordedActionBeforeThisDecision?.surfaceChangeType) {
    const lowConfidenceFingerprint = computeDecisionPointFingerprint(observation);
    if (!state.lowConfidenceRetriedFingerprints.has(lowConfidenceFingerprint)) {
      state.lowConfidenceRetriedFingerprints.add(lowConfidenceFingerprint);
      await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });
      const freshObservation = withActiveSurface(await buildObservation(page), state);
      const lowConfidenceRetry = await obtainDecision({ task, state, observation: freshObservation, reasoning });
      observation = freshObservation;
      decision = lowConfidenceRetry.decision;
      safetyResult = lowConfidenceRetry.safetyResult;
      effectiveAction = lowConfidenceRetry.effectiveAction;
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          message:
            `Low-confidence decision followed an action that opened a new surface ` +
            `(${lastRecordedActionBeforeThisDecision.surfaceChangeType}); re-observed and asked the ` +
            `reasoning layer again before considering journey replanning.`,
          recoverable: true,
          stoppedRun: false,
        });
      }
    }
  }

  // Panel-attribution corrective pass (item 3, see CLAUDE.md and the BMW-enquire-panel
  // investigation §13.3): guards against the engine immediately closing a newly-opened,
  // causally-linked, not-yet-verified in_document surface that was produced by the active
  // milestone's own CTA -- the exact destructive step the investigation found (closing the
  // one panel that carried the milestone's own evidence). Scoped to in_document surfaces
  // only (an adopted "adopted_context" surface is a separate Page a go_back already handles
  // through the dedicated, already-verified returnToParentSurface path -- see PR 4).
  {
    const activeSurfaceForGuard = observation.activeSurface;
    const guardCausingAction =
      activeSurfaceForGuard?.kind === "in_document" ? state.getSurfaceCausingAction(state.activeSurface) : undefined;
    if (
      guardCausingAction &&
      effectiveAction.type === "click" &&
      effectiveAction.target &&
      !state.wasSurfaceVerifiedAgainstMilestone(state.activeSurface)
    ) {
      const clickedEl = observation.interactiveElements.find((el) => el.id === effectiveAction.target);
      const looksLikeDismiss = looksLikeGenericDismissControl(clickedEl?.accessibleName);
      if (looksLikeDismiss) {
        const relevanceObjectiveTextForGuard = [task.objective, ...task.successCriteria.map((c) => c.description)]
          .filter(Boolean)
          .join(" ");
        const guardPanelEvidence = await gatherPanelEvidence(page, activeSurfaceForGuard, relevanceObjectiveTextForGuard);
        // Override (b): strong evidence the surface is unrelated to the objective -- the
        // same generic relevance scoring as item 1's negative-evidence signal.
        const unrelatedEvidence = guardPanelEvidence?.relevance.tier === "reject";
        // Override (c): the task's own criteria explicitly call for dismissing/closing this
        // surface -- generic, caller-supplied text, never a core-defined vocabulary.
        const criteriaRequireClosure = task.successCriteria.some((criterion) =>
          tokenize(criterion.description).some((token) => token === "close" || token === "dismiss"),
        );
        if (!unrelatedEvidence && !criteriaRequireClosure) {
          const guardKey = state.activeSurface;
          const attemptedTargetId = effectiveAction.target;
          if (!state.surfaceCloseGuardRedirected.has(guardKey)) {
            state.surfaceCloseGuardRedirected.add(guardKey);
            if (task.safety.allowedActions.includes("wait")) {
              effectiveAction = { type: "wait" };
            }
            if (task.captureModules.includes("errors")) {
              recordDiagnosticError(captures, {
                stepIndex,
                category: "safety_guard_stop",
                severity: "info",
                pageUrl: observation.url,
                actionType: "click",
                ...(attemptedTargetId ? { targetElementId: attemptedTargetId } : {}),
                message:
                  `Blocked an attempt to close a newly-opened, causally-linked surface (opened by this ` +
                  `run's own step ${guardCausingAction.stepIndex} action) before it was verified against the ` +
                  `active milestone -- redirected to a safe, non-destructive action so the surface stays ` +
                  `open for inspection.`,
                recoverable: true,
                stoppedRun: false,
              });
            }
          }
        }
      }
    }
  }

  // PR 1C: Alternative Route Exploration -- exhausted-candidate protection (see
  // docs/architecture.md "Alternative route exploration"). state.pendingAlternativeExploration
  // is set (below, at the point a journey-replanning go_back substitution actually fires)
  // for exactly one decision: the one immediately following that substitution. Consulted,
  // and always cleared regardless of outcome, right here -- never a persistent blacklist
  // across the run. The reasoning layer's own prompt already carries the same nudge (see
  // obtainDecision's alternativeExploration context / promptBuilder.ts) before this check
  // ever runs, so a genuinely different, better-informed choice is the common case; this is
  // the bounded backstop for when it isn't. Gives one corrective retry (asking again, same
  // observation, same nudge) before hard-blocking the repeated candidate for this one
  // decision point -- blocking here always falls through to the existing, already-bounded
  // stop_blocked/journey-replanning handling further below, so it can never itself create a
  // deadlock: worst case, this run's fixed journey-replanning/step budget is what ends it,
  // exactly as it would if the model had proposed stop_blocked directly.
  // Persistent, per-fingerprint exhausted-candidate set (corrective pass, see
  // state.exhaustedCandidatesByFingerprint / docs/architecture.md "Alternative route
  // exploration") is consulted here too, alongside the legacy one-shot
  // pendingAlternativeExploration -- so a candidate already marked exhausted at this exact
  // decision point (however it got there: an anchor-recovery cycle, or an earlier plain
  // journey-replanning substitution) is protected against being re-proposed, not just the
  // single candidate named by the most recent one-shot nudge.
  const persistentExhaustedAtFingerprint = state.getExhaustedCandidates(computeDecisionPointFingerprint(observation));
  if (state.pendingAlternativeExploration || persistentExhaustedAtFingerprint.size > 0) {
    const exhaustedIds = new Set<string>([
      ...(state.pendingAlternativeExploration?.exhaustedCandidateIds ?? []),
      ...persistentExhaustedAtFingerprint.keys(),
    ]);
    const proposedCandidate = computeCandidateIdentity(decision.action, observation);
    if (proposedCandidate && exhaustedIds.has(proposedCandidate.id)) {
      const exhaustedRetry = await obtainDecision({ task, state, observation, reasoning });
      decision = exhaustedRetry.decision;
      safetyResult = exhaustedRetry.safetyResult;
      effectiveAction = exhaustedRetry.effectiveAction;
      const retriedCandidate = computeCandidateIdentity(decision.action, observation);
      if (retriedCandidate && exhaustedIds.has(retriedCandidate.id)) {
        safetyResult = { allowed: false, flags: [...safetyResult.flags, "repeated_exhausted_candidate"] };
        effectiveAction = { type: "stop_blocked" };
        if (task.captureModules.includes("errors")) {
          recordDiagnosticError(captures, {
            stepIndex,
            category: "safety_guard_stop",
            severity: "warning",
            pageUrl: observation.url,
            actionType: decision.action.type,
            ...(decision.action.target ? { targetElementId: decision.action.target } : {}),
            message:
              `The reasoning layer re-proposed a candidate that already failed to advance the objective ` +
              `(${retriedCandidate.label}), even after one corrective retry with an explicit nudge toward ` +
              `an alternative; forcing stop_blocked for this decision point rather than dispatching it again.`,
            recoverable: true,
            stoppedRun: false,
          });
        }
      }
    }
    state.pendingAlternativeExploration = undefined;
  }

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
    const freshObservation = withActiveSurface(await buildObservation(page), state);
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
    if (!hasBranchAchievedTargetMilestone(branch)) {
      pushRouteAttemptDiagnostic({
        state,
        branch,
        stepIndex,
        status: "route_blocked",
        progressEvidence: `the reasoning layer's own decision was rejected/fell back (${closureResult})`,
        terminationReason: closureResult,
      });
    }
    // Zero-hop restore (see docs/architecture.md "One-step-back requirement"): this step's
    // own pre-dispatch observation (`observation`, taken at the top of this runStep call,
    // still unchanged here since a stop_blocked decision never carries a click target)
    // already matches the branch's own decision point -- e.g. a same-document drawer/
    // half-window candidate that turned out to be a no-op, pushing no browser-history entry
    // at all -- so forcing a go_back here would actually retreat *past* the anchor (to
    // whatever page preceded it), not restore it. Checked before ever falling back to the
    // hop-by-hop go_back sequence below, exactly like the pre-existing
    // anchorRecoveryEligible zero-hop path (anchorAlreadyAtTarget) this mirrors.
    if (computeDecisionPointFingerprint(observation) === branch.decisionPointId) {
      branch.returnStatus = "restored";
      pushRouteAttemptDiagnostic({ state, branch, stepIndex, status: "anchor_restored" });
      pushRouteAttemptDiagnostic({ state, branch, stepIndex, status: "candidate_exhausted", terminationReason: closureResult });
      pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
      state.archiveActiveBranch();
      state.markAnchorRecovered(branch.decisionPointId, stepIndex);
      const zeroHopRetry = await obtainDecision({ task, state, observation, reasoning });
      decision = zeroHopRetry.decision;
      safetyResult = zeroHopRetry.safetyResult;
      effectiveAction = zeroHopRetry.effectiveAction;
    } else if (task.safety.allowedActions.includes("go_back")) {
      branch.returnHopsBudget = branch.depth + 1;
      branch.returnHopsAttempted += 1;
      effectiveAction = { type: "go_back" };
      branchReturnAttempted = true;
    } else {
      // go_back is not an allowed action at all -- there is no way to even attempt a
      // return, so the branch is closed unrestored and the existing stop_blocked handling
      // below runs unmodified (effectiveAction is still stop_blocked).
      branch.returnStatus = "restore_failed";
      pushAlternativeCandidateDiagnostic({ state, branch, stepIndex, budget: alternativeCandidateBudget });
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

  // Milestone-anchored recovery (see core/recoveryAnchors.ts and docs/architecture.md
  // "Milestone-anchored recovery"): whenever journey replanning would otherwise fire, prefer
  // a bounded, verified restore toward the nearest useful recovery anchor over an
  // unconstrained go_back. Only ever considered when journeyReplanningEligible already holds
  // (every one of its own guards still applies unchanged) and at least one recovery anchor
  // exists -- state.recoveryAnchors stays empty for any run that has not yet satisfied a
  // required criterion, so this adds zero behavioural change for that case; the existing,
  // unconstrained journeyReplanningAttempted path below remains the fallback whenever no
  // anchor is available or every available anchor's own bounded budget is exhausted.
  const currentFingerprintForRecovery = journeyReplanningEligible ? computeDecisionPointFingerprint(observation) : undefined;
  const candidateRecoveryAnchor: RecoveryAnchor | undefined = journeyReplanningEligible
    ? (state.activeAnchorRestore &&
      !state.exhaustedAnchorFingerprints.has(state.activeAnchorRestore.anchor.decisionPointFingerprint)
        ? state.activeAnchorRestore.anchor
        : selectRecoveryAnchor({ anchors: state.recoveryAnchors, excludeFingerprints: state.exhaustedAnchorFingerprints }))
    : undefined;
  const anchorAlternativeBudgetAvailable = candidateRecoveryAnchor
    ? state.getAlternativeExplorationAttempts(candidateRecoveryAnchor.decisionPointFingerprint) < alternativeCandidateBudget
    : false;
  const anchorAlreadyAtTarget = Boolean(
    candidateRecoveryAnchor && currentFingerprintForRecovery === candidateRecoveryAnchor.decisionPointFingerprint,
  );
  // Per-anchor hop ceiling (independent of, and tighter than, MAX_ANCHOR_RESTORE_HOPS_TOTAL's
  // whole-run budget): if a specific anchor cannot be reached within a small, fixed number of
  // hops, further hops toward it are not attempted -- it is excluded going forward (below)
  // rather than silently retried forever.
  const priorHopsForCandidateAnchor =
    candidateRecoveryAnchor && state.activeAnchorRestore?.anchor.decisionPointFingerprint === candidateRecoveryAnchor.decisionPointFingerprint
      ? state.activeAnchorRestore.hopsAttempted
      : 0;
  const PER_ANCHOR_HOP_LIMIT = 3;
  const anchorHopBudgetAvailable =
    priorHopsForCandidateAnchor < PER_ANCHOR_HOP_LIMIT && state.anchorRestoreHopsAttempted < MAX_ANCHOR_RESTORE_HOPS_TOTAL;
  const anchorRecoveryEligible =
    journeyReplanningEligible &&
    Boolean(candidateRecoveryAnchor) &&
    anchorAlternativeBudgetAvailable &&
    (anchorAlreadyAtTarget || anchorHopBudgetAvailable);
  // A candidate anchor this run cannot use right now (its own alternative-candidate budget
  // or hop ceiling is exhausted) is excluded from selectRecoveryAnchor on every subsequent
  // trigger, so a later attempt reaches for the next-older anchor instead of retrying a
  // known-unusable one -- never an automatic jump straight to the very first anchor while a
  // closer one simply hasn't been tried yet.
  if (
    journeyReplanningEligible &&
    candidateRecoveryAnchor &&
    !anchorRecoveryEligible &&
    !state.exhaustedAnchorFingerprints.has(candidateRecoveryAnchor.decisionPointFingerprint)
  ) {
    state.exhaustedAnchorFingerprints.add(candidateRecoveryAnchor.decisionPointFingerprint);
    if (state.activeAnchorRestore?.anchor.decisionPointFingerprint === candidateRecoveryAnchor.decisionPointFingerprint) {
      state.activeAnchorRestore = undefined;
    }
  }

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
  const journeyReplanningAttempted = journeyReplanningEligible && !anchorRecoveryEligible;
  const blockedDecisionWasProposedDirectly = decision.action.type === "stop_blocked";
  const originalDecisionRationale = decision.rationale;
  let anchorHopAttempted = false;
  let anchorRetryAttempted = false;

  if (anchorRecoveryEligible && candidateRecoveryAnchor) {
    const targetFingerprint = candidateRecoveryAnchor.decisionPointFingerprint;

    if (anchorAlreadyAtTarget) {
      // Zero-hop restore (see docs/architecture.md "One-step-back requirement"): the
      // current decision point already *is* the anchor -- e.g. a same-document drawer/
      // half-window that added no browser-history entry at all -- so no go_back is
      // dispatched. Ask the reasoning layer again instead, with this anchor's own
      // persistent exhausted-candidate history guaranteed visible (see obtainDecision
      // below), in place of the stop_blocked this step would otherwise have ended on.
      // Whatever candidate this produces is not itself tracked as a "route" here -- see
      // the entry-detection block further below, which starts genuine multi-step route
      // tracking (reusing Goal-Directed Bounded Branch Exploration) for whatever this
      // retry's own dispatched action turns out to be.
      anchorRetryAttempted = true;
      state.activeAnchorRestore = undefined;
      state.markAnchorRecovered(targetFingerprint, stepIndex);
      state.recoveryAttemptDiagnostics.push({
        stepIndex,
        anchorCriterionId: candidateRecoveryAnchor.criterionId,
        anchorMilestoneOrder: candidateRecoveryAnchor.milestoneOrder,
        targetFingerprint,
        hopsAttempted: 0,
        hopsBudget: 0,
        restored: true,
      });
      const anchorRetry = await obtainDecision({ task, state, observation, reasoning });
      decision = anchorRetry.decision;
      safetyResult = anchorRetry.safetyResult;
      effectiveAction = anchorRetry.effectiveAction;
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          message:
            `Milestone-anchored recovery: current decision point already matches the recovery anchor for ` +
            `"${candidateRecoveryAnchor.criterionId}" (milestone order ${candidateRecoveryAnchor.milestoneOrder}); asked the ` +
            `reasoning layer again with alternative-candidate context instead of retreating. Original rationale: ${originalDecisionRationale}`,
          recoverable: true,
          stoppedRun: false,
        });
      }
      if (effectiveAction.type === "stop_blocked") {
        // No usable candidate emerged even after being told exactly where it is and what
        // already failed here -- exclude this anchor going forward (bounded by
        // MAX_ANCHOR_RESTORE_HOPS_TOTAL, reused here as the overall ceiling on *every*
        // anchor-recovery attempt, hop or retry, across the whole run) so a later trigger
        // reaches for an older anchor instead of retrying the same unproductive one
        // forever.
        state.exhaustedAnchorFingerprints.add(targetFingerprint);
        state.anchorRestoreHopsAttempted += 1;
      }
    } else {
      anchorHopAttempted = true;
      const previousHops = priorHopsForCandidateAnchor;
      state.activeAnchorRestore = { anchor: candidateRecoveryAnchor, hopsAttempted: previousHops + 1, hopsBudget: PER_ANCHOR_HOP_LIMIT };
      state.anchorRestoreHopsAttempted += 1;
      effectiveAction = { type: "go_back" };
      state.recoveryAttemptDiagnostics.push({
        stepIndex,
        anchorCriterionId: candidateRecoveryAnchor.criterionId,
        anchorMilestoneOrder: candidateRecoveryAnchor.milestoneOrder,
        targetFingerprint,
        hopsAttempted: previousHops + 1,
        hopsBudget: PER_ANCHOR_HOP_LIMIT,
        // Not yet confirmed: this hop's own dispatch outcome, and whether it actually
        // reached the target fingerprint, are only known on the *next* step (or in the
        // failure branch just below, for a go_back that failed to execute at all). A
        // subsequent zero-hop anchorRetryAttempted entry with restored: true is what
        // confirms successful restoration once it actually happens.
        restored: false,
      });
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          actionType: "go_back",
          message:
            `Milestone-anchored recovery (hop ${previousHops + 1}/${PER_ANCHOR_HOP_LIMIT}): returning toward the recovery ` +
            `anchor for "${candidateRecoveryAnchor.criterionId}" (milestone order ${candidateRecoveryAnchor.milestoneOrder}, ` +
            `page ${candidateRecoveryAnchor.pageUrl}) instead of an unconstrained go_back. Original rationale: ${originalDecisionRationale}`,
          recoverable: true,
          stoppedRun: false,
        });
      }
    }
  } else if (journeyReplanningAttempted) {
    state.journeyReplanningAttempts += 1;
    effectiveAction = { type: "go_back" };

    // PR 1C: Alternative Route Exploration -- seeds the one-shot nudge/guard consumed at
    // the top of the *next* runStep call (see the exhausted-candidate-protection block
    // earlier in this function, and docs/architecture.md "Alternative route exploration").
    // Fallback only, for the case with no recovery anchor available at all (see
    // anchorRecoveryEligible above) -- unchanged from before this corrective pass. Uses
    // whichever click/navigate candidate this run most recently actually dispatched
    // (state.lastDispatchedRouteCandidate) as "the thing that apparently didn't lead
    // anywhere" -- never *this* step's own decision, since a stop_blocked/low-confidence
    // step never itself dispatches a route candidate. Accumulates across more than one
    // journey-replanning attempt within the same run (bounded by
    // MAX_JOURNEY_REPLANNING_ATTEMPTS regardless), so a sibling that is tried and also
    // fails is not re-offered either.
    if (state.lastDispatchedRouteCandidate) {
      const { candidate } = state.lastDispatchedRouteCandidate;
      const existingPending = readPendingAlternativeExploration(state);
      const existingIds = existingPending?.exhaustedCandidateIds ?? [];
      const existingLabels = existingPending?.exhaustedCandidateLabels ?? [];
      state.pendingAlternativeExploration = {
        exhaustedCandidateIds: existingIds.includes(candidate.id) ? existingIds : [...existingIds, candidate.id],
        exhaustedCandidateLabels: existingLabels.includes(candidate.label)
          ? existingLabels
          : [...existingLabels, candidate.label],
      };
    }
  }

  // A zero-hop anchor retry (anchorRetryAttempted) whose own fresh decision is *again*
  // stop_blocked is not itself the end of this run's recovery: unlike an ordinary
  // stop_blocked (handled, unconditionally terminal, further below), this means only that
  // this particular anchor produced nothing usable this time. The anchor was already
  // excluded (state.exhaustedAnchorFingerprints, above) and one unit of the overall
  // anchor-recovery ceiling (MAX_ANCHOR_RESTORE_HOPS_TOTAL) already spent -- while that
  // ceiling still has room, the run is allowed to continue non-terminally: the next
  // runStep call takes a genuinely fresh observation and either reaches for an older
  // anchor (selectRecoveryAnchor now excludes this one) or falls back to ordinary,
  // unconstrained journey replanning. Only once the ceiling itself is exhausted does a
  // further stop_blocked here fall through to the existing, unconditional terminal
  // handling below.
  const anchorRetryStillBlockedWithBudgetRemaining =
    anchorRetryAttempted && effectiveAction.type === "stop_blocked" && state.anchorRestoreHopsAttempted < MAX_ANCHOR_RESTORE_HOPS_TOTAL;

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
  // Panel-attribution corrective pass (item 2, see CLAUDE.md and the BMW-enquire-panel
  // investigation): read unconditionally for every click -- independent of whether the
  // cta_clicks capture module was requested -- so a causally-linked surface this click
  // opens can be attributed to it (RunState.recordSurfaceCausingAction below) even on a run
  // that never asked for the cta_clicks capture at all. Reuses clickedElementDetails when
  // it was already read above rather than reading the DOM a second time.
  const causalClickDetailsForThisClick =
    isClick && effectiveAction.target
      ? (clickedElementDetails ?? (await readClickedElementDetails(page, effectiveAction.target)))
      : undefined;

  // Generic, action-attributed analytics capture (see docs/n8n-integration.md "Generic
  // action-attributed analytics capture"): before-state evidence for the dataLayer delta
  // and GA4 window correlation below is read now, immediately before dispatch, so it
  // reflects this click's true starting point rather than an earlier step's.
  const dataLayerBefore: DataLayerSnapshot | undefined =
    wantsDataLayerDelta && isClick ? await readDataLayerSnapshot(page).catch(() => ({ available: false, raw: [] })) : undefined;
  const ga4WindowStartIndex = wantsGa4Window && isClick ? (captures.ga4_network_events?.length ?? 0) : undefined;
  // Real-time dataLayer.push window (analytics-capture reliability fix): mirrors
  // ga4WindowStartIndex above, but over captures.data_layer_evidence (the persistent
  // push-observer stream from capture-modules/dataLayer.ts) rather than the before/after
  // full-snapshot diff -- this is what survives a same-tab navigation that resets
  // window.dataLayer before dataLayerAfter can be read (see dataLayerDelta.ts's own doc
  // comment on "replaced"). Captured whenever cta_clicks + data_layer_evidence are
  // requested, independent of wantsDataLayerDelta's own before/after pairing.
  const wantsDataLayerPushWindow = wantsCtaClickCapture && task.captureModules.includes("data_layer_evidence");
  const dataLayerPushWindowStartIndex =
    wantsDataLayerPushWindow && isClick ? (captures.data_layer_evidence?.length ?? 0) : undefined;
  const captureWindowStartedAt = isClick && (wantsGa4Window || wantsDataLayerPushWindow) ? new Date().toISOString() : undefined;
  // See ActionTimingOut's own doc comment (actions/click.ts) for why this is a mutable
  // out-param rather than a field threaded through every one of executeClick's own returns.
  const clickTimingOut: ActionTimingOut = {};

  // Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
  // adoption"): built fresh for every click dispatch (the only action type a popup/new-tab
  // "popup" event can ever originate from), from this run's own current
  // RunState.adoptedSurfaceCount -- so the per-run budget (safety.maxAdoptedSurfacesPerRun)
  // is checked against the *live* count, including any nested popup-from-popup already
  // adopted earlier this same run. `enabled: false` (the default for every pre-existing
  // task) reproduces actions/click.ts's pre-PR-3 capture-only-and-close popup handling
  // exactly -- see adoptOrCapturePopup's own doc comment.
  // Surface-relevance assessment (PR 3, see CLAUDE.md and docs/architecture.md "Surface
  // adoption"): the free text src/core/surfaceRelevance.ts scores a just-opened candidate's
  // own page signals against, built once per click dispatch rather than threading a separate
  // CTA-name field further down through popupCapture.ts/click.ts -- the objective, this
  // task's own success-criteria wording, the journeyType hint, and (when available) the
  // clicked CTA's own accessible name, exactly the evidence the approved design doc's own
  // "triggering CTA's accessible name/context" requirement calls for. Only built for a click
  // (the one action type a popup/new-tab can ever originate from); every other action type
  // leaves surfaceAdoptionRequest undefined entirely, unchanged from before this PR.
  const clickedCtaAccessibleName =
    isClick && effectiveAction.target
      ? observation.interactiveElements.find((el) => el.id === effectiveAction.target)?.accessibleName
      : undefined;
  const relevanceObjectiveText = isClick
    ? [
        task.objective,
        ...task.successCriteria.map((criterion) => criterion.description),
        task.journeyType,
        clickedCtaAccessibleName,
      ]
        .filter((part): part is string => Boolean(part && part.trim().length > 0))
        .join(" ")
    : "";

  const surfaceAdoptionRequest: SurfaceAdoptionRequest | undefined = isClick
    ? {
        enabled: Boolean(task.safety.allowSurfaceAdoption),
        domainPolicy: task.safety.surfaceAdoptionDomainPolicy,
        allowedDomains: effectiveAllowedDomains,
        adoptedSurfaceCount: state.adoptedSurfaceCount,
        maxAdoptedSurfacesPerRun: task.safety.maxAdoptedSurfacesPerRun,
        ...(relevanceObjectiveText ? { relevanceObjectiveText } : {}),
        ...(relevanceAmbiguityResolver ? { relevanceAmbiguityResolver } : {}),
        ...(task.safety.consentInteractionPolicy ? { consentInteractionPolicy: task.safety.consentInteractionPolicy } : {}),
      }
    : undefined;

  // Return-to-parent recovery (Phase 3 PR 4): every go_back this shared dispatch site ever
  // sees (an ordinary reasoning-selected go_back, an anchor-hop restore, journey replanning,
  // or a zero-hop branch-closure return) means "leave the adopted surface" once off "main" --
  // never an ordinary browser-history navigation on it. Substituted here so all of those
  // callers get the same verified return behaviour without each needing its own special
  // case; every other action type, and every go_back while still on "main", dispatches
  // exactly as before.
  const actionResult =
    effectiveAction.type === "go_back" && state.activeSurface !== MAIN_SURFACE_ID
      ? await (async () => {
          state.surfaceReturnAttempts += 1;
          const result = await returnToParentSurface({ state, mainPage: params.page });
          state.surfaceAdoptionDiagnostics.push({
            stepIndex,
            surfaceId: result.poppedSurfaceId,
            event: result.restored ? "returned" : "return_failed",
            ...(result.parentUrl ? { pageUrl: result.parentUrl } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
          });
          const returnResult: ActionResult = { success: result.restored, resultingUrl: result.parentUrl, error: result.reason };
          return returnResult;
        })()
      : await dispatchAction({
          page,
          action: effectiveAction,
          captures,
          stepIndex,
          captureModules: task.captureModules,
          allowedDomains: effectiveAllowedDomains,
          actionNavigationTimeoutMs,
          settleCeilingMs,
          reObservationAttempted: effectiveAction.type === "click" ? reObservationAttempted : undefined,
          knownDestinationUrl:
            effectiveAction.type === "click" && effectiveAction.target
              ? knownDestinationUrls.get(effectiveAction.target)
              : undefined,
          surfaceAdoption: surfaceAdoptionRequest,
          timingOut: isClick ? clickTimingOut : undefined,
        });

  // Panel-attribution corrective pass (item 2): recorded unconditionally for every click
  // dispatch, whatever the outcome -- only ever consulted, one step later, if this exact
  // click turns out to be the one that caused entry into a new in_document surface (see the
  // top-of-function pushSurface(newSurfaceId) call above). Never affects "main" or an
  // "adopted_context" surface's own same-step causal attribution below.
  if (isClick && causalClickDetailsForThisClick) {
    const causingAction: SurfaceCausingAction = {
      stepIndex,
      ...(causalClickDetailsForThisClick.ctaText ? { ctaText: causalClickDetailsForThisClick.ctaText } : {}),
      ...(causalClickDetailsForThisClick.accessibleName
        ? { accessibleName: causalClickDetailsForThisClick.accessibleName }
        : {}),
      ...(causalClickDetailsForThisClick.elementType ? { elementType: causalClickDetailsForThisClick.elementType } : {}),
      ...(actionResult.verifiedSuccessType ? { verifiedSuccessType: actionResult.verifiedSuccessType } : {}),
    };
    state.lastDispatchedClickDetails = causingAction;
  }

  // Surface adoption: turns a successful adoption into real RunState -- from the *next*
  // runStep call on, `const page = state.activePage ?? params.page` (top of this function)
  // resolves to the adopted Page instead of the tracked one, so buildObservation/
  // dispatchAction/evaluateSuccessCriteria all naturally operate against it without any
  // further special-casing anywhere else in this file (including a popup opened *from*
  // this adopted popup -- actions/click.ts's own "popup" listener is attached to whichever
  // Page it was actually called against, so a nested chain is handled by this exact same
  // code path, recursively).
  if (actionResult.surfaceAdopted && surfaceAdoptionRequest?.adopted) {
    const { page: adoptedPage, url: adoptedUrl, extendedAllowedDomain } = surfaceAdoptionRequest.adopted;
    const newSurfaceId = state.nextAdoptedSurfaceId();
    state.pushSurface(newSurfaceId, adoptedPage);
    if (extendedAllowedDomain) {
      state.extendAllowedDomainForCurrentSurface(extendedAllowedDomain);
    }
    // Panel-attribution corrective pass (item 2): unlike an in_document surface (detected
    // one step after its causing click), an adopted context's own causing click is *this*
    // same step's click -- state.lastDispatchedClickDetails was just set above, in this
    // same step, to exactly that click's details.
    if (state.lastDispatchedClickDetails && state.lastDispatchedClickDetails.stepIndex === stepIndex) {
      state.recordSurfaceCausingAction(newSurfaceId, state.lastDispatchedClickDetails);
    }
    state.surfaceAdoptionDiagnostics.push({
      stepIndex,
      surfaceId: newSurfaceId,
      event: "adopted",
      ...(adoptedUrl ? { pageUrl: adoptedUrl } : {}),
      ...(actionResult.relevanceScore !== undefined ? { relevanceScore: actionResult.relevanceScore } : {}),
      ...(actionResult.relevanceTier ? { relevanceTier: actionResult.relevanceTier } : {}),
      ...(actionResult.consentActionTaken ? { consentActionTaken: true } : {}),
      ...(extendedAllowedDomain ? { extendedAllowedDomain } : {}),
    });
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        stepIndex,
        category: "safety_guard_stop",
        severity: "info",
        pageUrl: adoptedUrl ?? observation.url,
        message:
          `Adopted a new browsing context opened by this click as the engine's active surface ` +
          `("${newSurfaceId}")` +
          (extendedAllowedDomain
            ? `, extending domain trust to "${extendedAllowedDomain}" for this surface only.`
            : "."),
        recoverable: true,
        stoppedRun: false,
      });
    }
  } else if (actionResult.adoptionRejectedReason) {
    state.surfaceAdoptionDiagnostics.push({
      stepIndex,
      surfaceId: state.activeSurface,
      event: "rejected",
      reason: actionResult.adoptionRejectedReason,
      ...(actionResult.relevanceScore !== undefined ? { relevanceScore: actionResult.relevanceScore } : {}),
      ...(actionResult.relevanceTier ? { relevanceTier: actionResult.relevanceTier } : {}),
      ...(actionResult.consentActionTaken ? { consentActionTaken: true } : {}),
    });
  }
  if (actionResult.adoptionRejectedReason && task.captureModules.includes("errors")) {
    recordDiagnosticError(captures, {
      stepIndex,
      category: "safety_guard_stop",
      severity: "info",
      pageUrl: observation.url,
      message:
        `A popup/new-context opened by this click was not adopted as the active surface ` +
        `(${actionResult.adoptionRejectedReason}); captured only (if requested) and closed, exactly as ` +
        `if surface adoption were disabled.`,
      recoverable: true,
      stoppedRun: false,
    });
  }

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
  let dataLayerPushWindowEndIndex: number | undefined;
  let captureWindowEndedAt: string | undefined;
  if (wantsCtaClickCapture && isClick) {
    if (actionResult.success) {
      resultingTitle = await page.title().catch(() => undefined);
    }
    if (wantsGa4Window || wantsDataLayerPushWindow) {
      await page.waitForTimeout(GA4_ACTION_WINDOW_MS).catch(() => undefined);
      // Adaptive extension (analytics-capture reliability fix, see
      // capture-modules/actionWindowSettle.ts): the fixed grace period above is often too
      // short for a destination page's own async beacons/campaign scripts, which is the
      // root cause a real-site CTA-click analytics-correlation investigation traced -- see this action's own
      // captureWindowEndedAt vs. when matching evidence actually lands under a later
      // stepIndex when this doesn't catch it (surfaced honestly via analyticsCapture.status
      // rather than silently missed).
      await waitForActionWindowQuietPeriod(
        page,
        () => (captures.ga4_network_events?.length ?? 0) + (captures.data_layer_evidence?.length ?? 0),
      );
      if (wantsGa4Window) {
        ga4WindowEndIndex = captures.ga4_network_events?.length ?? 0;
      }
      if (wantsDataLayerPushWindow) {
        dataLayerPushWindowEndIndex = captures.data_layer_evidence?.length ?? 0;
      }
      captureWindowEndedAt = new Date().toISOString();
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
    // PR 1C (Alternative Route Exploration): remembers whichever candidate was actually
    // dispatched (genuinely allowed past the safety layer, whether or not it ultimately
    // succeeded) as "the last real route choice this run made" -- seeded into
    // pendingAlternativeExploration below if a later step needs bounded journey replanning,
    // since that step's own stop_blocked/low-confidence decision never itself dispatches a
    // route candidate.
    if (safetyResult.allowed) {
      state.lastDispatchedRouteCandidate = { fingerprint: preDispatchDecisionPointFingerprint, candidate: routeCandidate };
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
  // Milestone-anchored recovery (corrective pass, see docs/architecture.md "Alternative
  // route exploration -- complete route following"): a second, independently-budgeted entry
  // gate alongside the pre-existing ambiguity heuristic below. Entry here means a candidate
  // is genuinely *followed* as a multi-step route (reusing every downstream mechanism
  // above: depth budget, consecutive-no-progress/dead-end detection, milestone-progress
  // continuation, fingerprint-verified return) rather than only dispatched once and left
  // unobserved -- see this corrective pass's own investigation report for why a bare click
  // was not sufficient. Deliberately checked at every ordinary dispatch (not only
  // immediately after an anchor-restore retry): once a branch closes and restores, the very
  // next ordinary decision that happens to pick a *different*, non-exhausted candidate at
  // the same recovery-anchored fingerprint re-enters here automatically, which is what lets
  // candidate B start its own tracked route without any special-cased "start the next
  // candidate" code.
  const missingRequiredCriteriaIdsForEntry = getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds);
  const hasRecoveryAnchorAtThisFingerprint =
    preDispatchDecisionPointFingerprint !== undefined &&
    state.recoveryAnchors.some((a) => a.decisionPointFingerprint === preDispatchDecisionPointFingerprint);
  // Entry-gate fix (corrective pass, discovered via the multilingual-consent fixture): a
  // recorded anchor existing at this fingerprint is not, by itself, evidence that *this*
  // dispatch is a recovery attempt -- see RunState.wasAnchorRecoveredThisStep's own doc
  // comment. Without this check, an entirely ordinary, first-ever, unambiguous click
  // dispatched from a fingerprint some *earlier* milestone happened to anchor would start
  // being tracked as a bounded candidate route, leaving it vulnerable to being hijacked by a
  // later, unrelated stop_blocked as if it were the route that had failed.
  const viaMilestoneRecoveryEntry =
    Boolean(preDispatchDecisionPointFingerprint) &&
    hasRecoveryAnchorAtThisFingerprint &&
    state.wasAnchorRecoveredThisStep(preDispatchDecisionPointFingerprint as string, stepIndex) &&
    state.getAlternativeExplorationAttempts(preDispatchDecisionPointFingerprint as string) < alternativeCandidateBudget;
  const viaAmbiguityEntry =
    Boolean(preDispatchDecisionPointFingerprint) &&
    state.getBranchAttempts(preDispatchDecisionPointFingerprint as string) < MAX_CANDIDATE_BUDGET_PER_DECISION_POINT &&
    isAmbiguousMultiCandidateDecisionPoint({
      observation,
      relevanceText: [task.objective, ...task.successCriteria.map((c) => c.description)].filter(Boolean).join(" "),
    });

  if (
    !state.activeBranch &&
    routeCandidate &&
    preDispatchDecisionPointFingerprint &&
    safetyResult.allowed &&
    actionResult.success &&
    task.safety.allowedActions.includes("go_back") &&
    missingRequiredCriteriaIdsForEntry.length > 0 &&
    !state.routeMemory.hasBranchResult(preDispatchDecisionPointFingerprint, routeCandidate.id) &&
    (viaMilestoneRecoveryEntry || viaAmbiguityEntry)
  ) {
    const effectiveMaxDepth = computeEffectiveBranchDepth({
      requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
      stepsRemaining: task.limits.maxSteps - state.stepCount,
      backtracksRemaining: task.limits.maxBacktracks - state.backtrackCount,
      maxDurationSeconds: task.limits.maxDurationSeconds,
      elapsedMs: Date.now() - state.startedAtMs,
    });
    if (effectiveMaxDepth > 0) {
      // Prefer the pre-existing "ambiguity" reason when both gates happen to be true at
      // once (a page that is both recovery-anchored and lexically ambiguous) -- this keeps
      // every pre-existing ambiguity-triggered scenario's own diagnostics/budget accounting
      // byte-for-byte unchanged. "milestone_recovery" is reserved for the case ambiguity
      // does not already justify entry on its own -- exactly the corrective pass's own
      // target scenario (a dominant, well-labelled candidate that still needs to be
      // *followed*, not merely dispatched, once recovery has already identified it).
      const entryReason: BranchRecord["entryReason"] = viaAmbiguityEntry ? "ambiguity" : "milestone_recovery";
      const anchorForEntry = entryReason === "milestone_recovery"
        ? state.recoveryAnchors.find((a) => a.decisionPointFingerprint === preDispatchDecisionPointFingerprint)
        : undefined;
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
        entryReason,
        ...(anchorForEntry ? { recoveryAnchorCriterionId: anchorForEntry.criterionId } : {}),
        ...(entryReason === "milestone_recovery"
          ? { targetMilestoneCriterionIds: computeTargetMilestoneCriterionIds(task.successCriteria, missingRequiredCriteriaIdsForEntry) }
          : {}),
        consentInterruptionsHandled: 0,
        routeStartUrl: observation.url,
        urlsVisited: [observation.url],
        surfacesOpened: actionResult.surfaceChangeType ? [actionResult.surfaceChangeType] : [],
        candidateRank: state.nextCandidateRank(preDispatchDecisionPointFingerprint),
      };
      state.startBranch(branchRecord);
      if (entryReason === "milestone_recovery") {
        state.incrementAlternativeExplorationAttempts(preDispatchDecisionPointFingerprint);
        pushRouteAttemptDiagnostic({ state, branch: branchRecord, stepIndex, status: "candidate_selected" });
        pushRouteAttemptDiagnostic({ state, branch: branchRecord, stepIndex, status: "route_active" });
      }
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "safety_guard_stop",
          severity: "info",
          pageUrl: observation.url,
          actionType: effectiveAction.type,
          ...(effectiveAction.target ? { targetElementId: effectiveAction.target } : {}),
          message:
            entryReason === "milestone_recovery"
              ? `Milestone-anchored recovery: entering tracked candidate route "${branchRecord.branchId}" through candidate ${routeCandidate.label} (rank ${branchRecord.candidateRank}, depth budget ${effectiveMaxDepth}, alternative-candidate attempt ${state.getAlternativeExplorationAttempts(preDispatchDecisionPointFingerprint)}/${alternativeCandidateBudget} at this decision point).`
              : `Entering bounded branch "${branchRecord.branchId}" through candidate ${routeCandidate.label} (depth budget ${effectiveMaxDepth}, candidate ${state.getBranchAttempts(preDispatchDecisionPointFingerprint)}/${MAX_CANDIDATE_BUDGET_PER_DECISION_POINT} at this decision point).`,
          recoverable: true,
          stoppedRun: false,
        });
      }
    }
  }

  const satisfiedCountBeforeThisAction = state.satisfiedCriteriaIds.size;
  const verifierDecisionCountBefore = semanticVerifier?.getUsageDiagnostics?.()?.decisions?.length ?? 0;

  // Panel-attribution corrective pass (item 1): a panel this exact step's own click just
  // opened has not yet been formalised as RunState's active surface (that happens one step
  // later, by design -- see buildPanelMatchContext's own doc comment), so it is detected
  // here directly from this step's own ActionResult instead.
  const justOpenedPanelDetails: SurfaceCausingAction | undefined =
    isClick &&
    actionResult.surfaceChangeDetected === true &&
    (actionResult.surfaceChangeType === "layer_panel_appeared" ||
      actionResult.surfaceChangeType === "dialog_appeared" ||
      actionResult.surfaceChangeType === "dialog_changed") &&
    causalClickDetailsForThisClick
      ? {
          stepIndex,
          ...(causalClickDetailsForThisClick.ctaText ? { ctaText: causalClickDetailsForThisClick.ctaText } : {}),
          ...(causalClickDetailsForThisClick.accessibleName
            ? { accessibleName: causalClickDetailsForThisClick.accessibleName }
            : {}),
          ...(causalClickDetailsForThisClick.elementType ? { elementType: causalClickDetailsForThisClick.elementType } : {}),
          ...(actionResult.verifiedSuccessType ? { verifiedSuccessType: actionResult.verifiedSuccessType } : {}),
        }
      : undefined;
  const panelContextPostAction = await buildPanelMatchContext({
    page,
    state,
    task,
    observation,
    ...(justOpenedPanelDetails ? { justOpenedThisStep: justOpenedPanelDetails } : {}),
  });

  // Item 5 (ordered milestone completion within one evidence transition, see CLAUDE.md and
  // the BMW-enquire-panel investigation §13): computeEligibleCriteriaIds's own one-required-
  // milestone-per-call gate is preserved untouched -- each individual evaluateSuccessCriteria
  // call below still only ever newly satisfies at most one required milestone. This bounded
  // outer loop only *chains* multiple such calls, re-invoking with the updated
  // satisfiedCriteriaIds after each newly-satisfied criterion, against the identical
  // page/panel-evidence snapshot already gathered above -- no new page interaction, no new
  // step -- so a click that completes milestone N and, from that same evidence, also already
  // satisfies milestone N+1 (e.g. the very panel that appeared is what N+1 was watching for)
  // does not need a further click merely to re-observe evidence that already exists. Capped
  // small so this can never itself become an unbounded loop.
  const MAX_CHAINED_MILESTONE_EVALUATIONS = 3;
  const newlySatisfied: string[] = [];
  for (let chainIteration = 0; chainIteration < MAX_CHAINED_MILESTONE_EVALUATIONS; chainIteration += 1) {
    const chainResult = await evaluateSuccessCriteria(
      page,
      task.successCriteria,
      task.objective,
      semanticVerifier,
      state.satisfiedCriteriaIds,
      // Click-success/milestone-evidence corrective work (2026-09-21, see BMW live-site
      // investigation and ActionResult.verifiedSuccessType's own doc comment): this click's own
      // declared destination/ctaText is only forwarded as corroborating evidence to the
      // semantic verifier when the click's success was itself established via one of a fixed
      // set of directly-observed evidence classes (verifiedSuccessType present) -- never for a
      // click actionResult.success reports true only via the weaker signals (a target becoming
      // covered/disappearing/re-rendering with no dialog/panel/navigation/new-context to back
      // it up), and never for a click that failed outright. Previously gated only on
      // wantsCtaClickCapture && isClick, with no dependency on the click's own outcome at all.
      wantsCtaClickCapture && isClick && actionResult.verifiedSuccessType !== undefined ? clickedElementDetails : undefined,
      buildCriteriaEvidence(captures),
      { sink: state.milestoneEvidence, stepIndex, phase: "post_action" },
      // PR 1D (surface-scoped evidence, docs/architecture.md §21): scope semantic_page_match
      // evidence to the currently-uncovered surface whenever this step's own action just
      // opened one (PR 1C-a's ActionResult.surfaceChangeDetected) -- never for an ordinary
      // click/navigate with no detected surface change, which behaves exactly as before.
      actionResult.surfaceChangeDetected === true,
      panelContextPostAction,
      { surfaceGeneration: state.surfaceGeneration, stepIndex },
    );
    if (chainResult.length === 0) {
      break;
    }
    newlySatisfied.push(...chainResult);
    chainResult.forEach((id) => state.satisfiedCriteriaIds.add(id));
    if (panelContextPostAction?.evidence) {
      if (observation.activeSurface?.kind === "in_document") {
        state.markSurfaceVerifiedAgainstMilestone(state.activeSurface);
      } else if (justOpenedPanelDetails) {
        state.pendingJustOpenedPanelVerified = true;
      }
    }
  }

  // Milestone-anchored recovery (see core/recoveryAnchors.ts and docs/architecture.md
  // "Milestone-anchored recovery"): the moment a required criterion first becomes
  // satisfied, record enough about *this* decision point to recognise or restore it later
  // -- the connective tissue PR 1D's own truthful milestone evidence never had to recovery
  // logic (see loop.ts's activeAnchorRestore handling below). Deliberately re-observes the
  // page fresh here rather than reusing this step's own `observation` variable: that
  // variable still reflects the page state from *before* this step's own action dispatched
  // (evaluateSuccessCriteria's post-action call, just above, reads the live page directly
  // for its own pass/fail judgement, but never refreshes `observation` itself) -- a
  // milestone satisfied as a direct result of this step's own action (e.g. a click that
  // both selects an item and opens its own half-window, the exact production shape this
  // corrective pass targets) would otherwise be anchored to the *pre*-click decision point,
  // silently missing every control the action itself just revealed. Only paid when at
  // least one criterion actually became satisfied this step -- never on the common,
  // no-new-milestone step.
  if (newlySatisfied.length > 0) {
    const postActionObservationForAnchors = await buildObservation(page);
    for (const criterionId of newlySatisfied) {
      const evidenceRecord = [...state.milestoneEvidence].reverse().find((r) => r.criterionId === criterionId);
      state.recoveryAnchors.push(
        buildRecoveryAnchor({
          criterionId,
          criteria: task.successCriteria,
          stepIndex,
          observation: postActionObservationForAnchors,
          evidenceTier: evidenceRecord?.evidenceTier ?? "inferred",
          sequence: state.nextRecoveryAnchorSequence(),
        }),
      );
    }
  }

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

    const dataLayerDelta =
      wantsDataLayerDelta && dataLayerBefore && dataLayerAfter ? diffDataLayer(dataLayerBefore, dataLayerAfter) : undefined;
    const ga4EventsInWindow = wantsGa4Window
      ? (captures.ga4_network_events ?? []).slice(ga4WindowStartIndex, ga4WindowEndIndex)
      : [];
    const dataLayerPushesInWindow = wantsDataLayerPushWindow
      ? (captures.data_layer_evidence ?? []).slice(dataLayerPushWindowStartIndex, dataLayerPushWindowEndIndex)
      : [];

    // Analytics-capture reliability fix: actionId/timestamps/captureHealth/analyticsCapture
    // are only ever built from evidence this engine already captures elsewhere (see the
    // capture-modules/{analyticsCaptureClassification,consentEvidence,actionWindowSettle}.ts
    // this reuses) -- never a new capture mechanism, and never brand/site-specific.
    const actionId = `${task.taskId}:action:${stepIndex}`;
    const consentRequired = task.safety.consentInteractionPolicy === "accept_optional";
    const consentEvidence = readConsentStorageEvidence({
      dataLayerEntries: (captures.data_layer_evidence ?? []).flatMap((entry) => entry.raw),
      ga4Events: captures.ga4_network_events ?? [],
    });
    const captureHealth = computeCaptureHealth({
      isClick,
      dataLayerReplaced: Boolean(dataLayerDelta?.replaced),
      dataLayerPushListenerActive: state.mainDataLayerPushListenerActive,
      networkListenerActive: true,
      dataLayerPushesObservedInWindowCount: dataLayerPushesInWindow.length,
      dataLayerModuleRequested: wantsDataLayerPushWindow,
      ga4ModuleRequested: wantsGa4Window,
    });
    const analyticsCapture =
      wantsGa4Window || wantsDataLayerPushWindow
        ? classifyActionAnalyticsCapture({
            resultingUrl: actionResult.resultingUrl,
            destinationUrl: clickedElementDetails?.destinationUrl,
            dataLayerReplaced: Boolean(dataLayerDelta?.replaced),
            dataLayerHasNewEntries: Boolean(dataLayerDelta?.newEntries.length),
            ga4EventsInWindow,
            dataLayerPushesInWindow,
            captureHealth,
            consentRequired,
            consentEvidence,
          })
        : undefined;

    const actionAnalytics: ActionAnalytics = {
      actionId,
      ...(captureWindowStartedAt ? { captureWindowStartedAt } : {}),
      ...(captureWindowEndedAt ? { captureWindowEndedAt } : {}),
      ...(clickTimingOut.physicalClickDispatchedAt ? { physicalClickDispatchedAt: clickTimingOut.physicalClickDispatchedAt } : {}),
      ...(dataLayerDelta ? { dataLayerDelta } : {}),
      ...(wantsGa4Window ? { ga4RequestsObservedDuringActionWindow: ga4EventsInWindow } : {}),
      ...(wantsDataLayerPushWindow ? { dataLayerPushesObservedDuringActionWindow: dataLayerPushesInWindow } : {}),
      ...(analyticsCapture ? { captureHealth, analyticsCapture } : {}),
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
      actionId,
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
    decision: anchorHopAttempted
      ? `Milestone-anchored recovery (hop ${state.activeAnchorRestore?.hopsAttempted ?? 0}/${state.activeAnchorRestore?.hopsBudget ?? 0} ` +
        `toward the recovery anchor for "${candidateRecoveryAnchor?.criterionId}"): returning to the last-proven decision point instead ` +
        `of an unconstrained go_back. Original rationale: ${originalDecisionRationale}`
      : anchorRetryAttempted
        ? `Milestone-anchored recovery: already at the recovery anchor for "${candidateRecoveryAnchor?.criterionId}" (milestone order ` +
          `${candidateRecoveryAnchor?.milestoneOrder}); tried a different candidate instead of retreating (alternative-candidate attempt ` +
          `${candidateRecoveryAnchor ? state.getAlternativeExplorationAttempts(candidateRecoveryAnchor.decisionPointFingerprint) : 0}/` +
          `${alternativeCandidateBudget}). Original rationale: ${originalDecisionRationale}`
        : journeyReplanningAttempted
          ? `Bounded journey replanning (attempt ${state.journeyReplanningAttempts}/${MAX_JOURNEY_REPLANNING_ATTEMPTS}): substituting go_back for a stop_blocked action ${
              blockedDecisionWasProposedDirectly ? "proposed by the reasoning layer" : "substituted by the safety layer for a rejected decision"
            }, to try an alternate path before giving up. Original rationale: ${originalDecisionRationale}`
          : branchReturnAttempted
            ? `Bounded branch closed (${branchClosureResultForLog}): substituting go_back for a stop_blocked action to return to the branch's original decision point. Original rationale: ${decision.rationale}`
            : decision.rationale,
    selectedAction: effectiveAction,
    actionResult,
    satisfiedCriteriaIds: [...state.satisfiedCriteriaIds],
    successCriteria: task.successCriteria,
    safetyFlags: anchorHopAttempted
      ? [...safetyResult.flags, "milestone_anchor_restore_attempted"]
      : anchorRetryAttempted
        ? [...safetyResult.flags, "milestone_anchor_alternative_candidate_attempted"]
        : journeyReplanningAttempted
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

  if (anchorRetryStillBlockedWithBudgetRemaining) {
    // This candidate attempt did not pan out, but this anchor's own bounded budget still
    // has room for another -- see the comment above anchorRetryStillBlockedWithBudgetRemaining.
    // Non-terminal: the outer loop (core/engine.ts) calls runStep again, which starts with a
    // brand-new buildObservation and re-triggers this same anchor-recovery block.
    return { stepLog };
  }

  if ((journeyReplanningAttempted || anchorHopAttempted) && !actionResult.success) {
    if (anchorHopAttempted && candidateRecoveryAnchor) {
      state.recoveryAttemptDiagnostics.push({
        stepIndex,
        anchorCriterionId: candidateRecoveryAnchor.criterionId,
        anchorMilestoneOrder: candidateRecoveryAnchor.milestoneOrder,
        targetFingerprint: candidateRecoveryAnchor.decisionPointFingerprint,
        hopsAttempted: state.activeAnchorRestore?.hopsAttempted ?? priorHopsForCandidateAnchor + 1,
        hopsBudget: PER_ANCHOR_HOP_LIMIT,
        restored: false,
        failureReason: "go_back_failed",
      });
      state.exhaustedAnchorFingerprints.add(candidateRecoveryAnchor.decisionPointFingerprint);
      state.activeAnchorRestore = undefined;
    }
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

/**
 * One bounded per-candidate summary row (TaskResponse.diagnostics.alternativeExploration.
 * candidates -- see types/recovery.ts's AlternativeCandidateAttemptDiagnostic), pushed once
 * a "milestone_recovery"-entered branch's outcome is final (i.e. immediately before every
 * state.archiveActiveBranch() call for such a branch). Distinct from, and coarser than,
 * pushRouteAttemptDiagnostic's own full transition-by-transition trace: this is the "at a
 * glance" summary a caller not interested in the full route lifecycle can use instead. A
 * silent no-op for any other branch (entryReason "ambiguity", or one with no result yet),
 * so every archiveActiveBranch() call site can call this unconditionally.
 */
function pushAlternativeCandidateDiagnostic(params: { state: RunState; branch: BranchRecord; stepIndex: number; budget: number }): void {
  const { state, branch, stepIndex, budget } = params;
  if (branch.entryReason !== "milestone_recovery" || !branch.recoveryAnchorCriterionId || !branch.result) {
    return;
  }
  const progressResult: RouteMemoryOutcome =
    branch.result === "success" || branch.result === "goal_progress"
      ? "advanced"
      : branch.result === "plausible_progress" || branch.result === "neutral_progress"
        ? "no_change"
        : branch.result === "blocked" || branch.result === "unsafe"
          ? "blocked"
          : "failed";
  state.alternativeCandidateDiagnostics.push({
    anchorFingerprint: branch.decisionPointId,
    anchorCriterionId: branch.recoveryAnchorCriterionId,
    candidateId: branch.candidateId,
    candidateLabel: branch.candidateLabel,
    stepIndex,
    progressResult,
    attemptNumber: branch.candidateRank,
    budget,
  });
}

/**
 * Complete-route-exploration proof (corrective pass, see CLAUDE.md and
 * docs/architecture.md "Alternative route exploration -- complete route following"): one
 * lifecycle-transition record per call, for a "milestone_recovery"-entered branch only (an
 * "ambiguity"-entered branch's own, pre-existing diagnostics -- captures.errors text,
 * routeMemory branchResult -- are unaffected and unchanged). A silent no-op for any other
 * branch, so every existing call site can call this unconditionally without its own
 * entryReason check.
 */
function pushRouteAttemptDiagnostic(params: {
  state: RunState;
  branch: BranchRecord;
  stepIndex: number;
  status: RouteStatus;
  progressEvidence?: string;
  terminationReason?: string;
}): void {
  const { state, branch, stepIndex, status, progressEvidence, terminationReason } = params;
  if (branch.entryReason !== "milestone_recovery" || !branch.recoveryAnchorCriterionId) {
    return;
  }
  state.routeAttemptDiagnostics.push({
    anchorFingerprint: branch.decisionPointId,
    anchorCriterionId: branch.recoveryAnchorCriterionId,
    candidateId: branch.candidateId,
    candidateLabel: branch.candidateLabel,
    candidateRank: branch.candidateRank,
    routeStartStepIndex: branch.entryStepIndex,
    routeStartUrl: branch.routeStartUrl,
    stepIndex,
    status,
    urlsVisited: [...branch.urlsVisited],
    surfacesOpened: [...branch.surfacesOpened],
    milestoneStateBefore: [...branch.satisfiedCriteriaIdsAtEntry],
    milestoneStateAtTransition: [...state.satisfiedCriteriaIds],
    ...(progressEvidence ? { progressEvidence } : {}),
    consentInterruptionsHandled: branch.consentInterruptionsHandled,
    ...(terminationReason ? { terminationReason } : {}),
  });
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
    ...(actionResult.settleDiagnostic ? { settleDiagnostic: actionResult.settleDiagnostic } : {}),
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
  // Surface adoption: see runStep's own local of the same name -- keeps the reasoning
  // layer's own declared allowedDomains, and the safety layer's navigate-target check
  // below, consistent with what actions/navigate.ts and actions/click.ts's destinationUrl
  // fallback actually enforce for the currently active surface.
  const effectiveAllowedDomains = state.effectiveAllowedDomains(task.allowedDomains);

  // Route Memory (Phase 1, see core/routeMemory.ts): before asking for a decision, surface
  // whichever candidates have already been tried at this exact decision point -- possibly
  // several steps ago, or after a go_back returned here -- so a repeated dead end is
  // visible to the reasoning layer as evidence, not just silently re-offered. Omitted
  // entirely when nothing has been tried here yet, matching this repo's existing
  // optional-context-field convention.
  const decisionPointFingerprint = computeDecisionPointFingerprint(observation);
  const triedCandidates = state.routeMemory.getTriedCandidates(decisionPointFingerprint);

  // Alternative Route Exploration (corrective pass, see docs/architecture.md "Alternative
  // route exploration"): the persistent, per-fingerprint exhausted-candidate set -- unlike
  // the legacy one-shot pendingAlternativeExploration nudge below (kept only as the
  // no-anchor fallback's own context), this is consulted on *every* decision at this
  // fingerprint for as long as any candidate here remains exhausted, guaranteeing the model
  // is told which candidates already failed rather than only for the single decision right
  // after the substitution that discovered it. Labels are resolved from Route Memory (the
  // same store that already tracks a label per candidate id at this fingerprint).
  const exhaustedAtFingerprint = state.getExhaustedCandidates(decisionPointFingerprint);
  const exhaustedLabelsAtFingerprint = [...exhaustedAtFingerprint.values()];

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

  // Panel-attribution corrective pass (item 2): built only when the current observation's
  // own activeSurface is a non-"main" surface whose causing action was recorded (see
  // RunState.recordSurfaceCausingAction/core/loop.ts's two pushSurface call sites).
  const activeSurfaceInfo = observation.activeSurface;
  const causingAction =
    activeSurfaceInfo && activeSurfaceInfo.kind !== "main" ? state.getSurfaceCausingAction(state.activeSurface) : undefined;
  const expectedSurface =
    activeSurfaceInfo && activeSurfaceInfo.kind !== "main" && causingAction
      ? {
          surfaceIdentity: activeSurfaceInfo.identity ?? state.activeSurface,
          causingActionStepIndex: causingAction.stepIndex,
          ...(causingAction.ctaText || causingAction.accessibleName
            ? { causingControlLabel: causingAction.accessibleName ?? causingAction.ctaText }
            : {}),
          ...(causingAction.verifiedSuccessType ? { causingActionVerifiedSuccessType: causingAction.verifiedSuccessType } : {}),
          stillOpen: true,
          alreadyVerifiedAgainstMilestone: state.wasSurfaceVerifiedAgainstMilestone(state.activeSurface),
        }
      : undefined;

  const decision = await reasoning.decide({
    objective: task.objective,
    successCriteria: task.successCriteria,
    allowedActions: task.safety.allowedActions,
    allowedDomains: effectiveAllowedDomains,
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
    ...(exhaustedLabelsAtFingerprint.length > 0
      ? { alternativeExploration: { justFailedLabels: exhaustedLabelsAtFingerprint } }
      : state.pendingAlternativeExploration
        ? { alternativeExploration: { justFailedLabels: state.pendingAlternativeExploration.exhaustedCandidateLabels } }
        : {}),
    ...(expectedSurface ? { expectedSurface } : {}),
  });

  const safetyResult = validateDecision({
    action: decision.action,
    safety: task.safety,
    limits: task.limits,
    allowedDomains: effectiveAllowedDomains,
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
