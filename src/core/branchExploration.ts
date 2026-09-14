import type { Observation } from "../types/task-response.js";
import type { BranchResult } from "../types/branch.js";
import { objectiveRelevanceScore } from "../discovery/relevance.js";
import { buildClickIdentityKey } from "./routeMemory.js";

/**
 * Goal-Directed Bounded Branch Exploration (behavioural phase). This module holds the
 * generic, pure decision logic -- branch-entry eligibility, effective depth budgeting, and
 * in-branch progress assessment -- kept separate from core/state.ts (which owns the
 * mutable per-run RunState.activeBranch) and core/loop.ts (which orchestrates dispatch,
 * safety, and the multi-hop return sequence). Nothing here is automotive/brand/site
 * specific: every signal is either already-generic observation data (role, accessibleName)
 * or already-generic engine bookkeeping (depth, budgets, evidence deltas).
 *
 * This is current-run only. Nothing here is persisted, and nothing here introduces
 * cross-run memory, RAG, or a vector store -- see docs/architecture.md "Route Memory
 * (Phase 1)" for the same constraint already established for PR #42, which this phase
 * extends rather than replaces.
 */

// Starting point per the investigation report: independently justified against
// MAX_JOURNEY_REPLANNING_ATTEMPTS (2, core/loop.ts) so one branch's own cost stays
// comparable to, not dominant over, the run's existing "give up and try something else"
// budget -- not chosen merely because the task description mentions "two or three."
export const DEFAULT_MAX_BRANCH_DEPTH = 3;

// Conservative starting point matching MAX_JOURNEY_REPLANNING_ATTEMPTS's own precedent for
// a bounded, fixed (not task-configurable) recovery-shaped constant.
export const MAX_CANDIDATE_BUDGET_PER_DECISION_POINT = 2;

// Diagnostic-only bound on retained branch history -- never unbounded, matching this
// repo's existing appendBounded/capPreservingEnds convention (src/core/boundedArray.ts)
// for every other per-run collection.
export const MAX_BRANCH_HISTORY = 20;

export interface BranchRecord {
  branchId: string;
  /** Decision-point fingerprint (see core/routeMemory.ts) the branch was entered from -- the return sequence's target. */
  decisionPointId: string;
  candidateId: string;
  candidateLabel: string;
  entryStepIndex: number;
  /** Downstream actions taken since entry -- 0 immediately after entry, before any further action has dispatched. */
  depth: number;
  maxDepth: number;
  /** Decision-point fingerprints seen since entry (not including decisionPointId itself) -- used to detect an in-branch loop. */
  visitedFingerprints: string[];
  satisfiedCriteriaIdsAtEntry: string[];
  /** Criteria ids newly satisfied since entry, accumulated across the branch's own life. */
  newlySatisfiedCriteriaIds: string[];
  consecutiveNoProgress: number;
  result?: BranchResult;
  returnStatus?: "not_attempted" | "restored" | "restore_failed";
  returnHopsAttempted: number;
  returnHopsBudget: number;
}

/**
 * Reduces the fixed DEFAULT_MAX_BRANCH_DEPTH so a branch never promises more of the run's
 * remaining budget than it can actually afford: reserves, on top of the branch's own
 * downstream actions, up to (depth + 1) return hops (a branch's return can need one hop per
 * downstream action taken, never assumed to be fewer -- see core/loop.ts's return sequence)
 * and at least one further candidate attempt at the same decision point. Returns 0 (never
 * negative) when the remaining budget cannot safely support any branch depth at all -- the
 * caller must then skip branch entry entirely, not attempt one with less oversight.
 *
 * Duration is handled coarsely (never a step-count converter, since a step's own real-world
 * duration is unpredictable): once at least 90% of maxDurationSeconds has already elapsed,
 * there is no safe room left to promise further bounded exploration, so this returns 0
 * regardless of the step/backtrack numbers.
 */
