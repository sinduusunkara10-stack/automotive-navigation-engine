import type { SelectedAction } from "../types/actions.js";
import type { Observation } from "../types/task-response.js";
import type { RouteMemoryCandidate, RouteMemoryCandidateSummary, RouteMemoryOutcome } from "../types/routeMemory.js";
import type { BranchResult } from "../types/branch.js";

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
  /** See RouteMemoryCandidateSummary's own doc comment (types/routeMemory.ts) -- set only by recordBranchResult below, never by record()/updateLastOutcome(). */
  branchDepthReached?: number;
  branchResult?: BranchResult;
  branchAttempts?: number;
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
 * Repeated-card candidate identity fix (see CLAUDE.md and docs/architecture.md
 * "Repeated-card candidate identity"): a plain role+accessibleName identity collapses two
 * structurally distinct controls into the same candidate whenever a page repeats an
 * identically-labelled action across several cards/list items (e.g. the same "View
 * Details"-style button under every item of a product listing) -- with no per-card
 * distinguishing context, Route Memory and branch exploration (core/branchExploration.ts's
 * isAmbiguousMultiCandidateDecisionPoint) cannot tell "the same button, tried again" apart
 * from "a different card's otherwise-identical button, tried for the first time". Both this
 * module and core/branchExploration.ts build a click candidate's identity through this one
 * shared helper so the two stay consistent.
 *
 * Disambiguating context is added in priority order, using only fields
 * observation/observationBuilder.ts already captures generically (no new DOM scan is
 * introduced by this function itself):
 *   1. destinationUrl -- when the element is a real <a href>, its own destination (e.g. a
 *      distinct product/offer id in the URL or its hash) is the strongest, most stable
 *      per-card signal available, and is already present on Observation today.
 *   2. nearestHeadingText -- for a control with no destinationUrl (a plain <button> driven
 *      entirely by a click handler), the nearest enclosing heading's text is a generic,
 *      markup-agnostic proxy for "which card/section this control belongs to".
 * Falls back to the bare role+accessibleName identity (unchanged, pre-existing behaviour)
 * when neither is available -- genuinely indistinguishable from the data this engine
 * generically captures, same as before this fix.
 */
export function buildClickIdentityKey(element: {
  role: string;
  accessibleName: string;
  destinationUrl?: string;
  nearestHeadingText?: string;
}): string {
  const base = `${element.role}::${element.accessibleName}`;
  if (element.destinationUrl) {
    return `${base}::url:${element.destinationUrl}`;
  }
  if (element.nearestHeadingText) {
    return `${base}::ctx:${element.nearestHeadingText}`;
  }
  return base;
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
      id: `click::${buildClickIdentityKey(element)}`,
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
      // Preserved across a repeated record() call for the same candidate (e.g. this
      // candidate is later dispatched again as an ordinary, non-branch action once its own
      // candidate budget is exhausted) -- a candidate's own single-dispatch bookkeeping
      // must never erase what an earlier bounded branch through it already established.
      ...(existing?.branchDepthReached !== undefined ? { branchDepthReached: existing.branchDepthReached } : {}),
      ...(existing?.branchResult !== undefined ? { branchResult: existing.branchResult } : {}),
      ...(existing?.branchAttempts !== undefined ? { branchAttempts: existing.branchAttempts } : {}),
    });
  }

  /**
   * Records the accumulated result of a bounded branch (core/branchExploration.ts)
   * entered through this candidate -- see RouteMemoryCandidateSummary's own doc comment
   * for why this is kept separate from, and never overwrites, lastOutcome/attempts above.
   * A no-op if this exact (fingerprint, candidateId) pair was never record()ed in the first
   * place (branch entry is only ever attempted for a candidate whose entry dispatch has
   * already been recorded via record()/recordRouteMemoryPending -- see core/state.ts -- so
   * this should always find an existing entry in practice).
   */
  recordBranchResult(
    fingerprint: string,
    candidateId: string,
    params: { depthReached: number; result: BranchResult },
  ): void {
    const existing = this.byDecisionPoint.get(fingerprint)?.get(candidateId);
    if (!existing) {
      return;
    }
    existing.branchDepthReached = params.depthReached;
    existing.branchResult = params.result;
    existing.branchAttempts = (existing.branchAttempts ?? 0) + 1;
  }

  /** True when a bounded branch has already been entered and closed through this exact candidate at this decision point -- used to avoid re-entering an already-explored branch. */
  hasBranchResult(fingerprint: string, candidateId: string): boolean {
    return this.byDecisionPoint.get(fingerprint)?.get(candidateId)?.branchResult !== undefined;
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
