import type { ActionType, SelectedAction } from "../types/actions.js";
import type { SuccessCriterion } from "../types/task-request.js";
import type { Observation, ReasoningProviderDiagnostics } from "../types/task-response.js";

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
  recentActions: SelectedAction[];
  satisfiedCriteriaIds: string[];
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
