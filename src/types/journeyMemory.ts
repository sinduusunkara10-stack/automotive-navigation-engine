/**
 * Persistent Cross-Run Journey Memory: internal types only (never part of either wire
 * schema's request shape -- see schemas/task-response.schema.json's additive
 * diagnostics.journeyMemory block for the response-facing summary of this system's
 * behaviour). Nothing here is automotive/brand/GA4-specific -- see CLAUDE.md's
 * non-negotiable design rule. This is a separate, complementary layer to the existing
 * single-run, in-process core/routeMemory.ts/core/branchExploration.ts (RunState-scoped,
 * discarded at end of run); this layer instead persists sanitized, fine-grained segments
 * to Redis so a later, unrelated run can benefit from an earlier run's verified evidence.
 */

/** Tier1: same registrable domain, same market. Tier2: same domain, different market (structural only). Tier3: different domain, same market (generic stage concepts only). Tier4: different domain, different market (abstract guidance, last resort). */
export type JourneyMemoryTier = "tier1" | "tier2" | "tier3" | "tier4";

export type JourneyMemorySegmentKind = "forward" | "recovery";

export type JourneyMemoryOutcome = "success" | "failure" | "partial";

/** Sanitized page identity -- never a raw URL, never raw text beyond bounded normalized fields. See sanitizer.ts. */
export interface SanitizedPageIdentity {
  registrableDomain: string;
  /** Normalized path only -- no query string, no fragment. See sanitizer.ts. */
  normalizedPath: string;
  /** Compact, bounded semantic signature (title/heading tokens), never raw page text. */
  semanticSignature: string;
  /** Values extracted via the explicit allowlist mechanism only (sanitizer.ts) -- e.g. a step indicator. Never a raw passthrough of any query/fragment value. */
  extractedFields?: Record<string, string>;
}

export interface SanitizedActionIdentity {
  actionType: string;
  /** role::accessibleName-shaped, bounded semantic label -- never a raw element id. */
  semanticLabel: string;
}

export interface ForwardMemorySegment {
  kind: "forward";
  id: string;
  schemaVersion: string;
  sourcePage: SanitizedPageIdentity;
  action: SanitizedActionIdentity;
  destinationPage: SanitizedPageIdentity;
  verifiedMilestoneIntent: string;
  outcome: JourneyMemoryOutcome;
  confidence: number;
  evidenceTier: JourneyMemoryTier;
  routePosition: number;
  timestamp: string;
  provenance: {
    runId: string;
    registrableDomain: string;
    market?: string;
  };
}

export interface RecoveryMemorySegment {
  kind: "recovery";
  id: string;
  schemaVersion: string;
  /**
   * Journey Memory recovery-segment-gap fix (production incident
   * run_b3743f06-1667-443e-b9fa-e804aa5caecf): which diagnostic source (see
   * journeyMemory/segmentBuilder.ts) this segment was built from. Internal to the
   * journey-memory record itself (not part of the task-response wire schema) -- purely for
   * audit/debugging of which restoration path actually produced a given piece of memory.
   */
  segmentSource?: "recovery_attempt" | "route_attempt" | "alternative_candidate";
  failedCandidate: SanitizedActionIdentity;
  sourcePage: SanitizedPageIdentity;
  resultingBranchOutcome: "dead_end" | "blocked" | "unsafe" | "recovered" | "unknown";
  failureType: string;
  restorationResult: "go_back_succeeded" | "go_back_failed" | "direct_nav_restored" | "decision_point_restored" | "reconstruction_succeeded" | "reconstruction_failed" | "not_attempted";
  lastVerifiedMilestoneIntent?: string;
  knownExhaustedCandidate: boolean;
  movedCloserToObjective: boolean;
  finalRecoveryOutcome: "recovered" | "not_recovered";
  failureCount: number;
  confidence: number;
  evidenceTier: JourneyMemoryTier;
  timestamp: string;
  provenance: {
    runId: string;
    registrableDomain: string;
    market?: string;
  };
}

export type JourneyMemorySegment = ForwardMemorySegment | RecoveryMemorySegment;

export interface JourneyMemoryConfidenceChange {
  recordId: string;
  previousConfidence: number;
  newConfidence: number;
  reason: string;
  timestamp: string;
}

/** A scored candidate memory segment, ready either for prompt injection or for internal ranking. */
export interface ScoredJourneyMemoryCandidate {
  segment: JourneyMemorySegment;
  score: number;
  tier: JourneyMemoryTier;
  decision: "accept" | "reject" | "ambiguous";
  componentScores: Record<string, number>;
  reason: string;
}