export function computeEffectiveBranchDepth(params: {
  requestedMaxDepth: number;
  stepsRemaining: number;
  backtracksRemaining: number;
  maxDurationSeconds?: number;
  elapsedMs: number;
}): number {
  const { requestedMaxDepth, stepsRemaining, backtracksRemaining, maxDurationSeconds, elapsedMs } = params;

  if (maxDurationSeconds !== undefined) {
    const elapsedSeconds = elapsedMs / 1000;
    if (elapsedSeconds >= maxDurationSeconds * 0.9) {
      return 0;
    }
  }

  // totalStepsNeeded(d) = d (downstream) + (d + 1) (worst-case return) + 1 (one more
  // candidate afterward) = 2d + 2 <= stepsRemaining  =>  d <= (stepsRemaining - 2) / 2.
  const stepBound = Math.floor((stepsRemaining - 2) / 2);
  // Worst-case return cost is (d + 1) hops, each one a go_back counted against maxBacktracks.
  const backtrackBound = backtracksRemaining - 1;

  return Math.max(0, Math.min(requestedMaxDepth, stepBound, backtrackBound));
}

// A candidate's objectiveRelevanceScore (src/discovery/relevance.ts) is
// overlap / candidateTokens.size -- for a short label (the common case for a button/link:
// one or two meaningful words), this means "at least half of the candidate's own words are
// drawn from the objective/criteria text" is a genuine, dominant lexical match, not an
// incidental one. Reused the same way DEFAULT_SEMANTIC_MIN_SCORE (core/successEvaluator.ts)
// draws its own conservative "is this signal strong enough to trust" line for a different
// scorer -- same judgement-call reasoning, an independently-derived value for this scorer's
// own overlap-ratio semantics, not the same literal constant.
const MIN_DOMINANT_RELEVANCE_SCORE = 0.5;

/**
 * A decision point is treated as ambiguous enough to warrant bounded branch exploration
 * when it offers at least two distinct, plausible route choices (the same candidate
 * identity core/routeMemory.ts already uses -- role+accessibleName for click) and no
 * candidate's own objectiveRelevanceScore (src/discovery/relevance.ts) clears
 * MIN_DOMINANT_RELEVANCE_SCORE -- i.e. no candidate's label is a genuinely dominant lexical
 * match for the objective/criteria text.
 *
 * This underwent two design iterations before landing here, both worth recording:
 *
 * 1. Originally "every candidate scores zero". That let a single *incidental* token match
 *    -- one candidate's label happening to share one word with the objective/criteria text
 *    without that word actually indicating the right path -- silence branch exploration for
 *    the *whole* decision point, including for a genuinely zero-relevance alternative that
 *    might be the real route.
 * 2. Revised to "no candidate uniquely holds the top score" (a tie-based check) to close
 *    that gap. This introduced a real regression: two candidates that are each a *strong*,
 *    legitimate match (e.g. a page offering both "Continue" and "Objective control" for an
 *    objective literally naming both, in sequence) trivially tie at the maximum possible
 *    score for short labels -- objectiveRelevanceScore has no way to distinguish "these tie
 *    because neither means anything" from "these tie because both are excellent matches"
 *    from equality alone; only the score's own *magnitude* carries that information.
 *    (`tests/integration/journeyReplanning.test.ts`'s own domain-blocked-replanning test
 *    caught this directly -- two candidates on one page both scoring a full 1.0 incorrectly
 *    triggered branch mode instead of leaving that page's decision to the existing,
 *    already-validated direct-selection behaviour PR #41 relies on.)
 *
 * The magnitude threshold here supersedes tie-detection entirely: a *unique* top scorer
 * below the threshold is still ambiguous (closing gap 1 above -- a weak, non-dominant match
 * doesn't get to silence exploration of a zero-scoring alternative), and a *tied* top score
 * at or above the threshold is not ambiguous (closing the regression from iteration 2 --
 * two dominant matches are left to existing selection behaviour, tie or not). Both a
 * dominant unique winner and a dominant tie are trusted to the existing,
 * already-validated direct-selection/ranking behaviour -- Route Memory Phase 1 and bounded
 * journey replanning remain the safety net if that pick turns out wrong, so no branch
 * bookkeeping is layered on top of an otherwise-ordinary decision.
 *
 * Deliberately scoped to click candidates only (via Observation.interactiveElements, the
 * same source computeCandidateIdentity's click branch resolves against): a `navigate`
 * candidate in this observation-driven model is not something visibly "offered" at a
 * decision point the same way an interactive element is, so it is not part of this
 * ambiguity signal (though a navigate action can still separately trigger ordinary branch
 * bookkeeping once dispatched -- see core/loop.ts).
 */
