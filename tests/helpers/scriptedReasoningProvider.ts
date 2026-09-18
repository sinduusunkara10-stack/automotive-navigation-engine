import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { REASONING_PROVIDER_DIAGNOSTICS_VERSION } from "../../src/reasoning/reasoningProvider.js";
import type { InteractiveElement, ReasoningProviderDiagnostics } from "../../src/types/task-response.js";

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): a deterministic ReasoningProvider, like MockReasoningProvider, but driven by
 * an explicit ordered queue of element selectors rather than a fixed "match /continue/i and
 * skip anything already-clicked" heuristic.
 *
 * MockReasoningProvider's own already-clicked tracking is keyed by element id alone
 * (observation/observationBuilder.ts's `el-<n>` counter, freshly restarted at 0 for every
 * document a Page loads -- including every adopted popup, which is its own fresh browsing
 * context/global). Two genuinely different controls on two different documents can
 * therefore legitimately share the same id, which MockReasoningProvider's tracking cannot
 * tell apart from "the same control, seen again" -- immaterial for its own existing
 * single-tracked-page fixtures (each already varies its own element count enough to avoid
 * it by accident), but exactly the multi-document chain (main page -> adopted popup ->
 * possibly a nested popup) these surface-adoption integration tests need to drive
 * end-to-end, and exactly what these tests also need to prove: that the *correct* one of
 * several repeated-label controls (core/routeMemory.ts's nearestHeadingText disambiguation)
 * is the one selected. A queue of selectors matched against accessibleName/nearestHeadingText
 * sidesteps both needs at once, without weakening anything MockReasoningProvider itself is
 * tested against elsewhere.
 */
export type ElementSelector = (element: InteractiveElement) => boolean;

/**
 * Return-to-parent recovery (Phase 3 PR 4): a queue entry may also be the literal "go_back",
 * for a test that needs the reasoning layer itself to select go_back directly (acceptance
 * criterion "recover to parent"), rather than relying on the engine's own internal
 * journey-replanning/branch-return substitution to produce one. Never consumed unless
 * go_back is actually an allowedAction, exactly like an ElementSelector is never consumed
 * unless a matching, visible candidate actually exists.
 */
export type ScriptedStep = ElementSelector | "go_back";

export function byAccessibleName(name: string): ElementSelector {
  return (el) => el.accessibleName.trim() === name;
}

export function byAccessibleNameAndHeading(name: string, heading: string): ElementSelector {
  return (el) => el.accessibleName.trim() === name && el.nearestHeadingText === heading;
}

export class ScriptedReasoningProvider implements ReasoningProvider {
  private readonly queue: ScriptedStep[];
  private cursor = 0;
  /** Every decision this provider actually produced, for test assertions (e.g. "no candidate was ever found for step N"). */
  readonly decisions: Decision[] = [];

  constructor(queue: ScriptedStep[]) {
    this.queue = queue;
  }

  getUsageDiagnostics(): ReasoningProviderDiagnostics {
    return {
      version: REASONING_PROVIDER_DIAGNOSTICS_VERSION,
      provider: "mock",
      callCount: 0,
      acceptedDecisionCount: 0,
      rejectedDecisionCount: 0,
      fallbackDecisionCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalLatencyMs: 0,
      retryCount: 0,
    };
  }

  async decide(context: ReasoningContext): Promise<Decision> {
    const { observation, successCriteria, allowedActions, recentActions, satisfiedCriteriaIds } = context;

    const requiredCriteriaIds = successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allRequiredSatisfied = requiredCriteriaIds.every((id) => satisfiedCriteriaIds.includes(id));

    if (allRequiredSatisfied) {
      const alreadyCaptured = recentActions.some((a) => a.type === "capture");
      if (!alreadyCaptured && allowedActions.includes("capture")) {
        const decision: Decision = { action: { type: "capture" }, rationale: "Success criteria satisfied; capturing." };
        this.decisions.push(decision);
        return decision;
      }
      if (allowedActions.includes("stop_success")) {
        const decision: Decision = { action: { type: "stop_success" }, rationale: "All required criteria satisfied." };
        this.decisions.push(decision);
        return decision;
      }
    }

    if (this.cursor < this.queue.length) {
      const step = this.queue[this.cursor];
      if (step === "go_back") {
        if (allowedActions.includes("go_back")) {
          this.cursor += 1;
          const decision: Decision = {
            action: { type: "go_back" },
            rationale: `Scripted step ${this.cursor}: go_back.`,
          };
          this.decisions.push(decision);
          return decision;
        }
      } else {
        const selector = step;
        const candidate = selector ? observation.interactiveElements.find((el) => el.visible !== false && selector(el)) : undefined;
        if (candidate && allowedActions.includes("click")) {
          this.cursor += 1;
          const decision: Decision = {
            action: { type: "click", target: candidate.id },
            rationale: `Scripted step ${this.cursor}: selected "${candidate.accessibleName}"${candidate.nearestHeadingText ? ` (heading "${candidate.nearestHeadingText}")` : ""}.`,
          };
          this.decisions.push(decision);
          return decision;
        }
      }
    }

    const decision: Decision = allowedActions.includes("stop_failure")
      ? { action: { type: "stop_failure" }, rationale: "Scripted queue exhausted, or its next candidate was not found on this page." }
      : { action: { type: "stop_blocked" }, rationale: "No permitted action is available for this task." };
    this.decisions.push(decision);
    return decision;
  }
}
