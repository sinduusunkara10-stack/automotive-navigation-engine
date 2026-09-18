import type { Page } from "playwright";
import type { RecordedAction, SelectedAction } from "../types/actions.js";
import type { RouteMemoryCandidate, RouteMemoryOutcome } from "../types/routeMemory.js";
import type { MilestoneEvidenceRecord } from "../types/task-response.js";
import type {
  AlternativeCandidateAttemptDiagnostic,
  ConsentSurfaceDiagnostic,
  RecoveryAnchor,
  RecoveryAttemptDiagnostic,
  RouteAttemptDiagnostic,
  SurfaceAdoptionAttemptDiagnostic,
} from "../types/recovery.js";
import { RouteMemory } from "./routeMemory.js";
import { MAX_BRANCH_HISTORY, type BranchRecord } from "./branchExploration.js";

/** RunState.activeSurface always starts (and, until Phase 3 PR 3 wires real adoption, stays) here. */
export const MAIN_SURFACE_ID = "main";

/**
 * Active surface tracking scaffolding (Phase 3 PR 2, see CLAUDE.md and docs/architecture.md
 * §25): the per-surface bucket of state that must never leak between the tracked page
 * ("main") and a future adopted popup/new-tab/drawer context. Everything in here was
 * previously a flat RunState field; grouping it lets RunState key a whole bucket by surface
 * id at once instead of threading a surface id through each field individually.
 */
interface SurfaceState {
  lastBlockerTargetId: string | undefined;
  lastBlockerSignature: string | undefined;
  blockerSignatureRepeatCount: number;
  readonly lowConfidenceRetriedFingerprints: Set<string>;
  readonly routeMemory: RouteMemory;
  /**
   * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
   * adoption"): set only for a surface entered under safety.surfaceAdoptionDomainPolicy
   * "extend_trust_from_landing" -- the hostname this one surface's own allowedDomains check
   * is additionally permitted to navigate within, on top of the run's own task.allowedDomains
   * (see RunState.effectiveAllowedDomains). Never written back onto "main" or onto any other
   * surface's own bucket -- trust extended to reach one adopted popup's landing page is never
   * silently inherited by an unrelated surface.
   */
  extendedAllowedDomain: string | undefined;
}

function createSurfaceState(): SurfaceState {
  return {
    lastBlockerTargetId: undefined,
    lastBlockerSignature: undefined,
    blockerSignatureRepeatCount: 0,
    lowConfidenceRetriedFingerprints: new Set<string>(),
    routeMemory: new RouteMemory(),
    extendedAllowedDomain: undefined,
  };
}

export class RunState {
  stepCount = 0;
  backtrackCount = 0;
  readonly startedAtMs = Date.now();
  readonly actionHistory: RecordedAction[] = [];
  readonly visitedUrls: string[] = [];
  /**
   * Safe replanning / go_back fix: distinct URLs actually observed this run, as opposed to
   * visitedUrls' per-step (possibly repeated) log. core/loop.ts's journey-replanning
   * eligibility check uses this -- not visitedUrls.length -- to decide whether there is
   * genuinely a different prior page to go back to. visitedUrls.length grows by one on
   * every single step regardless of whether the observed URL actually changed (e.g. a click
   * later found not to have navigated the page at all still gets a fresh observation next
   * step), so it was never a safe proxy for "the browser has real history behind it" -- a
   * run stuck observing the same URL for several steps in a row previously looked, from
   * that count alone, exactly like a run that had genuinely visited two different pages.
   * This Set collapses repeats, so it only grows when the observed URL is actually new.
   */
  readonly distinctVisitedUrls = new Set<string>();
  readonly satisfiedCriteriaIds = new Set<string>();
  /**
   * One record per success criterion, appended the moment it first becomes satisfied -- see
   * core/successEvaluator.ts's MilestoneEvidenceContext. Bounded implicitly by
   * successCriteria.length: satisfiedCriteriaIds is a one-way ratchet, so a criterion
   * contributes at most one record for the life of a run; no separate cap is needed.
   */
  readonly milestoneEvidence: MilestoneEvidenceRecord[] = [];
  /**
   * Fingerprint (url + sorted satisfied/missing required criteria ids) of the most
   * recently rejected stop_success decision, or undefined if none has been rejected yet.
   * Lets src/core/loop.ts detect two consecutive stop_success rejections with no new
   * evidence at all -- without this, a reasoning provider that keeps re-proposing
   * stop_success on an unchanged page would keep spending model calls until the generic
   * repeated-action safety guard eventually trips several steps later.
   */
  lastRejectedStopSuccessFingerprint: string | undefined;