export function isAmbiguousMultiCandidateDecisionPoint(params: {
  observation: Observation;
  relevanceText: string;
}): boolean {
  const { observation, relevanceText } = params;
  // Deduplicated by candidate identity (not per raw element) before comparing scores, so
  // two elements that are really the *same* candidate (identical role+accessibleName)
  // never get counted as two independent entries.
  const scoreByIdentity = new Map<string, number>();

  for (const el of observation.interactiveElements) {
    if (el.visible === false || el.disabled || el.covered) {
      continue;
    }
    const identity = `click::${buildClickIdentityKey(el)}`;
    const score = objectiveRelevanceScore(relevanceText, el.accessibleName);
    const existing = scoreByIdentity.get(identity);
    if (existing === undefined || score > existing) {
      scoreByIdentity.set(identity, score);
    }
  }

  if (scoreByIdentity.size < 2) {
    return false;
  }

  const maxScore = Math.max(...scoreByIdentity.values());
  return maxScore < MIN_DOMINANT_RELEVANCE_SCORE;
}

export interface BranchAssessmentInput {
  depth: number;
  maxDepth: number;
  isRevisitFingerprint: boolean;
  lastActionObservedProgress: boolean | undefined;
  consecutiveNoProgress: number;
  newlySatisfiedCountThisStep: number;
  hasAnyNewlySatisfiedInBranch: boolean;
}

export interface BranchAssessmentResult {
  shouldContinue: boolean;
  result: BranchResult;
  consecutiveNoProgress: number;
  reason: string;
}

/**
 * Evidence-backed branch-progress assessment for the "everything dispatched successfully
 * and was allowed" case -- a failed dispatch or a safety-layer rejection is handled inline
 * at its own point in core/loop.ts (closing the branch as "blocked"/"unsafe" immediately,
 * never deferred to a later assessment call), so this function only ever needs to decide
 * whether a *successful* in-branch action still represents a plausible path forward. Pure
 * and deterministic: given the same inputs (all of them either existing engine evidence --
 * observedProgress, a success-criteria delta -- or bookkeeping this module itself owns), it
 * always returns the same verdict. Claude is never consulted here.
 */
export function assessBranchProgress(input: BranchAssessmentInput): BranchAssessmentResult {
  const consecutiveNoProgress =
    input.lastActionObservedProgress === false ? input.consecutiveNoProgress + 1 : 0;

  if (input.isRevisitFingerprint) {
    return {
      shouldContinue: false,
      result: "dead_end",
      consecutiveNoProgress,
      reason: "The branch revisited a decision point already seen earlier in this same branch.",
    };
  }

  if (consecutiveNoProgress >= 2) {
    return {
      shouldContinue: false,
      result: "dead_end",
      consecutiveNoProgress,
      reason: "Two consecutive in-branch actions produced no observable page-state change.",
    };
  }

  if (input.depth >= input.maxDepth) {
    return {
      shouldContinue: false,
      result: input.hasAnyNewlySatisfiedInBranch ? "plausible_progress" : "dead_end",
      consecutiveNoProgress,
      reason: "The branch-depth budget was reached.",
    };
  }

  if (input.newlySatisfiedCountThisStep > 0) {
    return {
      shouldContinue: true,
      result: "goal_progress",
      consecutiveNoProgress,
      reason: "A milestone/success criterion became newly satisfied within this branch.",
    };
  }

  return {
    shouldContinue: true,
    result: input.hasAnyNewlySatisfiedInBranch ? "plausible_progress" : "neutral_progress",
    consecutiveNoProgress,
    reason: "The branch continues within its depth budget.",
  };
}

/**
 * Classifies why a branch is being closed when the safety layer rejected the decision that
 * would have continued it -- generic, based only on the same flag names src/safety already
 * produces (never page content, never a domain/brand-specific rule). "loop_detected" maps
 * to "dead_end" (it is exactly the DEAD END condition "the branch ... loops"); a
 * domain/action-policy rejection maps to "unsafe" (an existing safety rule, not a mechanical
 * obstruction); anything else (e.g. repeated_action) maps to the more mechanical "blocked".
 */
export function classifyClosureFromSafetyFlags(flags: readonly string[]): BranchResult {
  if (flags.includes("loop_detected")) {
    return "dead_end";
  }
  if (flags.includes("domain_blocked") || flags.includes("action_not_allowed")) {
    return "unsafe";
  }
  return "blocked";
}
