/**
 * Milestone-anchored recovery (corrective architecture, see CLAUDE.md and
 * docs/architecture.md "Milestone-anchored recovery"): shared shapes between src/core
 * (which owns RunState.recoveryAnchors / the actual restore sequence) and the diagnostics
 * surfaced on TaskResponse. Kept in src/types, alongside branch.ts/routeMemory.ts, for the
 * same layering reason those files document -- src/core and src/reasoning both need these
 * shapes without depending on each other's implementation module.
 *
 * Engine-internal state (RecoveryAnchor) is never itself part of either wire schema; only
 * the bounded diagnostic summaries below (RecoveryAttemptDiagnostic,
 * AlternativeCandidateAttemptDiagnostic, ConsentSurfaceDiagnostic) are additive fields on
 * TaskResponse.diagnostics.
 */

import type { RouteMemoryOutcome } from "./routeMemory.js";
import type { ConsentControlIntent } from "./consentControl.js";

/**
 * Recorded the moment a required success criterion first becomes satisfied (see
 * core/loop.ts, alongside the existing MilestoneEvidenceRecord write), so recovery can
 * later be told "go back to the decision point that produced the highest milestone still
 * proven" instead of walking browser history blindly. `milestoneOrder` is the criterion's
 * declaration order in successCriteria (the same order computeMilestoneRollup already
 * treats as milestone order) -- not a separate, caller-supplied field.
 */
export interface RecoveryAnchor {
  criterionId: string;
  milestoneOrder: number;
  stepIndex: number;
  pageUrl: string;
  pageTitle: string;
  /** computeDecisionPointFingerprint(observation) at the moment this milestone was satisfied -- core/routeMemory.ts. */
  decisionPointFingerprint: string;
  /** Route-memory candidate ids (computeCandidateIdentity) visible at this anchor, for guaranteed-inclusion prompt context. */
  candidateIdentitiesAtAnchor: string[];
  evidenceTier: "observed" | "inferred" | "assumed";
  /** Monotonically increasing per-run sequence number, for stable ordering when several anchors share a stepIndex. */
  sequence: number;
}

/**
 * One bounded diagnostic record per anchor-restore attempt (TaskResponse.diagnostics.recovery.attempts) --
 * see docs/architecture.md "Milestone-anchored recovery". Reported whether the restore
 * succeeded or not, so a caller can audit every recovery-anchor choice, not just the
 * successful ones.
 */
export interface RecoveryAttemptDiagnostic {
  stepIndex: number;
  anchorCriterionId: string;
  anchorMilestoneOrder: number;
  /** Fingerprint the restore sequence was aiming to reach. */
  targetFingerprint: string;
  hopsAttempted: number;
  hopsBudget: number;
  /** True once the target fingerprint was actually re-observed and matched. */
  restored: boolean;
  /** Why this attempt ended without being restored, when restored is false. */
  failureReason?: "hops_exhausted" | "go_back_failed" | "no_further_anchor" | "safety_limit";
}

/**
 * One bounded diagnostic record per distinct alternative candidate tried at a recovery
 * anchor's decision point (TaskResponse.diagnostics.alternativeExploration.candidates) --
 * see docs/architecture.md "Alternative route exploration". `progressResult` mirrors
 * RouteMemoryOutcome (the same generic advanced/no_change/failed/blocked vocabulary
 * core/routeMemory.ts already uses), never a separate judgement.
 */
export interface AlternativeCandidateAttemptDiagnostic {
  anchorFingerprint: string;
  anchorCriterionId: string;
  candidateId: string;
  candidateLabel: string;
  stepIndex: number;
  progressResult: RouteMemoryOutcome;
  /** 1-based position of this attempt within this anchor's bounded exploration budget. */
  attemptNumber: number;
  budget: number;
}

/**
 * One bounded diagnostic record per genuine consent surface the engine detected via its
 * own independent, deterministic DOM classification (src/observation/consentSurface.ts) --
 * never solely the model's self-reported ConsentControlIntent. See docs/architecture.md
 * "Consent behaviour".
 */
export interface ConsentSurfaceDiagnostic {
  stepIndex: number;
  pageUrl: string;
  surfaceDetected: boolean;
  /** Short, generic evidence strings explaining the classification (text/role/grouping signals), never full page content. */
  evidence: string[];
  acceptAllCandidateFound: boolean;
  /** Present only when the engine itself dispatched a proactive accept-all click (accept_optional policy). */
  engineActionTaken?: "clicked_accept_all";
  engineActionVerified?: boolean;
  /** The model's own self-reported intent for this same control, when available, for comparison against the deterministic classification. */
  modelReportedIntent?: ConsentControlIntent;
}

/**
 * TaskResponse.diagnostics.recovery -- see docs/architecture.md "Milestone-anchored
 * recovery". Present only when at least one recovery-anchor restore was attempted this run.
 */
export interface RecoveryDiagnostics {
  version: "1.0.0";
  anchorsRecorded: number;
  attempts: RecoveryAttemptDiagnostic[];
}

/**
 * TaskResponse.diagnostics.alternativeExploration -- see docs/architecture.md "Alternative
 * route exploration". Present only when at least one bounded alternative-candidate
 * exploration cycle ran this run.
 */
export interface AlternativeExplorationDiagnostics {
  version: "1.0.0";
  candidates: AlternativeCandidateAttemptDiagnostic[];
}

/**
 * TaskResponse.diagnostics.consent -- see docs/architecture.md "Consent behaviour". Present
 * only when at least one consent surface was evaluated (detected or not) this run.
 */
export interface ConsentDiagnostics {
  version: "1.0.0";
  surfaces: ConsentSurfaceDiagnostic[];
  /** How many of this run's bounded consent-retry allowance were used -- see MAX_CONSENT_RETRIES, core/loop.ts. Never drawn from the navigation alternative-exploration budget. */
  consentRetriesUsed: number;
}
