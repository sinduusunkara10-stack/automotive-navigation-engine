import { objectiveRelevanceScore, tokenize } from "../../discovery/relevance.js";
import { classifyTier, TIER_CONFIDENCE_MULTIPLIER } from "./tiering.js";
import type {
  JourneyMemorySegment,
  ScoredJourneyMemoryCandidate,
} from "../../types/journeyMemory.js";

/**
 * Matching thresholds (binding contract §3): unvalidated/env-configurable, mirroring
 * src/core/surfaceRelevance.ts's own labelling convention for its own (different) initial
 * calibration constants -- these are a deliberately separate, independent set of numbers,
 * never reused literally from that module.
 */
export const JOURNEY_MEMORY_ACCEPT_THRESHOLD = 0.55;
export const JOURNEY_MEMORY_REJECT_THRESHOLD = 0.2;

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

  const milestoneIntentText = segment.kind === "forward" ? segment.verifiedMilestoneIntent : segment.lastVerifiedMilestoneIntent ?? "";
  const actionLabel = segment.kind === "forward" ? segment.action.semanticLabel : segment.failedCandidate.semanticLabel;
  const sourceSemanticSignature = segment.sourcePage.semanticSignature;

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

  const decision: ScoredJourneyMemoryCandidate["decision"] =
    score >= JOURNEY_MEMORY_ACCEPT_THRESHOLD ? "accept" : score <= JOURNEY_MEMORY_REJECT_THRESHOLD ? "reject" : "ambiguous";

  const reason =
    decision === "accept"
      ? `Structural/semantic alignment (${tier}) cleared the accept threshold (${score.toFixed(2)} >= ${JOURNEY_MEMORY_ACCEPT_THRESHOLD}).`
      : decision === "reject"
        ? `Alignment (${tier}) fell at or below the reject threshold (${score.toFixed(2)} <= ${JOURNEY_MEMORY_REJECT_THRESHOLD}).`
        : `Ambiguous alignment (${tier}, ${score.toFixed(2)}) -- deferred to reasoning as a lower-confidence candidate, never auto-accepted or auto-rejected.`;

  return { segment, score, tier, decision, componentScores, reason };
}

export function rankJourneyMemoryCandidates(
  segments: JourneyMemorySegment[],
  input: JourneyMemoryScoringInput,
): ScoredJourneyMemoryCandidate[] {
  return segments
    .map((segment) => scoreJourneyMemoryCandidate(segment, input))
    .sort((a, b) => b.score - a.score);
}
