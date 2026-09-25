import { objectiveRelevanceScore, tokenize } from "../../discovery/relevance.js";
import { classifyTier, TIER_CONFIDENCE_MULTIPLIER } from "./tiering.js";
import { abstractSegmentForCrossDomain, isCrossDomainTier } from "./abstraction.js";
import type {
  JourneyMemorySegment,
  JourneyMemoryTier,
  ScoredJourneyMemoryCandidate,
} from "../../types/journeyMemory.js";

/**
 * Matching thresholds (binding contract §3): unvalidated/env-configurable, mirroring
 * src/core/surfaceRelevance.ts's own labelling convention for its own (different) initial
 * calibration constants -- these are a deliberately separate, independent set of numbers,
 * never reused literally from that module.
 *
 * Issue 2 (Tier3/4 cross-domain behaviour): these thresholds are applied to the *raw*,
 * pre-tier-multiplier weighted score (semantic/structural compatibility), never to the
 * already-tier-discounted final score -- so a Tier3/4 candidate is judged by how strongly
 * it structurally resembles the current situation, not automatically rejected/stuck at
 * "ambiguous" purely because its own tier multiplier is small. Tier3/4 use a strictly
 * higher accept bar and a strictly higher reject bar than Tier1/2 (JOURNEY_MEMORY_
 * CROSS_DOMAIN_ACCEPT_THRESHOLD > JOURNEY_MEMORY_ACCEPT_THRESHOLD), so only genuinely
 * strong structural alignment can ever cross a domain boundary at all -- and even then, its
 * *confidence* (the final, tier-multiplied score) is still bounded well below what an
 * equivalent Tier1/2 candidate would carry (TIER_CONFIDENCE_MULTIPLIER), preserving the
 * required Tier1 > Tier2 > Tier3 > Tier4 monotonic confidence ordering independently of the
 * accept/reject decision itself.
 */
export const JOURNEY_MEMORY_ACCEPT_THRESHOLD = 0.55;
export const JOURNEY_MEMORY_REJECT_THRESHOLD = 0.2;
export const JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD = 0.75;
export const JOURNEY_MEMORY_CROSS_DOMAIN_REJECT_THRESHOLD = 0.4;

function acceptThresholdFor(tier: JourneyMemoryTier): number {
  return isCrossDomainTier(tier) ? JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD : JOURNEY_MEMORY_ACCEPT_THRESHOLD;
}

function rejectThresholdFor(tier: JourneyMemoryTier): number {
  return isCrossDomainTier(tier) ? JOURNEY_MEMORY_CROSS_DOMAIN_REJECT_THRESHOLD : JOURNEY_MEMORY_REJECT_THRESHOLD;
}

export interface JourneyMemoryScoringInput {
  objectiveText: string;
  milestoneIntent: string;
  journeyType?: string;
  currentSemanticSignature: string;
  currentDomain: string;
  currentMarket?: string;
}

function overlapRatio(a: string, b: string): number {
  const tokensA = new Set(tokenize(a));
  const tokensB = new Set(tokenize(b));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits += 1;
  return hits / Math.max(tokensA.size, tokensB.size);
}

/**
 * Combines multiple weighted, deterministic signals (never a single word-overlap score
 * alone -- binding contract §3): objective meaning, milestone intent, journey type,
 * semantic page identity, action meaning, source-page identity, historical
 * success/failure, recency, and the segment's own confidence -- so wording differences
 * ("Configure & Price" vs "Build your car") can still score as equivalent when other
 * structural signals align. Deterministic heuristics only, the same pattern
 * surfaceRelevance.ts already uses -- no ML model.
 */