  /**
   * Consecutive count of steps that ended in a staleTarget-classified action failure (see
   * ActionResult.staleTarget) -- reset to 0 the moment a step makes real progress (a
   * successful action, or a non-click action). Bounds core/loop.ts's non-fatal blocker
   * recovery independently of, and tighter than, the existing repeated-action guard, which
   * only catches the *same* action repeated identically.
   */
  consecutiveStaleTargetFailures = 0;

  /**
   * Active surface tracking scaffolding (Phase 3 PR 2): the surface (see MAIN_SURFACE_ID)
   * this run is currently dispatching actions and evaluating state against, as a stack so a
   * future adopted surface can be entered and returned from in nested fashion. Every
   * existing run stays on a single-element `["main"]` stack for its entire lifetime today --
   * nothing yet calls pushSurface/popSurface (Phase 3 PR 3 wires real adoption) -- so
   * activeSurface is always MAIN_SURFACE_ID and every per-surface-scoped field below always
   * resolves to the same one bucket, exactly reproducing this run's previous flat-field
   * behaviour.
   */
  private readonly surfaceStack: string[] = [MAIN_SURFACE_ID];
  private readonly surfaceStates = new Map<string, SurfaceState>([[MAIN_SURFACE_ID, createSurfaceState()]]);
  /**
   * Surface adoption (Phase 3 PR 3): the live Playwright Page each non-"main" surface on the
   * stack is backed by. "main" deliberately has no entry here -- its Page is always the one
   * runTask/runStep were originally called with, threaded down as an ordinary parameter (see
   * core/loop.ts's own `const page = state.activePage ?? params.page`), never owned by
   * RunState itself.
   */
  private readonly pageBySurfaceId = new Map<string, Page>();
  private adoptedSurfaceCounter = 0;

  get activeSurface(): string {
    // Never empty -- MAIN_SURFACE_ID is pushed once at construction and popSurface refuses
    // to remove the last remaining entry (see popSurface below) -- the fallback is purely to
    // satisfy noUncheckedIndexedAccess, never a reachable runtime path.
    return this.surfaceStack[this.surfaceStack.length - 1] ?? MAIN_SURFACE_ID;
  }

  /**
   * Surface adoption (Phase 3 PR 3): the live Page core/loop.ts must observe/act against for
   * the current step, or undefined when activeSurface is "main" (in which case the caller's
   * own, separately-threaded main Page is used instead). Never main's own Page -- see
   * pageBySurfaceId's own doc comment.
   */
  get activePage(): Page | undefined {
    return this.pageBySurfaceId.get(this.activeSurface);
  }

  /** How many distinct surfaces have ever been adopted this run (never decremented by popSurface) -- the budget safety.maxAdoptedSurfacesPerRun bounds. */
  get adoptedSurfaceCount(): number {
    return this.adoptedSurfaceCounter;
  }

  /** A fresh, stable, run-unique id for a newly adopted surface (e.g. "adopted-1", "adopted-2", ...), independent of stack depth or nesting. */
  nextAdoptedSurfaceId(): string {
    this.adoptedSurfaceCounter += 1;
    return `adopted-${this.adoptedSurfaceCounter}`;
  }

  private currentSurfaceState(): SurfaceState {
    const id = this.activeSurface;
    let bucket = this.surfaceStates.get(id);
    if (!bucket) {
      bucket = createSurfaceState();
      this.surfaceStates.set(id, bucket);
    }
    return bucket;
  }

  /**
   * Enters a new (or re-enters an existing) surface, pushing it onto the stack so it becomes
   * activeSurface and every per-surface-scoped field below now resolves against its own,
   * previously-untouched bucket -- never the surface being left, and never shared with any
   * other surface id. The surface being left keeps its own bucket exactly as it was, ready
   * to resume unchanged once popSurface returns to it.
   *
   * `page`, when given (surface adoption, Phase 3 PR 3), is the live Page this surface is
   * backed by, recorded so activePage resolves to it for as long as this surface remains
   * anywhere on the stack -- omitted only by tests exercising the pre-adoption stack
   * mechanics on their own (see tests/unit/runStateSurfaceScoping.test.ts).
   */
  pushSurface(surfaceId: string, page?: Page): void {
    this.surfaceStack.push(surfaceId);
    if (page) {
      this.pageBySurfaceId.set(surfaceId, page);
    }
  }

