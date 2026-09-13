import type { ActionType } from "./actions.js";
import type { BranchResult } from "./branch.js";

/**
 * Shared Route Memory types (see core/routeMemory.ts for the fingerprint/candidate-identity
 * logic and the per-run store). Kept in src/types, alongside actions.ts/captureModule.ts, so
 * both src/core and src/reasoning can depend on the type shapes without either depending on
 * the other's implementation module.
 */

export type RouteMemoryOutcome = "advanced" | "no_change" | "failed" | "blocked";

export interface RouteMemoryCandidate {
  /** Stable identity of this candidate, independent of the ephemeral per-observation element id -- see core/routeMemory.ts's computeCandidateIdentity. */
  id: string;
  actionType: ActionType;
  /** Human-readable description of the candidate for the reasoning prompt (e.g. `button "Continue"`, or the target URL for navigate). */
  label: string;
}

export interface RouteMemoryCandidateSummary {
  actionType: ActionType;
  label: string;
  attempts: number;
  lastOutcome: RouteMemoryOutcome;
  /**
   * Goal-Directed Bounded Branch Exploration (see core/branchExploration.ts): the deepest
   * downstream depth reached by a bounded branch entered through this candidate, and that
   * branch's own accumulated result -- distinct from, and never overwriting,
   * `lastOutcome`/`attempts` above, which continue to describe only this candidate's own
   * single dispatched-action outcome exactly as PR #42 (Route Memory Phase 1) defined it.
   * Absent when no branch was ever entered through this candidate (the common case for a
   * candidate that was a clear, direct, non-ambiguous choice).
   */
  branchDepthReached?: number;
  branchResult?: BranchResult;
  /** How many separate branches have been entered through this candidate (bounded by MAX_CANDIDATE_BUDGET_PER_DECISION_POINT at the owning decision point, never by this candidate alone). */
  branchAttempts?: number;
}
