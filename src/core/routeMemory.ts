import type { SelectedAction } from "../types/actions.js";
import type { Observation } from "../types/task-response.js";
import type { RouteMemoryCandidate, RouteMemoryCandidateSummary, RouteMemoryOutcome } from "../types/routeMemory.js";

export type { RouteMemoryCandidate, RouteMemoryCandidateSummary, RouteMemoryOutcome } from "../types/routeMemory.js";

/**
 * Route Memory (Phase 1): a generic, engine-internal memory of which candidate route
 * choices (click/navigate) have already been tried at a given "decision point" -- a page
 * state identified by its own content, not merely its URL -- and what happened each time.
 *
 * This is deliberately narrower than, and independent of, the existing repeated-action
 * guard (src/safety/repeatedActionGuard.ts): that guard only catches the exact same action
 * target repeating verbatim within a run's linear, adjacent action history. Route Memory
 * instead recognises the *same* decision point recurring across non-adjacent steps (e.g.
 * after a go_back returns to an already-seen page, or after a fresh page load reassigns
 * every element's own ephemeral data-nav-engine-id -- see docs/architecture.md "Observation
 * evidence"), and identifies a candidate by its stable role+accessible-name (click) or
 * target URL (navigate) rather than the per-observation element id the repeated-action
 * guard keys on. It never blocks or overrides a decision itself (Phase 1 is
 * observe-and-inform only) -- it only feeds the reasoning layer's own prompt context (see
 * ReasoningContext.routeMemory / src/reasoning/promptBuilder.ts) so a repeated dead end is
 * visible to it as evidence, the same way `recentActions[].observedProgress` already is.
 *
 * Nothing here is automotive/brand/CTA-specific, and nothing here touches either wire
 * schema (schemas/task-request.schema.json / schemas/task-response.schema.json) -- it is
 * purely an addition to the internal ReasoningContext/RunState boundary.
 */

interface RouteMemoryEntry {
  actionType: RouteMemoryCandidate["actionType"];
  label: string;
  attempts: number;
  lastOutcome: RouteMemoryOutcome;
}

/**
 * Identifies "where" in the journey a decision is being made: the page URL plus the
 * deduplicated, sorted set of visible interactive elements' role+accessibleName. Sorted and
 * deduplicated so DOM reordering or repeated identical controls never change the
 * fingerprint, and so two independently-taken observations of the genuinely same decision
 * point (e.g. before and after a go_back that reloads the page) still fingerprint
 * identically even though every element's own ephemeral id has been reassigned.
 */
export function computeDecisionPointFingerprint(observation: Observation): string {
  const elementSignatures = observation.interactiveElements
    .filter((el) => el.visible !== false)
    .map((el) => `${el.role}::${el.accessibleName}`);
  const uniqueSorted = [...new Set(elementSignatures)].sort();
  return JSON.stringify({ url: observation.url, elements: uniqueSorted });
}

/**
 * Resolves a candidate's stable identity for route-memory purposes, or undefined when the
 * action isn't a route "choice" Route Memory tracks (Phase 1 scope: click and navigate only
 * -- scroll/wait/go_back/capture/stop_* are not alternatives being chosen between at a
 * decision point) or when a click's target can no longer be resolved against the given
 * observation (nothing stable to identify it by).
 */
export function computeCandidateIdentity(
  action: SelectedAction,
  observation: Observation,
): RouteMemoryCandidate | undefined {
  if (action.type === "click") {
    if (!action.target) {
      return undefined;
    }
    const element = observation.interactiveElements.find((el) => el.id === action.target);
    if (!element) {
      return undefined;
    }
    return {
      id: `click::${element.role}::${element.accessibleName}`,
      actionType: "click",
      label: `${element.role} "${element.accessibleName}"`,
    };
  }
  if (action.type === "navigate") {
    if (!action.target) {
      return undefined;
    }
    return {
      id: `navigate::${action.target}`,
      actionType: "navigate",
      label: action.target,
    };
  }
  return undefined;
}

/**
 * Per-run store of route-memory records, keyed by decision-point fingerprint and then by
 * candidate id. A plain in-memory map, scoped to one RunState (see core/state.ts) -- never
 * persisted, never shared across runs, never surfaced on TaskResponse (Phase 1 scope).
 */
export class RouteMemory {
  private readonly byDecisionPoint = new Map<string, Map<string, RouteMemoryEntry>>();

  record(fingerprint: string, candidate: RouteMemoryCandidate, outcome: RouteMemoryOutcome): void {
    let candidates = this.byDecisionPoint.get(fingerprint);
    if (!candidates) {
      candidates = new Map();
      this.byDecisionPoint.set(fingerprint, candidates);
    }
    const existing = candidates.get(candidate.id);
    candidates.set(candidate.id, {
      actionType: candidate.actionType,
      label: candidate.label,
      attempts: (existing?.attempts ?? 0) + 1,
      lastOutcome: outcome,
    });
  }

  /**
   * Upgrades the most recently recorded outcome for one candidate without counting a new
   * attempt -- used to resolve a provisional "no_change" dispatch outcome (see
   * RunState.recordRouteMemoryPending) to "advanced" once the next observation confirms the
   * page actually moved on, mirroring RunState.resolveLastActionProgress's own generic
   * url/title-diff evidence.
   */
  updateLastOutcome(fingerprint: string, candidateId: string, outcome: RouteMemoryOutcome): void {
    const existing = this.byDecisionPoint.get(fingerprint)?.get(candidateId);
    if (existing) {
      existing.lastOutcome = outcome;
    }
  }

  /**
   * Every candidate already tried at this decision point, for the reasoning prompt.
   * Sorted by attempts (descending) then label, so a heavily-repeated dead end always
   * survives ahead of a once-tried candidate if the prompt builder ever has to truncate.
   */
  getTriedCandidates(fingerprint: string): RouteMemoryCandidateSummary[] {
    const candidates = this.byDecisionPoint.get(fingerprint);
    if (!candidates) {
      return [];
    }
    return [...candidates.values()]
      .map((entry) => ({ ...entry }))
      .sort((a, b) => b.attempts - a.attempts || a.label.localeCompare(b.label));
  }
}
