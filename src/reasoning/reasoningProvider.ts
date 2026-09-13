import type { ActionType, RecordedAction, SelectedAction } from "../types/actions.js";
import type { ConsentInteractionPolicy, SuccessCriterion } from "../types/task-request.js";
import type { Observation, ReasoningProviderDiagnostics } from "../types/task-response.js";
import type { RouteMemoryCandidateSummary } from "../types/routeMemory.js";
import type { BranchPromptContext, MilestoneRollup } from "../types/branch.js";

// Version of the diagnostics.reasoningProvider structure a ReasoningProvider.getUsageDiagnostics()
// implementation must return (see ReasoningProviderDiagnostics in ../types/task-response.js),
// independent of TaskResponse.schemaVersion.
// Bumped from "1.0.0" to "1.1.0" for the additive, optional
// decisions[].elementSelection diagnostic (see PromptElementSelectionDiagnostic in
// ../types/task-response.js) -- no existing field removed or renamed.
export const REASONING_PROVIDER_DIAGNOSTICS_VERSION = "1.1.0" as const;

export interface Decision {
  action: SelectedAction;
  rationale: string;
}

export interface ReasoningContextLimits {
  maxSteps: number;
  maxBacktracks: number;
  stepsUsed: number;
  backtracksUsed: number;
}

export interface ReasoningContext {
  objective: string;
  successCriteria: SuccessCriterion[];
  allowedActions: ActionType[];
  allowedDomains: string[];
  limits: ReasoningContextLimits;
  observation: Observation;
  recentActions: RecordedAction[];
  satisfiedCriteriaIds: string[];
  /** See ConsentInteractionPolicy (types/task-request.ts). Always present -- core/loop.ts resolves the task's omitted-field default ("reject_optional") before building this context, so a provider never has to know the default itself. */
  consentInteractionPolicy: ConsentInteractionPolicy;
  /**
   * Route Memory (see core/routeMemory.ts): candidate route choices (click/navigate)
   * already tried at this exact decision point -- the current page state identified by its
   * own content, not merely its URL -- in an earlier attempt, however many steps ago
   * (including after a go_back that returned here). Omitted (rather than an empty array)
   * when nothing has been tried here yet, matching this repo's existing convention for
   * optional context fields (e.g. Observation.progressIndicatorText).
   */
  routeMemory?: RouteMemoryCandidateSummary[];
  /**
   * Goal-Directed Bounded Branch Exploration (see core/successEvaluator.ts's
   * computeMilestoneRollup): a compact rollup of objective-milestone progress, reusing
   * existing successCriteria as the source of truth. Omitted (rather than a trivial single-
   * milestone rollup) when the task declares fewer than two milestone groups -- the common
   * case, and every pre-existing task -- so an ordinary run's prompt is byte-for-byte
   * unaffected by this field's existence.
   */
  milestones?: MilestoneRollup;
  /**
   * Goal-Directed Bounded Branch Exploration (see core/branchExploration.ts): present only
   * while a bounded branch is actively being explored (never while one is merely returning,
   * and never for an ordinary, non-branch decision) -- the compact context needed to keep
   * following or judging the current branch. Omitted entirely otherwise, matching this
   * repo's existing convention for optional context fields.
   */
  branch?: BranchPromptContext;
}

export interface ReasoningProvider {
  decide(context: ReasoningContext): Promise<Decision>;
  /**
   * Safe, per-run aggregated usage diagnostics for this provider (call counts, accept/
   * reject/fallback outcomes, token/latency totals, retries), surfaced under
   * TaskResponse.diagnostics.reasoningProvider. Optional so a provider with nothing to
   * report (or a future provider that hasn't implemented this yet) need not supply it;
   * the engine only attaches diagnostics.reasoningProvider when this returns a value.
   */
  getUsageDiagnostics?(): ReasoningProviderDiagnostics;
}
