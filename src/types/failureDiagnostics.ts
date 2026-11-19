import type {
  AlternativeCandidateAttemptDiagnostic,
  RecoveryAttemptDiagnostic,
  RouteAttemptDiagnostic,
  SurfaceAdoptionAttemptDiagnostic,
} from "./recovery.js";
import type { MilestoneEvidenceRecord, ReasoningProviderDecisionOutcome } from "./task-response.js";
import type { JourneyMemoryRecoveryCallDiagnostic } from "./journeyMemory.js";

/**
 * Diagnostics-only failure evidence for a run that threw before producing a TaskResponse.
 * Never part of the governed response schema: it travels only on the task-status endpoint's
 * failed-run `errorDetails` (src/api/server.ts), the same unversioned wrapper convention as
 * staleReason. Text/metadata only -- no screenshots, DOM, traces or network bodies.
 */

export type PageLifecycleEventKind =
  | "page_created"
  | "page_closed"
  | "page_crashed"
  | "context_closed"
  | "browser_disconnected"
  | "surface_entered"
  | "surface_left";

export type PageClosedBy = "engine" | "external";

export interface PageLifecycleEvent {
  at: string;
  kind: PageLifecycleEventKind;
  /** Stable per-run id ("page-1" is the run's originally tracked page). */
  pageId?: string;
  url?: string;
  /** page_created only: the Page that opened it, when Playwright reports one (a popup/new tab). */
  openerPageId?: string;
  /** page_closed/page_crashed/context_closed/browser_disconnected only. */
  closedBy?: PageClosedBy;
  /** page_closed with closedBy "engine": which engine code path closed it. */
  closeReason?: string;
  /** surface_entered/surface_left only. */
  surfaceId?: string;
}

export interface OpenPageSummary {
  id: string;
  url: string;
}

export interface PageStateSnapshot {
  at: string;
  activeSurface: string;
  activePageId: string;
  activePageUrl: string;
  activePageClosed: boolean;
  openPages: OpenPageSummary[];
}

/**
 * Who selected a dispatched go_back. "journey_replanning": the reasoning layer itself chose
 * stop_blocked and the engine substituted go_back. "stop_blocked_substitution": the reasoning
 * layer chose something else, the safety layer rejected it (turning it into stop_blocked), and
 * the engine then substituted go_back. Whether the go_back left an adopted surface or moved
 * browser history is recorded separately as `dispatchedAs`.
 */
export type GoBackSource =
  | "reasoning_decision"
  | "journey_replanning"
  | "stop_blocked_substitution"
  | "anchor_hop"
  | "branch_closure"
  | "branch_return_hop"
  | "other_recovery";

export interface GoBackTrace {
  source: GoBackSource;
  dispatchedAs: "surface_return" | "browser_history";
  /** The reasoning layer's own action type when the engine substituted go_back for it. */
  substitutedFor?: string;
  decisionFallbackReason?: string;
  safetyFlags?: string[];
}

export interface DecisionJourneyMemoryTrace {
  stepIndex: number;
  guidanceOffered: boolean;
  recoveryCallFired: boolean;
  recoveryDecisionUsed: boolean;
}

export interface ActionTraceRecord {
  stepIndex: number;
  actionType: string;
  targetElementId?: string;
  goBack?: GoBackTrace;
  journeyMemory?: DecisionJourneyMemoryTrace;
  before: PageStateSnapshot;
  after?: PageStateSnapshot & {
    /** The Page the rest of this step's own code keeps using after dispatch. */
    stepPageId: string;
    stepPageClosed: boolean;
    success: boolean;
    resultingUrl?: string;
    error?: string;
  };
}

export interface LastAttemptedAction {
  stepIndex: number;
  actionType: string;
  targetElementId?: string;
  goBackSource?: GoBackSource;
}

export interface FailureStepSummary {
  stepIndex: number;
  at: string;
  urlBefore: string;
  urlAfter?: string;
  actionType: string;
  targetElementId?: string;
  rationale: string;
  success: boolean;
  error?: string;
  interactionOutcome?: string;
  surfaceAdopted?: boolean;
  safetyFlags?: string[];
}

export interface FailureReasoningDecisionSummary {
  stepIndex?: number;
  attempt: number;
  outcome: ReasoningProviderDecisionOutcome;
  confidence?: number;
  latencyMs: number;
}

export interface FailurePartialDiagnostics {
  steps: FailureStepSummary[];
  surfaceAdoption: { attempts: SurfaceAdoptionAttemptDiagnostic[]; returnAttempts: number };
  recovery: { attempts: RecoveryAttemptDiagnostic[]; routeAttempts: RouteAttemptDiagnostic[] };
  alternativeExploration: { candidates: AlternativeCandidateAttemptDiagnostic[] };
  reasoningDecisions: FailureReasoningDecisionSummary[];
  milestoneEvidence: MilestoneEvidenceRecord[];
  journeyMemory: {
    guidanceUsed: boolean;
    influencedDecisions: { recordId: string; tier: string; confidence: number; usedAt: string }[];
    fallbackExplorationUsed: boolean;
    recoveryCall?: JourneyMemoryRecoveryCallDiagnostic;
  };
}

export interface EngineFailureContext {
  stepCount: number;
  /** URL of the surface that was active at failure time (state.activePage, else the original page). */
  currentUrl?: string;
  /** URL of the run's originally tracked page, which stays put while an adopted surface is active. */
  mainPageUrl?: string;
  activeSurface?: string;
  activePageId?: string;
  activePageClosed?: boolean;
  lastAttemptedAction?: LastAttemptedAction;
  missingRequiredCriteriaIds?: string[];
  partialDiagnostics?: FailurePartialDiagnostics;
  pageLifecycle?: PageLifecycleEvent[];
  actionTrace?: ActionTraceRecord[];
}