/** Compact per-run context assembled once, pre-decision, from a bounded Redis lookup + deterministic scoring. Kept on RunState as a distinct field from the existing single-run RouteMemory. */
export interface JourneyMemoryContext {
  enabled: boolean;
  storageAvailable: boolean;
  lookupCompleted: boolean;
  accepted: ScoredJourneyMemoryCandidate[];
  ambiguous: ScoredJourneyMemoryCandidate[];
  rejected: { reason: string; count: number }[];
  candidatesConsidered: number;
  durations: JourneyMemoryLookupDurations;
  unavailableReason?: "disabled" | "storage_unavailable" | "timeout" | "no_match";
}

export interface JourneyMemoryLookupDurations {
  redisMs: number;
  filteringMs: number;
  scoringMs: number;
  tierExpansionMs: number;
  totalMs: number;
}

export interface JourneyMemoryRecoveryCallDiagnostic {
  fired: boolean;
  reason?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  matchedExecutedVerified?: boolean;
}

/** Mirrors schemas/task-response.schema.json's additive diagnostics.journeyMemory $def. Built once at run end from the accumulated JourneyMemoryContext + writeback outcome. */
export interface JourneyMemoryDiagnostics {
  version: "1.2.0";
  enabled: boolean;
  readEnabled: boolean;
  writeEnabled: boolean;
  storageAvailable: boolean;
  lookupCompleted: boolean;
  /** Observability fix (production incident run_b3743f06-1667-443e-b9fa-e804aa5caecf): true whenever a pre-run lookup was actually initiated, regardless of whether it completed. */
  lookupAttempted?: boolean;
  lookupDurations?: JourneyMemoryLookupDurations;
  recoveryLookupDurations?: JourneyMemoryLookupDurations;
  candidatesConsidered: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  rejectionReasons: { reason: string; count: number }[];
  guidanceUsed: boolean;
  guidanceSucceeded?: boolean;
  influencedDecisions: { recordId: string; tier: JourneyMemoryTier; confidence: number; usedAt: "pre_run" | "recovery" }[];
  recoveryStartedFromVerifiedMilestone?: boolean;
  reconstructionSucceeded?: boolean;
  fallbackExplorationUsed: boolean;
  extraClaudeCall?: JourneyMemoryRecoveryCallDiagnostic;
  historicalContextRecordCount: number;
  historicalContextTokenEstimate: number;
  /** Observability fix: forward segments built this run, before write-back (whether or not they were actually persisted). */
  forwardSegmentsBuilt?: number;
  /** Journey Memory recovery-segment-gap fix: recovery segments built from all three diagnostic sources, after cross-source dedup, before write-back. */
  recoverySegmentsBuilt?: number;
  /**
   * Recovery-segment eligibility visibility fix (production incident
   * run_fae0519a-ef71-46b9-a053-4ca82bb30000): candidate recovery inputs actually considered
   * from the three diagnostic sources, before eligibility filtering/dedup -- lets a caller
   * distinguish "genuinely nothing to build from" from "candidates existed but were rejected".
   */
  recoveryCandidatesBuilt?: number;
  /** Same fix: how many of those candidates were rejected as ineligible (never silently dropped without a reason -- see recoveryRejectionReasons). */
  recoveryCandidatesRejected?: number;
  /** Same fix: short, generic reason categories for rejected candidates, with counts -- never raw page content. */
  recoveryRejectionReasons?: { reason: string; count: number }[];
  /** Observability fix: count of segments a write was actually attempted for (writeEnabled + storage available + >=1 eligible segment). */
  segmentsWriteAttempted?: number;
  segmentsWritten: number;
  /** Observability fix: a short, non-sensitive category naming why a write did not fully succeed -- never a raw Redis error/credential. */
  writeFailureReason?: string;
  confidenceChanges: JourneyMemoryConfidenceChange[];
  unavailableReason?: "disabled" | "storage_unavailable" | "timeout" | "no_match";
  /** Observability fix: always true when this object itself is present on the response. */
  diagnosticsAttached: boolean;
  /** Observability fix: present only when the engine could safely confirm (not merely attempt) that written records are retrievable. */
  persistenceConfirmed?: boolean;
}

/** Compact summary injected into an existing buildReasoningPrompt call -- see promptSummary.ts. Bounded: at most JOURNEY_MEMORY_MAX_PROMPT_RECORDS records, deduplicated. */
export interface JourneyMemoryPromptSummary {
  records: {
    outcome: JourneyMemoryOutcome;
    confidence: number;
    tier: JourneyMemoryTier;
    reason: string;
    actionLabel: string;
    kind: JourneyMemorySegmentKind;
  }[];
}
