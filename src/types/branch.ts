/**
 * Goal-Directed Bounded Branch Exploration: shared type shapes at the boundary between
 * src/core (which owns the actual branch/milestone state and evidence) and src/reasoning
 * (which only ever sees a small, compact, derived summary of it). Kept in src/types,
 * alongside routeMemory.ts/actions.ts/captureModule.ts, for the same reason
 * routeMemory.ts's shared shapes live there and not in src/core/routeMemory.ts -- see that
 * file's own "Why src/types/routeMemory.ts" note: src/core already depends on
 * src/reasoning's types (loop.ts imports Decision/ReasoningProvider), so a shared shape
 * both directories need must live in the layer both already depend on, never in either
 * implementation module directly.
 *
 * Everything here is engine-internal: none of it is part of
 * schemas/task-request.schema.json or schemas/task-response.schema.json, and none of it is
 * persisted or shared across runs.
 */

/**
 * The outcome of a bounded branch (or, upgraded from a single candidate outcome, part of a
 * Route Memory entry -- see core/routeMemory.ts). Distinct from RouteMemoryOutcome
 * (routeMemory.ts), which describes only a single dispatched action's own mechanical
 * result; this describes the accumulated result of following a candidate for possibly
 * several downstream actions.
 */
export type BranchResult =
  | "success"
  | "goal_progress"
  | "plausible_progress"
  | "neutral_progress"
  | "dead_end"
  | "blocked"
  | "unsafe"
  | "unknown";

export interface MilestoneGroupSummary {
  id: string;
  description: string;
}

/**
 * Compact, evidence-derived rollup of objective progress -- see
 * core/successEvaluator.ts's computeMilestoneRollup. Reuses the exact same
 * SuccessCriterion/group/required semantics getMissingRequiredCriteriaIds and
 * computeEstimatedCompletion already implement; this is purely a different, human/model
 * -readable *shape* of the same underlying evidence, never a second source of truth.
 */
export interface MilestoneRollup {
  totalMilestones: number;
  completedMilestones: number;
  completed: MilestoneGroupSummary[];
  remaining: MilestoneGroupSummary[];
  activeSubGoal?: MilestoneGroupSummary;
}

/**
 * The compact, bounded branch context surfaced to the reasoning provider while a branch is
 * actively being explored (see core/loop.ts / reasoning/promptBuilder.ts) -- never the full
 * BranchRecord (core/branchExploration.ts), which also carries bookkeeping (visited
 * fingerprints, return-hop counters) the reasoning layer has no use for and which would
 * cost prompt tokens for no decision-relevant benefit.
 */
export interface BranchPromptContext {
  candidateLabel: string;
  depthUsed: number;
  depthRemaining: number;
  newlySatisfiedCriteriaIds: string[];
  candidateBudgetUsed: number;
  candidateBudgetRemaining: number;
}
