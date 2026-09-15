import type { SelectedAction } from "../types/actions.js";
import type { Limits, Safety } from "../types/task-request.js";
import type { ConsentControlIntent } from "../types/consentControl.js";
import { checkNavigationAllowed } from "./domainGuard.js";
import { checkLimits, type LimitsState } from "./limitsGuard.js";
import { isRepeatedActionLimitExceeded } from "./repeatedActionGuard.js";
import { isLoopDetected } from "./loopDetector.js";
import { isConsentIntentCompliant } from "./consentPolicyGuard.js";

export type { LimitBreach, LimitsState } from "./limitsGuard.js";
export { checkNavigationAllowed } from "./domainGuard.js";
export { isConsentIntentCompliant } from "./consentPolicyGuard.js";

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
  /**
   * Self-reported consent semantics (see types/consentControl.ts) for `action`, when the
   * reasoning provider that produced it supplies one (see reasoningProvider.ts's Decision).
   * Absent (e.g. MockReasoningProvider, or a provider that predates this field) is always
   * treated as "not_consent_related" below -- never a silent bypass of
   * safety.consentInteractionPolicy, since that value is compliant under every policy.
   */
  consentControlIntent?: ConsentControlIntent;
}): SafetyCheckResult {
  const { action, safety, limits, allowedDomains, state, consentControlIntent } = params;
  const flags: string[] = [];

  if (!safety.allowedActions.includes(action.type)) {
    flags.push("action_not_allowed");
  }

  if (action.type === "navigate" && action.target && !checkNavigationAllowed(action.target, allowedDomains)) {
    flags.push("domain_blocked");
  }

  // Final, provider-agnostic backstop for ConsentInteractionPolicy (task-request.ts) --
  // independent of whatever the reasoning layer itself already checked (see
  // validateClaudeDecision.ts's own, Claude-specific pre-dispatch check and its one bounded
  // corrective retry). Enforced here exactly like maxSteps/maxBacktracks/domain-allowlisting
  // above: a hard ceiling the safety layer applies regardless of which provider produced the
  // decision or whether that provider already validated itself (CLAUDE.md's non-negotiable
  // design rule).
  if (!isConsentIntentCompliant(safety.consentInteractionPolicy ?? "reject_optional", consentControlIntent ?? "not_consent_related")) {
    flags.push("consent_policy_violation");
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
