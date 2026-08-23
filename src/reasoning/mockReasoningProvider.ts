import type { Decision, ReasoningContext, ReasoningProvider } from "./reasoningProvider.js";

/**
 * Deterministic stand-in for the Claude reasoning client. It selects only from the
 * fixed action vocabulary supplied in `allowedActions` and never inspects raw page
 * markup — only the compact Observation the core loop already built.
 */
export class MockReasoningProvider implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    const { observation, successCriteria, allowedActions, recentActions, satisfiedCriteriaIds } = context;

    const requiredCriteriaIds = successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allRequiredSatisfied = requiredCriteriaIds.every((id) => satisfiedCriteriaIds.includes(id));

    if (allRequiredSatisfied) {
      const alreadyCaptured = recentActions.some((a) => a.type === "capture");
      if (!alreadyCaptured && allowedActions.includes("capture")) {
        return {
          action: { type: "capture" },
          rationale: "Success criteria are satisfied; capturing evidence of the final state before stopping.",
        };
      }
      if (allowedActions.includes("stop_success")) {
        return {
          action: { type: "stop_success" },
          rationale: "All required success criteria are satisfied and evidence has been captured.",
        };
      }
    }

    const clickedTargets = new Set(
      recentActions.filter((a) => a.type === "click" && a.target).map((a) => a.target as string),
    );

    const candidate = observation.interactiveElements.find(
      (el) => el.visible !== false && !clickedTargets.has(el.id) && /continue/i.test(el.accessibleName),
    );

    if (candidate && allowedActions.includes("click")) {
      return {
        action: { type: "click", target: candidate.id },
        rationale: `Selected the visible "${candidate.accessibleName}" control to move toward the objective.`,
      };
    }

    if (allowedActions.includes("stop_failure")) {
      return {
        action: { type: "stop_failure" },
        rationale: "No permitted action moves the run closer to the objective.",
      };
    }

    return {
      action: { type: "stop_blocked" },
      rationale: "No permitted action is available for this task.",
    };
  }
}