export function scoreJourneyMemoryCandidate(
  segment: JourneyMemorySegment,
  input: JourneyMemoryScoringInput,
): ScoredJourneyMemoryCandidate {
  const sourceDomain = segment.provenance.registrableDomain;
  const sourceMarket = segment.provenance.market;
  const tier = classifyTier({
    candidateDomain: sourceDomain,
    currentDomain: input.currentDomain,
    candidateMarket: sourceMarket,
    currentMarket: input.currentMarket,
  });

  // Issue 2: the domain hard boundary is enforced right here, at the content-field level,
  // before any literal field of an out-of-domain segment is ever read for scoring or output
  // -- never as a blanket retrieval-time reject of the tier itself (see abstraction.ts).
  // `segment` from this point on is what both scoring AND the returned candidate use, so a
  // Tier2+ candidate's raw URL/CTA text/element id/product name can never reach
  // promptSummary.ts/the reasoning prompt, while its abstracted structural signal still can.
  const usableSegment = isCrossDomainTier(tier) ? abstractSegmentForCrossDomain(segment) : segment;

  const milestoneIntentText =
    usableSegment.kind === "forward" ? usableSegment.verifiedMilestoneIntent : usableSegment.lastVerifiedMilestoneIntent ?? "";
  const actionLabel = usableSegment.kind === "forward" ? usableSegment.action.semanticLabel : usableSegment.failedCandidate.semanticLabel;
  const sourceSemanticSignature = usableSegment.sourcePage.semanticSignature;

  const objectiveScore = objectiveRelevanceScore(input.objectiveText, milestoneIntentText || actionLabel);
  const milestoneScore = overlapRatio(input.milestoneIntent, milestoneIntentText);
  const journeyTypeScore = input.journeyType ? overlapRatio(input.journeyType, actionLabel + " " + milestoneIntentText) : 0;
  const pageIdentityScore = overlapRatio(input.currentSemanticSignature, sourceSemanticSignature);
  const actionMeaningScore = overlapRatio(input.objectiveText, actionLabel);

  const outcomeScore =
    segment.kind === "forward"
      ? segment.outcome === "success"
        ? 1
        : segment.outcome === "partial"
          ? 0.5
          : 0.1
      : segment.finalRecoveryOutcome === "recovered"
        ? 0.7
        : 0.2;

  const ageMs = Date.now() - new Date(segment.timestamp).getTime();
  const ageDays = Math.max(0, ageMs / (24 * 60 * 60 * 1000));
  // Halves roughly every 45 days -- deliberately gentle, unvalidated decay, distinct from
  // the multi-failure confidence decay applied at write time (retention.ts).
  const recencyScore = Math.exp(-ageDays / 45);

  const confidenceScore = Math.max(0, Math.min(1, segment.confidence));

  const componentScores: Record<string, number> = {
    objective: objectiveScore,
    milestoneIntent: milestoneScore,
    journeyType: journeyTypeScore,
    pageIdentity: pageIdentityScore,
    actionMeaning: actionMeaningScore,
    outcome: outcomeScore,
    recency: recencyScore,
    confidence: confidenceScore,
  };

  const weights: Record<string, number> = {
    objective: 0.2,
    milestoneIntent: 0.18,
    journeyType: 0.07,
    pageIdentity: 0.2,
    actionMeaning: 0.15,
    outcome: 0.1,
    recency: 0.05,
    confidence: 0.05,
  };

  let rawScore = 0;
  for (const key of Object.keys(weights)) {
    rawScore += (componentScores[key] ?? 0) * (weights[key] ?? 0);
  }
  const tierMultiplier = TIER_CONFIDENCE_MULTIPLIER[tier];
  const score = rawScore * tierMultiplier;

  // Issue 2: accept/reject is decided on rawScore (semantic/structural compatibility)
  // against a tier-appropriate bar -- Tier3/4 require a strictly higher rawScore than
  // Tier1/2 before being accepted at all (JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD >
  // JOURNEY_MEMORY_ACCEPT_THRESHOLD) -- while `score` (rawScore * tierMultiplier) remains
  // what callers use as the candidate's confidence, so Tier1 > Tier2 > Tier3 > Tier4 holds
  // for any two candidates sharing the same underlying rawScore.
  const acceptThreshold = acceptThresholdFor(tier);
  const rejectThreshold = rejectThresholdFor(tier);
  const decision: ScoredJourneyMemoryCandidate["decision"] =
    rawScore >= acceptThreshold ? "accept" : rawScore <= rejectThreshold ? "reject" : "ambiguous";

  const reason =
    decision === "accept"
      ? `Structural/semantic alignment (${tier}) cleared the accept threshold (${rawScore.toFixed(2)} >= ${acceptThreshold}, confidence ${score.toFixed(2)}).`
      : decision === "reject"
        ? `Alignment (${tier}) fell at or below the reject threshold (${rawScore.toFixed(2)} <= ${rejectThreshold}).`
        : `Ambiguous alignment (${tier}, raw ${rawScore.toFixed(2)}) -- deferred to reasoning as a lower-confidence candidate, never auto-accepted or auto-rejected.`;

  return { segment: usableSegment, score, tier, decision, componentScores, reason };
}

export function rankJourneyMemoryCandidates(
  segments: JourneyMemorySegment[],
  input: JourneyMemoryScoringInput,
): ScoredJourneyMemoryCandidate[] {
  return segments
    .map((segment) => scoreJourneyMemoryCandidate(segment, input))
    .sort((a, b) => b.score - a.score);
}