  /**
   * Leaves the current surface and returns to the one beneath it, restoring that surface's
   * own bucket exactly as it was left. Never pops the last remaining entry -- "main" is
   * always the stack's permanent floor -- so a caller that pops more times than it pushed
   * simply stays on "main" rather than ever leaving the stack empty. Returns the surface id
   * that was popped, or undefined if there was nothing above "main" to pop. The popped
   * surface's own Page mapping (if any) is deliberately left in pageBySurfaceId -- re-pushing
   * the same surfaceId later (never done today, but kept consistent with every other
   * per-surface bucket's re-entry-preserves-state behaviour) would otherwise silently lose
   * its Page.
   */
  popSurface(): string | undefined {
    if (this.surfaceStack.length <= 1) {
      return undefined;
    }
    return this.surfaceStack.pop();
  }

  /**
   * Surface adoption (Phase 3 PR 3, "extend_trust_from_landing" policy): records that the
   * *current* surface's own allowedDomains check is additionally permitted to navigate
   * within `hostname`, on top of the run's own task.allowedDomains. Scoped to exactly the
   * surface active at call time -- never retroactively applied to a surface entered earlier
   * or later.
   */
  extendAllowedDomainForCurrentSurface(hostname: string): void {
    this.currentSurfaceState().extendedAllowedDomain = hostname;
  }

  /**
   * The allowedDomains list core/loop.ts should actually enforce for the current surface's
   * own navigation/click dispatch: `base` (the run's own task.allowedDomains), plus the
   * current surface's own extended-trust hostname when one was recorded (see
   * extendAllowedDomainForCurrentSurface above). Returns `base` unchanged (same array
   * reference) for every run that never adopts a surface under "extend_trust_from_landing" --
   * this stays a complete no-op for every pre-existing task.
   */
  effectiveAllowedDomains(base: string[]): string[] {
    const extended = this.currentSurfaceState().extendedAllowedDomain;
    return extended ? [...base, extended] : base;
  }

  /**
   * Identity (see observation/observationBuilder.ts's ElementState.coveredBySignature) of
   * whatever intercepted the target of the most recent covered/intercepted stale-target
   * failure, and which target it was blocking -- undefined once that obstruction is
   * confirmed cleared (see core/loop.ts). Generic: keyed only on the intercepting
   * element's own tag/role/text, never on what kind of overlay it is (consent or
   * otherwise), so it applies identically to any blocking overlay. Scoped per activeSurface
   * (Phase 3 PR 2) so an obstruction tracked on one surface can never be mistaken for one on
   * another.
   */
  get lastBlockerTargetId(): string | undefined {
    return this.currentSurfaceState().lastBlockerTargetId;
  }

  set lastBlockerTargetId(value: string | undefined) {
    this.currentSurfaceState().lastBlockerTargetId = value;
  }

  get lastBlockerSignature(): string | undefined {
    return this.currentSurfaceState().lastBlockerSignature;
  }

  set lastBlockerSignature(value: string | undefined) {
    this.currentSurfaceState().lastBlockerSignature = value;
  }

  /**
   * How many consecutive times lastBlockerSignature has been re-observed unchanged.
   * core/loop.ts allows one reasoning-provider call while this is 0 (a provider always
   * gets at least one chance to react to a freshly-detected obstruction); once it reaches
   * 1, a further reasoning call is skipped in favour of a deterministic stale-target
   * outcome, so no additional call is spent against a page state that hasn't changed.
   * Scoped per activeSurface (Phase 3 PR 2), same as lastBlockerTargetId/lastBlockerSignature.
   */
  get blockerSignatureRepeatCount(): number {
    return this.currentSurfaceState().blockerSignatureRepeatCount;
  }

  set blockerSignatureRepeatCount(value: number) {
    this.currentSurfaceState().blockerSignatureRepeatCount = value;
  }

  /** Hostname of the previous step's observation, or undefined before the first step -- lets core/loop.ts detect a cross-host transition to trigger the (opt-in) host_context_snapshot capture. */
  lastObservedHostname: string | undefined;

