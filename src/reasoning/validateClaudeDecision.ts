import type { ActionType, SelectedAction } from "../types/actions.js";
import type { ReasoningContext } from "./reasoningProvider.js";
import { checkNavigationAllowed } from "../safety/domainGuard.js";
import type { ClaudeDecisionPayload } from "./claudeDecisionSchema.js";

export type ClaudeDecisionRejectionReason =
  | "action_not_allowed"
  | "low_confidence"
  | "missing_target_element_id"
  | "unknown_target_element_id"
  | "navigate_not_allowed";

export type ClaudeDecisionValidation =
  | { valid: true; action: SelectedAction; reason: string; confidence: number }
  | { valid: false; reason: ClaudeDecisionRejectionReason };

const ACTIONS_REQUIRING_ELEMENT_TARGET: ReadonlySet<ActionType> = new Set(["click"]);

/**
 * Second, engine-side line of defence on top of the strict structured-output schema:
 * re-checks the action against this run's allowedActions, resolves targetElementId
 * against the elements actually observed this step, and — for navigate — re-validates
 * the URL against allowedDomains using the same domainGuard the safety layer uses. A
 * decision only reaches the safety layer / Playwright after passing this.
 */
export function validateClaudeDecision(
  payload: ClaudeDecisionPayload,
  context: ReasoningContext,
  minConfidence: number,
): ClaudeDecisionValidation {
  if (!context.allowedActions.includes(payload.action)) {
    return { valid: false, reason: "action_not_allowed" };
  }

  if (payload.confidence < minConfidence) {
    return { valid: false, reason: "low_confidence" };
  }

  if (ACTIONS_REQUIRING_ELEMENT_TARGET.has(payload.action)) {
    if (!payload.targetElementId) {
      return { valid: false, reason: "missing_target_element_id" };
    }
    const knownElement = context.observation.interactiveElements.some((el) => el.id === payload.targetElementId);
    if (!knownElement) {
      return { valid: false, reason: "unknown_target_element_id" };
    }
  }

  if (payload.action === "navigate") {
    if (!payload.navigateUrl || !checkNavigationAllowed(payload.navigateUrl, context.allowedDomains)) {
      return { valid: false, reason: "navigate_not_allowed" };
    }
  }

  return { valid: true, action: buildSelectedAction(payload), reason: payload.reason, confidence: payload.confidence };
}

function buildSelectedAction(payload: ClaudeDecisionPayload): SelectedAction {
  switch (payload.action) {
    case "click":
      return { type: "click", target: payload.targetElementId };
    case "navigate":
      return { type: "navigate", target: payload.navigateUrl };
    case "scroll":
      return payload.params?.deltaY !== undefined
        ? { type: "scroll", params: { deltaY: payload.params.deltaY } }
        : { type: "scroll" };
    case "wait":
      return payload.params?.durationMs !== undefined
        ? { type: "wait", params: { durationMs: payload.params.durationMs } }
        : { type: "wait" };
    default:
      return { type: payload.action };
  }
}
