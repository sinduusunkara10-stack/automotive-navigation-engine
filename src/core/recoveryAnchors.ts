import type { Observation } from "../types/task-response.js";
import type { SuccessCriterion } from "../types/task-request.js";
import type { RecoveryAnchor } from "../types/recovery.js";
import { buildClickIdentityKey, computeDecisionPointFingerprint } from "./routeMemory.js";

/**
 * Milestone-anchored recovery (see CLAUDE.md and docs/architecture.md "Milestone-anchored
 * recovery"): pure, deterministic helpers connecting the truthful milestone evidence PR 1D
 * already records to *where* recovery should return to. Nothing here is automotive/brand
 * specific -- every signal is generic engine bookkeeping (declaration order, decision-point
 * fingerprints, candidate identities) already used elsewhere in this repo.
 */

// Bounded, generic proxy for "which candidates were available at this decision point" --
// never a full observation snapshot. Mirrors MAX_ROUTE_MEMORY_CANDIDATES's own order-of-
// magnitude (reasoning/promptBuilder.ts) for the same reason: enough to be useful context,
// never unbounded.
const MAX_CANDIDATE_IDENTITIES_PER_ANCHOR = 20;

/**
 * The same declaration-order-as-milestone-order convention core/successEvaluator.ts's
 * computeMilestoneRollup already uses (see its own doc comment) -- a criterion's index in
 * the flat `criteria` array it belongs to, never a second, separately-maintained ordering.
 */
export function computeCriterionOrder(criteria: readonly SuccessCriterion[], criterionId: string): number {
  const index = criteria.findIndex((c) => c.id === criterionId);
  return index === -1 ? criteria.length : index;
}

/**
 * Candidate identities visible at an anchor's own decision point, for guaranteed-inclusion
 * prompt context later (see reasoning/promptBuilder.ts) and for diagnostics -- bounded and
 * deduplicated, built from the exact same generic role+accessibleName(+destinationUrl/
 * nearestHeadingText) identity core/routeMemory.ts already uses for every other candidate
 * identity in this codebase.
 */
export function computeCandidateIdentitiesAtAnchor(observation: Observation): string[] {
  const identities = new Set<string>();
  for (const el of observation.interactiveElements) {
    if (el.visible === false || el.disabled) {
      continue;
    }
    identities.add(`click::${buildClickIdentityKey(el)}`);
    if (identities.size >= MAX_CANDIDATE_IDENTITIES_PER_ANCHOR) {
      break;
    }
  }
  return [...identities];
}

export function buildRecoveryAnchor(params: {
  criterionId: string;
  criteria: readonly SuccessCriterion[];
  stepIndex: number;
  observation: Observation;
  evidenceTier: "observed" | "inferred" | "assumed";
  sequence: number;
}): RecoveryAnchor {
  const { criterionId, criteria, stepIndex, observation, evidenceTier, sequence } = params;
  return {
    criterionId,
    milestoneOrder: computeCriterionOrder(criteria, criterionId),
    stepIndex,
    pageUrl: observation.url,
    pageTitle: observation.title,
    decisionPointFingerprint: computeDecisionPointFingerprint(observation),
    candidateIdentitiesAtAnchor: computeCandidateIdentitiesAtAnchor(observation),
    evidenceTier,
    sequence,
  };
}

/**
 * The specific required criterion id(s) a candidate route entered *right now* would
 * actually be pursuing -- the first unresolved required group in declaration order (the
 * same ordered-milestone convention core/successEvaluator.ts's ordered-milestone gate
 * already enforces, and the same "first unresolved group" computeMilestoneRollup's own
 * activeSubGoal already represents as a single field). Returns every member of that one
 * group (not just its first member) so an alternative (`group`-sharing) milestone is
 * correctly recognised as achieved however it ends up being satisfied -- see
 * BranchRecord.targetMilestoneCriterionIds / hasBranchAchievedTargetMilestone
 * (core/branchExploration.ts).
 */
export function computeTargetMilestoneCriterionIds(
  criteria: readonly SuccessCriterion[],
  missingRequiredCriteriaIds: readonly string[],
): string[] {
  const firstMissingId = missingRequiredCriteriaIds[0];
  if (firstMissingId === undefined) {
    return [];
  }
  const first = criteria.find((c) => c.id === firstMissingId);
  const groupKey = first?.group;
  if (!groupKey) {
    return [firstMissingId];
  }
  return criteria.filter((c) => c.group === groupKey).map((c) => c.id);
}

/**
 * Selects the nearest useful recovery anchor: the anchor for the *highest-order* satisfied
 * milestone that is still strictly before the lowest-order currently-unresolved required
 * milestone -- i.e. "the decision point that produced the most recent proven progress",
 * never merely "the first anchor recorded this run". `excludeFingerprints` lets a caller
 * fall back to progressively older anchors once a nearer one's own bounded exploration
 * budget is exhausted or it cannot be safely restored (see core/loop.ts) -- descending
 * usefulness order, never an automatic jump straight to the very first anchor (the
 * homepage) while a closer one remains untried.
 */
export function selectRecoveryAnchor(params: {
  anchors: readonly RecoveryAnchor[];
  excludeFingerprints?: ReadonlySet<string>;
}): RecoveryAnchor | undefined {
  const { anchors, excludeFingerprints } = params;
  const eligible = excludeFingerprints
    ? anchors.filter((a) => !excludeFingerprints.has(a.decisionPointFingerprint))
    : anchors;
  if (eligible.length === 0) {
    return undefined;
  }
  return eligible.reduce((best, candidate) =>
    candidate.milestoneOrder > best.milestoneOrder || (candidate.milestoneOrder === best.milestoneOrder && candidate.sequence > best.sequence)
      ? candidate
      : best,
  );
}