  /**
   * How many times this run has substituted the existing go_back action for a stop_blocked
   * action (whether proposed directly by the reasoning layer, or substituted by the safety
   * layer for a decision it rejected) in order to back up onto an already-seen page and give
   * the reasoning layer a further chance to find an alternate route, before the engine
   * finally honours stop_blocked -- see MAX_JOURNEY_REPLANNING_ATTEMPTS in core/loop.ts.
   * Bounded independently of, and well below, the existing maxSteps/maxBacktracks ceilings:
   * every substituted go_back is still recorded through the same recordAction path as any
   * other go_back, so those ceilings remain the actual hard stop regardless of this count.
   */
  journeyReplanningAttempts = 0;

  /**
   * url/title of the observation the most recently recorded action was actually decided
   * and dispatched against (i.e. the page state immediately *before* that action ran) --
   * compared, at the top of the next step, against the fresh observation then taken, to
   * fill in that action's own RecordedAction.observedProgress (see
   * resolveLastActionProgress below). Undefined before any action has been recorded yet.
   */
  private lastActionObservationBefore: { url: string; title: string } | undefined;

  /**
   * Route Memory (see core/routeMemory.ts): remembers, per decision-point fingerprint,
   * which candidate route choices (click/navigate) have already been tried and what
   * happened, so a repeated dead end is visible to the reasoning layer even across
   * non-adjacent steps (e.g. after a go_back, or a fresh page load that reassigns every
   * element's own ephemeral id) -- something the existing repeated-action guard, keyed on
   * exact linear-history repetition, cannot see. Never persisted beyond this run, never
   * surfaced on TaskResponse (Phase 1 scope). Scoped per activeSurface (Phase 3 PR 2): a
   * route tried on one surface is never mistaken for one tried on another. Always the same
   * RouteMemory instance for the life of one surface -- callers may still hold onto or
   * repeatedly call methods on the returned reference within a single step exactly as
   * before; only which instance this getter resolves to depends on activeSurface.
   */
  get routeMemory(): RouteMemory {
    return this.currentSurfaceState().routeMemory;
  }

  /**
   * PR 1C (Low-confidence recovery, see docs/architecture.md): decision-point fingerprints
   * (core/routeMemory.ts's computeDecisionPointFingerprint) that have already been given
   * one bounded fresh-observation retry after a low-confidence fallback. Bounded to once
   * per fingerprint per run -- a recurring ambiguous surface can never spend unbounded
   * extra reasoning-provider calls. Never cleared within a run (a fingerprint that needed
   * this once is unlikely to need it differently later), and small by construction (one
   * entry per genuinely distinct decision point that ever triggered this recovery). Scoped
   * per activeSurface (Phase 3 PR 2), same reasoning as routeMemory above.
   */
  get lowConfidenceRetriedFingerprints(): Set<string> {
    return this.currentSurfaceState().lowConfidenceRetriedFingerprints;
  }

  /**
   * PR 1C (Low-confidence recovery): consecutive count of decisions whose Decision.
   * fallbackReason was "low_confidence" -- diagnostic only, reset to 0 by any decision that
   * isn't such a fallback. Never itself a hard ceiling (maxSteps and the existing bounded
   * journey-replanning/stale-target-recovery mechanisms remain the actual stops); exists so
   * a run oscillating in and out of low confidence is visible in captures.errors.
   */
  consecutiveLowConfidenceCount = 0;

  /**
   * PR 1C (Alternative Route Exploration): the most recent click/navigate candidate this
   * run actually dispatched (computeCandidateIdentity, core/routeMemory.ts) and the
   * decision-point fingerprint it was chosen from -- regardless of whether it ultimately
   * succeeded. Used, when a bounded journey-replanning go_back substitution fires, as "the
   * candidate that apparently didn't lead anywhere" to seed pendingAlternativeExploration
   * below, since the step that actually triggers replanning (a stop_blocked/low-confidence
   * decision) never itself dispatches a route candidate.
   */
  lastDispatchedRouteCandidate: { fingerprint: string; candidate: RouteMemoryCandidate } | undefined;

