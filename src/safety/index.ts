import type { SelectedAction } from "../types/actions.js";
import type { Limits, Safety } from "../types/task-request.js";
import { checkNavigationAllowed } from "./domainGuard.js";
import { checkLimits, type LimitsState } from "./limitsGuard.js";
import { isRepeatedActionLimitExceeded } from "./repeatedActionGuard.js";
import { isLoopDetected } from "./loopDetector.js";

export type { LimitBreach, LimitsState } from "./limitsGuard.js";
export { checkNavigationAllowed } from "./domainGuard.js";

export interface SafetyState {
  limits: LimitsState;
  actionHistory: SelectedAction[];
  visitedUrls: string[];
}

export interface SafetyCheckResult {
  allowed: boolean;
  flags: string[];
}

export function checkLimitsBreach(state: SafetyState, limits: Limits) {
  return checkLimits(state.limits, limits);
}

export function validateDecision(params: {
  action: SelectedAction;
  safety: Safety;
  limits: Limits;
  allowedDomains: string[];
  state: SafetyState;
}): SafetyCheckResult {
  const { action, safety, limits, allowedDomains, state } = params;
  const flags: string[] = [];

  if (!safety.allowedActions.includes(action.type)) {
    flags.push("action_not_allowed");
  }

  if (action.type === "navigate" && action.target && !checkNavigationAllowed(action.target, allowedDomains)) {
    flags.push("domain_blocked");
  }

  const maxRepeated = limits.maxRepeatedActions ?? 3;
  if (isRepeatedActionLimitExceeded(state.actionHistory, action, maxRepeated)) {
    flags.push("repeated_action");
  }

  if (isLoopDetected(state.visitedUrls)) {
    flags.push("loop_detected");
  }

  return { allowed: flags.length === 0, flags };
}
