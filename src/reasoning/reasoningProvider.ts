import type { ActionType, SelectedAction } from "../types/actions.js";
import type { ConsentInteractionPolicy, SuccessCriterion } from "../types/task-request.js";
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
  /** See ConsentInteractionPolicy (types/task-request.ts). Always present -- core/loop.ts resolves the task's omitted-field default ("reject_optional") before building this context, so a provider never has to know the default itself. */
  consentInteractionPolicy: ConsentInteractionPolicy;
  /**
   * Optional, engine-internal evidence-based progress for any successCriteria description
   * that generically parses into multiple explicit ordered instruction lines (the real n8n
   * request shape -- see src/reasoning/instructionParser.ts and
   * src/core/instructionProgress.ts), keyed by criterion id. Never part of the wire request/
   * response contract; absent/empty behaves exactly as if this field didn't exist (see
   * computeInstructionProgress, src/reasoning/promptBuilder.ts).
   */
  internalInstructionProgress?: Readonly<Record<string, number>>;
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
