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
 * Explicit candidate-route lifecycle states (corrective pass, see CLAUDE.md and
 * docs/architecture.md "Alternative route exploration -- complete route following"). A
 * candidate route is genuinely *followed*, not merely clicked once: these states are
 * reported at every transition a route attempt goes through, reusing the exact same
 * multi-step, fingerprint-verified tracking Goal-Directed Bounded Branch Exploration
 * (core/branchExploration.ts) already implements for its own (unrelated, ambiguity-
 * triggered) entry path -- see BranchRecord.entryReason.
 *
 * - "candidate_selected": a fresh, non-exhausted candidate was chosen at the recovery
 *   anchor's own decision point, about to be dispatched.
 * - "route_active": the candidate's own action was dispatched and the route is now being
 *   followed downstream (bounded by the branch's own depth budget).
 * - "route_progressing": at least one further in-route action produced generic,
 *   evidence-backed progress (a milestone/success criterion newly satisfied, or the route's
 *   own accumulated evidence otherwise judged non-dead-end) without yet reaching the
 *   targeted milestone.
 * - "route_succeeded": the specific milestone this route was pursuing became satisfied
 *   within the route -- the route is never reset back to its recovery anchor after this,
 *   even if it later continues (toward a further milestone) and that continuation itself
 *   eventually winds down.
 * - "route_blocked": the route reached a verified dead end (a revisited decision point,
 *   repeated no-progress actions, a safety rejection, or its own depth budget exhausted
 *   with no progress at all) -- distinct from "candidate_exhausted", which is the
 *   *consequence* recorded once the engine has verified restoration back at the anchor.
 * - "anchor_restore_required": the route closed unproductively and a bounded,
 *   fingerprint-verified return toward the recovery anchor is in progress.
 * - "anchor_restored": the return completed and was verified (fingerprint match confirmed)
 *   -- or was never needed at all, because the route had already achieved its targeted
 *   milestone before winding down.
 * - "candidate_exhausted": recorded once restoration is verified after a "route_blocked"
 *   closure -- this candidate will not be re-offered at this decision point.
 */
export type RouteStatus =
  | "candidate_selected"
  | "route_active"
  | "route_progressing"
  | "route_succeeded"
  | "route_blocked"
  | "anchor_restore_required"
  | "anchor_restored"
  | "candidate_exhausted";

/**
 * One record per route-lifecycle transition (TaskResponse.diagnostics.recovery.routeAttempts)
 * -- see RouteStatus above. Unlike AlternativeCandidateAttemptDiagnostic (one summary entry
 * per candidate), this is the full transition-by-transition trace proving the engine
 * genuinely followed and evaluated a multi-step route rather than only dispatching a click
 * and checking for immediate progress.
 */
export interface RouteAttemptDiagnostic {
  anchorFingerprint: string;
  anchorCriterionId: string;
  candidateId: string;
  candidateLabel: string;
  /** 1-based rank among the candidates tried at this anchor (1 = first tried, up to the bounded budget). */
  candidateRank: number;
  routeStartStepIndex: number;
  routeStartUrl: string;
  stepIndex: number;
  status: RouteStatus;
  /** Distinct URLs observed since the route started, in order, deduplicated. */
  urlsVisited: string[];
  /** ActionResult.surfaceChangeType values observed since the route started (dialog_appeared, layer_panel_appeared, etc.). */
  surfacesOpened: string[];
  /** state.satisfiedCriteriaIds snapshot immediately before this route started. */
  milestoneStateBefore: string[];
  /** state.satisfiedCriteriaIds snapshot as of this transition. */
  milestoneStateAtTransition: string[];
  /** Short, generic explanation of what evidence produced this transition -- never a raw page-content dump. */
  progressEvidence?: string;
  /** How many proactive consent interruptions (accept_optional) this route has absorbed so far, without being reset. */
  consentInterruptionsHandled: number;
  /** Present on a terminal transition (route_succeeded, candidate_exhausted). */
  terminationReason?: string;
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
  /**
   * Multilingual consent handling (corrective pass, see CLAUDE.md "Consent behaviour --
   * unsupported/ambiguous languages"): true when the accept-all control was identified via
   * the bounded, independently-verified model-assist fallback (consentClassifier.ts's
   * resolveAmbiguousConsentSurface) rather than the deterministic, configured-language
   * wording table -- i.e. the page's own wording matched none of the configured languages.
   * Absent (never false) for the ordinary, deterministic case.
   */
  resolvedViaModelAssist?: boolean;
  /**
   * True when this surface showed genuine consent-context evidence but the deterministic,
   * configured-language wording table could not resolve a confident accept/decline-or-
   * settings choice shape from it -- see ConsentSurfaceAssessment.languageAmbiguous
   * (consentClassifier.ts). Absent (never false) when a language was resolved (or no
   * evidence existed at all).
   */
  languageAmbiguous?: boolean;
  /** Observation.pageLanguage at this step, when the page declared one -- see that field's own doc comment. */
  pageLanguage?: string;
}

/**
 * TaskResponse.diagnostics.recovery -- see docs/architecture.md "Milestone-anchored
 * recovery". Present only when at least one recovery-anchor restore was attempted this run.
 */
export interface RecoveryDiagnostics {
  version: "1.1.0";
  anchorsRecorded: number;
  attempts: RecoveryAttemptDiagnostic[];
  /** Full route-lifecycle transition trace -- see RouteAttemptDiagnostic above. */
  routeAttempts: RouteAttemptDiagnostic[];
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

/**
 * One bounded diagnostic record per surface-adoption lifecycle event
 * (TaskResponse.diagnostics.surfaceAdoption.attempts) -- see docs/architecture.md "Surface
 * adoption" and "Return-to-parent recovery". `event` is deliberately a flat, bounded
 * vocabulary (never a free-form per-step log) so this array grows at most once per
 * adoption/return/closure, not once per step:
 * - "adopted": a popup/new-tab was adopted onto the surface stack (mirrors the
 *   ActionResult.surfaceAdopted=true case already reported in captures.errors).
 * - "rejected": a popup was offered but not adopted (domain/budget/relevance) -- mirrors
 *   ActionResult.adoptionRejectedReason.
 * - "returned": returnToParentSurface (core/surfaceReturn.ts) successfully popped back to
 *   the parent Page.
 * - "return_failed": a return-to-parent attempt could not verify the parent surface.
 * - "closed_unexpectedly": the adopted surface's own Page was found closed
 *   (page.isClosed()) before any go_back-driven return was attempted.
 */
export interface SurfaceAdoptionAttemptDiagnostic {
  stepIndex: number;
  surfaceId: string;
  event: "adopted" | "rejected" | "returned" | "return_failed" | "closed_unexpectedly";
  /** Set on "adopted"/"returned"/"return_failed" when the relevant page's URL was available. */
  pageUrl?: string;
  /** Set on "rejected"/"return_failed" -- see ActionResult.adoptionRejectedReason and ReturnToParentResult.reason. */
  reason?: "domain_rejected" | "budget_exhausted" | "relevance_rejected" | "parent_closed" | "parent_navigation_unverified";
  /** Mirrors ActionResult.relevanceScore -- see its own doc comment. Set on "adopted"/"rejected" whenever the relevance gate ran for this attempt. */
  relevanceScore?: number;
  /** Mirrors ActionResult.relevanceTier -- see its own doc comment. */
  relevanceTier?: "adopt" | "reject" | "ambiguous";
  /** Mirrors ActionResult.consentActionTaken -- see its own doc comment. */
  consentActionTaken?: boolean;
  /** Mirrors ActionResult.extendedAllowedDomain -- see its own doc comment. Set only on "adopted". */
  extendedAllowedDomain?: string;
}

/**
 * TaskResponse.diagnostics.surfaceAdoption -- see docs/architecture.md "Surface adoption"
 * and "Return-to-parent recovery". Present only when at least one adopted-surface lifecycle
 * event (adoption, rejection, return, or unexpected closure) occurred this run.
 */
export interface SurfaceAdoptionDiagnostics {
  version: "1.0.0";
  attempts: SurfaceAdoptionAttemptDiagnostic[];
  /** How many return-to-parent hops (go_back-while-off-main) this run made, successful or not. */
  returnAttempts: number;
}
