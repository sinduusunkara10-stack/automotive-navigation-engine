import type { RecordedAction, SelectedAction } from "../types/actions.js";
import type { RouteMemoryCandidate, RouteMemoryOutcome } from "../types/routeMemory.js";
import type { MilestoneEvidenceRecord } from "../types/task-response.js";
import { RouteMemory } from "./routeMemory.js";
import { MAX_BRANCH_HISTORY, type BranchRecord } from "./branchExploration.js";

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
   * Identity (see observation/observationBuilder.ts's ElementState.coveredBySignature) of
   * whatever intercepted the target of the most recent covered/intercepted stale-target
   * failure, and which target it was blocking -- undefined once that obstruction is
   * confirmed cleared (see core/loop.ts). Generic: keyed only on the intercepting
   * element's own tag/role/text, never on what kind of overlay it is (consent or
   * otherwise), so it applies identically to any blocking overlay.
   */
  lastBlockerTargetId: string | undefined;
  lastBlockerSignature: string | undefined;
  /**
   * How many consecutive times lastBlockerSignature has been re-observed unchanged.
   * core/loop.ts allows one reasoning-provider call while this is 0 (a provider always
   * gets at least one chance to react to a freshly-detected obstruction); once it reaches
   * 1, a further reasoning call is skipped in favour of a deterministic stale-target
   * outcome, so no additional call is spent against a page state that hasn't changed.
   */
  blockerSignatureRepeatCount = 0;

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
   * surfaced on TaskResponse (Phase 1 scope).
   */
  readonly routeMemory = new RouteMemory();

  recordVisit(url: string): void {
    this.visitedUrls.push(url);
    this.distinctVisitedUrls.add(url);
  }

  recordAction(action: SelectedAction, observationBefore: { url: string; title: string }): void {
    this.actionHistory.push({ ...action });
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

  /** Begins tracking a new active branch and counts it against its decision point's candidate budget. Caller (core/loop.ts) is responsible for confirming no branch is already active and that the budget/depth preconditions hold before calling this. */
  startBranch(record: BranchRecord): void {
    this.activeBranch = record;
    this.branchAttemptsByDecisionPoint.set(
      record.decisionPointId,
      this.getBranchAttempts(record.decisionPointId) + 1,
    );
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