  /**
   * PR 1C (Alternative Route Exploration, "exhausted candidate protection" -- see
   * docs/architecture.md "Alternative route exploration"): set only immediately after a
   * bounded journey-replanning go_back substitution, naming whichever candidate(s) this run
   * has dispatched so far that did not lead anywhere productive. Consumed -- and always
   * cleared, whatever the outcome -- by the very next decision in core/loop.ts: rendered as
   * a prompt nudge (see ReasoningProvider.alternativeExploration) and checked as a bounded,
   * one-retry-then-hard-block guard against immediately re-selecting the same candidate.
   * Never a persistent blacklist across the run.
   *
   * Superseded, for a decision point that has a recovery anchor, by the persistent,
   * fingerprint-keyed exhaustedCandidatesByFingerprint below -- this field remains as the
   * fallback for the no-anchor case (e.g. before any milestone has been satisfied yet),
   * where behaviour is unchanged from before this corrective pass.
   */
  pendingAlternativeExploration: { exhaustedCandidateIds: string[]; exhaustedCandidateLabels: string[] } | undefined;

  /**
   * Milestone-anchored recovery (see core/recoveryAnchors.ts and docs/architecture.md
   * "Milestone-anchored recovery"): one anchor per required success criterion, appended the
   * moment it is first satisfied -- bounded implicitly by successCriteria.length, the same
   * way milestoneEvidence above is.
   */
  readonly recoveryAnchors: RecoveryAnchor[] = [];
  private recoveryAnchorSequenceCounter = 0;

  nextRecoveryAnchorSequence(): number {
    this.recoveryAnchorSequenceCounter += 1;
    return this.recoveryAnchorSequenceCounter;
  }

  /**
   * Milestone-anchored recovery: bounded, fingerprint-verified go_back sequence currently
   * restoring toward a recovery anchor -- mirrors activeBranch's own return-sequence shape
   * (core/branchExploration.ts) so core/loop.ts's top-of-function handling for both stays
   * consistent. Cleared the moment the target fingerprint is confirmed restored, or the
   * bounded hop budget is exhausted.
   */
  activeAnchorRestore: { anchor: RecoveryAnchor; hopsAttempted: number; hopsBudget: number } | undefined;

  /**
   * Alternative Route Exploration (corrective pass): a candidate is "exhausted" at a given
   * decision-point fingerprint exactly when Route Memory (core/routeMemory.ts) already
   * recorded a *branch* result for it there (dead_end/blocked/unsafe) -- i.e. it was not
   * merely dispatched once, but genuinely followed as a multi-step route and found not to
   * progress (see core/branchExploration.ts's assessBranchProgress and
   * classifyClosureFromSafetyFlags). Derived directly from state.routeMemory -- never a
   * second, separately-maintained set that could drift out of sync with it (a real gap in
   * an earlier version of this mechanism, since fixed: a candidate id alone, without its
   * label, could not be told apart from a different card's identically-labelled control --
   * see core/routeMemory.ts's buildClickIdentityKey, which already disambiguates by
   * destinationUrl/nearestHeadingText when available).
   */
  getExhaustedCandidates(fingerprint: string): ReadonlyMap<string, string> {
    const exhausted = new Map<string, string>();
    for (const candidate of this.routeMemory.getTriedCandidates(fingerprint)) {
      if (candidate.branchResult === "dead_end" || candidate.branchResult === "blocked" || candidate.branchResult === "unsafe") {
        exhausted.set(candidate.id, candidate.label);
      }
    }
    return exhausted;
  }

  private readonly alternativeExplorationAttemptsByFingerprint = new Map<string, number>();

  getAlternativeExplorationAttempts(fingerprint: string): number {
    return this.alternativeExplorationAttemptsByFingerprint.get(fingerprint) ?? 0;
  }

  incrementAlternativeExplorationAttempts(fingerprint: string): number {
    const next = this.getAlternativeExplorationAttempts(fingerprint) + 1;
    this.alternativeExplorationAttemptsByFingerprint.set(fingerprint, next);
    return next;
  }

  /**
   * Milestone-anchored recovery entry-gate fix (corrective pass, see CLAUDE.md "Fix the
   * element-ID collision at its source" -- discovered alongside it, from the same
   * multilingual-consent fixture): a decision point having a recorded recovery anchor is
   * not, by itself, evidence that *this specific dispatch* is a recovery attempt -- an
   * entirely ordinary, unambiguous, first-ever click (e.g. the one link on a freshly-loaded
   * page) can coincidentally be dispatched from a fingerprint some *earlier* milestone
   * happened to anchor. Without this check, core/loop.ts's viaMilestoneRecoveryEntry gate
   * would start tracking that ordinary click as a bounded candidate route, and a later,
   * completely unrelated stop_blocked could then hijack it as if it were the route that had
   * failed. Marked, per fingerprint, only at the exact step a genuine anchor-recovery event
   * happens there (a zero-hop anchor retry, a verified hop-based restoration, or the
   * already-achieved-target bypass -- see this file's own call sites) -- entry is eligible
   * only on that *same* step, never carried over to a later, ordinary revisit of the same
   * fingerprint.
   */
  private readonly anchorRecoveredAtStep = new Map<string, number>();

