import type { ActionType } from "./actions.js";

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
}
