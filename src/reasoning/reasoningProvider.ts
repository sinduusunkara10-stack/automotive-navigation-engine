import type { ActionType, SelectedAction } from "../types/actions.js";
import type { SuccessCriterion } from "../types/task-request.js";
import type { Observation } from "../types/task-response.js";

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
}