  markAnchorRecovered(fingerprint: string, stepIndex: number): void {
    this.anchorRecoveredAtStep.set(fingerprint, stepIndex);
  }

  wasAnchorRecoveredThisStep(fingerprint: string, stepIndex: number): boolean {
    return this.anchorRecoveredAtStep.get(fingerprint) === stepIndex;
  }

  /** Full diagnostic history for TaskResponse.diagnostics.recovery/alternativeExploration/consent -- see src/types/recovery.ts. */
  readonly recoveryAttemptDiagnostics: RecoveryAttemptDiagnostic[] = [];
  readonly alternativeCandidateDiagnostics: AlternativeCandidateAttemptDiagnostic[] = [];
  readonly routeAttemptDiagnostics: RouteAttemptDiagnostic[] = [];
  readonly consentSurfaceDiagnostics: ConsentSurfaceDiagnostic[] = [];
  consentRetriesUsed = 0;
  /** Full diagnostic history for TaskResponse.diagnostics.surfaceAdoption -- see src/types/recovery.ts and core/surfaceReturn.ts. */
  readonly surfaceAdoptionDiagnostics: SurfaceAdoptionAttemptDiagnostic[] = [];
  /** Return-to-parent recovery (Phase 3 PR 4): total go_back-while-off-"main" return attempts this run, successful or not. */
  surfaceReturnAttempts = 0;

  /** 1-based rank counter of distinct candidates tried per recovery-anchor fingerprint, for RouteAttemptDiagnostic.candidateRank -- reset is never needed (a monotonically increasing rank across this anchor's own bounded budget is exactly what "1st/2nd/3rd candidate tried here" means). */
  private readonly candidateRankByFingerprint = new Map<string, number>();

  nextCandidateRank(fingerprint: string): number {
    const next = (this.candidateRankByFingerprint.get(fingerprint) ?? 0) + 1;
    this.candidateRankByFingerprint.set(fingerprint, next);
    return next;
  }

  /** Total go_back hops spent restoring toward any recovery anchor this run -- bounded independently of journeyReplanningAttempts (core/loop.ts's MAX_ANCHOR_RESTORE_HOPS_TOTAL), so anchored recovery has its own dedicated, generous-but-bounded budget rather than sharing the small no-anchor fallback allowance. */
  anchorRestoreHopsAttempted = 0;

  /** Anchor fingerprints whose own bounded restore-and-explore budget has already been exhausted this run -- excluded from selectRecoveryAnchor so a later trigger tries the next-older anchor instead of retrying a known-unrestorable one. */
  readonly exhaustedAnchorFingerprints = new Set<string>();

  recordVisit(url: string): void {
    this.visitedUrls.push(url);
    this.distinctVisitedUrls.add(url);
  }

  recordAction(
    action: SelectedAction,
    observationBefore: { url: string; title: string },
    surfaceChangeType?: string,
  ): void {
    this.actionHistory.push({ ...action, ...(surfaceChangeType ? { surfaceChangeType } : {}) });
    this.stepCount += 1;
    if (action.type === "go_back") {
      this.backtrackCount += 1;
    }
    this.lastActionObservationBefore = observationBefore;
  }

  /**
   * Records a route-memory candidate's outcome immediately, for the two cases already
   * known without waiting for a further observation: "blocked" (the safety layer rejected
   * the decision before it was ever dispatched) and "failed" (the action was dispatched but
   * did not execute successfully). See RunState.recordRouteMemoryPending for the third,
   * deferred case ("advanced"/"no_change").
   */
  recordRouteMemoryOutcome(
    fingerprint: string,
    candidate: RouteMemoryCandidate,
    outcome: Exclude<RouteMemoryOutcome, "advanced" | "no_change">,
  ): void {
    this.routeMemory.record(fingerprint, candidate, outcome);
  }

  /**
   * Fills in observedProgress on the most recently recorded action by comparing the page
   * state immediately before it was dispatched (lastActionObservationBefore) against
   * `url`/`title` from the next observation actually taken (see core/loop.ts, called once
   * at the very top of every step, before that step's own action is recorded). A plain
   * URL/title diff -- never specific to any action type, capture module, brand, or URL
   * pattern -- so the reasoning layer can be told, generically, "the last time this action
   * ran, nothing about the page changed" instead of having to infer that (or fail to) from
   * repeated action identity alone. A no-op once already resolved, and permanently a no-op
   * for a run's very last action, since no further observation is ever taken to compare
   * against.
   */
  resolveLastActionProgress(url: string, title: string): void {
    const before = this.lastActionObservationBefore;
    if (!before) {
      return;
    }
    const last = this.actionHistory[this.actionHistory.length - 1];
    if (!last || last.observedProgress !== undefined) {
      return;
    }
    const progressed = url !== before.url || title !== before.title;
    last.observedProgress = progressed;
  }

  /**
   * Goal-Directed Bounded Branch Exploration: the single currently-active bounded branch
   * (see core/branchExploration.ts), or undefined when no branch is in progress. Only one
   * active branch is supported in this phase -- deliberately, per the investigation report
   * and the task's own scope: nested/concurrent branches are not implemented. Stays
   * populated (with `result` set) throughout its own multi-hop return sequence, so
   * core/loop.ts can tell "still exploring" (`!activeBranch.result`) apart from "closed,
   * returning" (`activeBranch.result` set, `returnStatus !== "restored"`) across the
   * several separate runStep calls a return can take.
   */
  activeBranch: BranchRecord | undefined;

  /**
   * Closed branches, most recent last, bounded the same way every other per-run diagnostic
   * collection in this file is (never unbounded) -- see MAX_BRANCH_HISTORY. Never persisted
   * beyond this run, never surfaced on TaskResponse directly; used only for in-run
   * diagnostics text (StepLog.decision / captures.errors -- see core/loop.ts) and for the
   * candidate-budget accounting below.
   */
  readonly branchHistory: BranchRecord[] = [];

  private branchCounter = 0;

  /** How many branches have been *entered* (not necessarily yet closed) at each decision-point fingerprint -- the candidate-budget accounting (MAX_CANDIDATE_BUDGET_PER_DECISION_POINT, core/branchExploration.ts). */
  private readonly branchAttemptsByDecisionPoint = new Map<string, number>();

  getBranchAttempts(decisionPointFingerprint: string): number {
    return this.branchAttemptsByDecisionPoint.get(decisionPointFingerprint) ?? 0;
  }

  nextBranchId(): string {
    this.branchCounter += 1;
    return `branch-${this.branchCounter}`;
  }

  /**
   * Begins tracking a new active branch. For entryReason "ambiguity" (unchanged from
   * before this corrective pass), counts it against MAX_CANDIDATE_BUDGET_PER_DECISION_POINT
   * via branchAttemptsByDecisionPoint. For entryReason "milestone_recovery", that counter is
   * deliberately left untouched -- its own, independent budget
   * (alternativeExplorationAttemptsByFingerprint, incremented by the caller via
   * incrementAlternativeExplorationAttempts) applies instead, so the two entry paths can
   * never contend for or drain each other's budget at the same decision point. Caller
   * (core/loop.ts) is responsible for confirming no branch is already active and that the
   * relevant budget/depth preconditions hold before calling this.
   */
  startBranch(record: BranchRecord): void {
    this.activeBranch = record;
    if (record.entryReason === "ambiguity") {
      this.branchAttemptsByDecisionPoint.set(
        record.decisionPointId,
        this.getBranchAttempts(record.decisionPointId) + 1,
      );
    }
  }

  /** Moves the active branch into bounded history and clears it, once it has fully finished (either succeeded, or its return sequence has resolved to restored/restore_failed). No-op if no branch is active. */
  archiveActiveBranch(): void {
    const branch = this.activeBranch;
    if (!branch) {
      return;
    }
    this.activeBranch = undefined;
    this.branchHistory.push(branch);
    if (this.branchHistory.length > MAX_BRANCH_HISTORY) {
      this.branchHistory.splice(0, this.branchHistory.length - MAX_BRANCH_HISTORY);
    }
  }
}
