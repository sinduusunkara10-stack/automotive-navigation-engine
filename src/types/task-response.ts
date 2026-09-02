import type { ActionType, SelectedAction } from "./actions.js";

export type RunStatus =
  | "success"
  | "blocked"
  | "failure"
  | "max_steps_reached"
  | "max_backtracks_reached"
  | "max_duration_reached";

export interface InteractiveElement {
  id: string;
  role: string;
  accessibleName: string;
  visible?: boolean;
  destinationUrl?: string;
  disabled?: boolean;
  /**
   * Generic ARIA selection/toggle-state attribute values present on this element (e.g.
   * {"aria-current": "step"}), read verbatim and never normalised into an engine-defined
   * closed set -- see src/observation/observationBuilder.ts.
   */
  ariaState?: Record<string, string>;
}

export interface Observation {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  notableText?: string[];
  /** Generic, brand-agnostic progress-indicator text (e.g. "Step 2 of 4"), when present. */
  progressIndicatorText?: string[];
}

export interface ActionResult {
  success: boolean;
  error?: string;
  resultingUrl?: string;
}

export interface Progress {
  satisfiedCriteriaIds: string[];
  estimatedCompletion: number;
}

export interface StepLog {
  stepIndex: number;
  timestamp: string;
  currentUrl: string;
  observation: Observation;
  decision: string;
  selectedAction: SelectedAction;
  actionResult: ActionResult;
  progress: Progress;
  safetyFlags?: string[];
}

export interface PageVisitCapture {
  stepIndex: number;
  url: string;
  title?: string;
  timestamp: string;
}

export type ErrorCategory =
  | "page_js_error"
  | "console_error"
  | "network_request_failed"
  | "navigation_failure"
  | "action_execution_failure"
  | "action_timeout"
  | "target_element_missing"
  | "safety_guard_stop"
  | "limit_stop";

export type ErrorSeverity = "info" | "warning" | "error" | "critical";

export interface ErrorCapture {
  timestamp: string;
  stepIndex?: number;
  category: ErrorCategory;
  severity: ErrorSeverity;
  pageUrl?: string;
  actionType?: ActionType;
  targetElementId?: string;
  message: string;
  recoverable: boolean;
  stoppedRun: boolean;
}

export interface PageMetadataCapture {
  stepIndex: number;
  url: string;
  timestamp: string;
  title?: string;
  description?: string;
  lang?: string;
}

export interface DataLayerCapture {
  stepIndex: number;
  url: string;
  timestamp: string;
  raw: Record<string, unknown>[];
}

export interface Ga4NetworkEventCapture {
  stepIndex: number;
  requestUrl: string;
  timestamp: string;
  params?: Record<string, string>;
}

export interface ScreenshotCapture {
  stepIndex: number;
  ref: string;
  reason?: string;
  timestamp: string;
}

export interface FinishPageCtaCapture {
  stepIndex: number;
  pageUrl: string;
  timestamp: string;
  text: string;
  url?: string;
  elementType: string;
  accessibleName?: string;
}

/**
 * Generic, mechanical before/after delta of window.dataLayer's contents around one action,
 * never a full re-snapshot -- see src/capture-modules/dataLayerDelta.ts. `available`
 * distinguishes "no dataLayer array exists on this page at all" (false) from "it exists but
 * nothing new was pushed" (true, empty newEntries); `replaced` flags the (rare) case where
 * the array was reset or its earlier contents no longer form a prefix of the new contents
 * (e.g. a full page navigation, or a site explicitly reassigning window.dataLayer), in
 * which case newEntries is the entire post-action array rather than a suffix.
 */
export interface DataLayerDelta {
  available: boolean;
  newEntries: Record<string, unknown>[];
  replaced?: boolean;
}

/**
 * Generic, action-attributed analytics evidence for one click the engine dispatched --
 * the single mechanism required by every journey (configurator, test-drive, dealer
 * locator, ...), never a per-journey capture function. Every field here is either raw,
 * already-captured evidence (dataLayerDelta, ga4RequestsObservedDuringActionWindow,
 * resultingTitle) or a mechanically-derived fact (advancedJourney,
 * newlySatisfiedCriteriaIds) -- never an inference written where raw evidence belongs (see
 * CLAUDE.md "Keep raw, website-derived evidence... strictly separate from... engine-
 * generated classification"). GA4 field naming is deliberately non-causal
 * (`...ObservedDuringActionWindow`, not `...CausedByClick`): a request observed inside the
 * bounded post-click window is temporally correlated with the click, never asserted to have
 * been caused by it -- see docs/n8n-integration.md "Generic action-attributed analytics
 * capture".
 */
export interface ActionAnalytics {
  dataLayerDelta?: DataLayerDelta;
  /** GA4-style requests observed within a short, fixed window after this click -- correlation, not causation. */
  ga4RequestsObservedDuringActionWindow?: Ga4NetworkEventCapture[];
  /** True iff the URL or title changed, or a success criterion newly became satisfied, as a direct result of this click. */
  advancedJourney: boolean;
  /** Ids of success criteria that were unsatisfied before this click and satisfied immediately after it. */
  newlySatisfiedCriteriaIds?: string[];
  /** Any semanticVerifier decisions made while evaluating success criteria immediately after this click. */
  verifierDecisions?: SemanticVerifierDecisionSummary[];
}

export interface CtaClickCapture {
  stepIndex: number;
  timestamp: string;
  sourcePageUrl: string;
  sourcePageTitle?: string;
  ctaText: string;
  accessibleName?: string;
  elementType: string;
  destinationUrl?: string;
  resultingUrl?: string;
  resultingTitle?: string;
  navigationSucceeded: boolean;
  actionSucceeded: boolean;
  error?: string;
  /** Present only when captureModules also requests data_layer_evidence and/or ga4_network_events (see loop.ts). */
  actionAnalytics?: ActionAnalytics;
}

export interface JourneyPathSelectedElement {
  id: string;
  role: string;
  accessibleName: string;
}

export interface JourneyPathEntry {
  stepIndex: number;
  timestamp: string;
  pageUrlBefore: string;
  pageTitle: string;
  selectedAction: SelectedAction;
  selectedElement?: JourneyPathSelectedElement;
  decisionReason: string;
  actionOutcome: ActionResult;
  pageUrlAfter: string;
  progress: Progress;
}

export interface Captures {
  page_visits?: PageVisitCapture[];
  errors?: ErrorCapture[];
  page_metadata?: PageMetadataCapture[];
  data_layer_evidence?: DataLayerCapture[];
  ga4_network_events?: Ga4NetworkEventCapture[];
  screenshots?: ScreenshotCapture[];
  finish_page_ctas?: FinishPageCtaCapture[];
  cta_clicks?: CtaClickCapture[];
  journey_path?: JourneyPathEntry[];
}

export interface EngineAssessment {
  objectiveAchieved: boolean;
  confidence: number;
  summary: string;
  satisfiedSuccessCriteriaIds?: string[];
  notes?: string;
}

export type ReasoningProviderDecisionOutcome = "accepted" | "rejected" | "error" | "fallback";

export interface ReasoningProviderDecisionSummary {
  stepIndex?: number;
  attempt: number;
  outcome: ReasoningProviderDecisionOutcome;
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Versioned separately from TaskResponse.schemaVersion (see REASONING_PROVIDER_DIAGNOSTICS_VERSION
 * in src/reasoning/reasoningProvider.ts) so this sub-structure can evolve on its own. Aggregated
 * from a reasoning provider's own decision log (never a second usage-tracking mechanism) and
 * intentionally limited to safe metadata: no prompts, raw model responses, page content, request
 * bodies, API keys, headers, or credentials. Token counts are reported as-is (not converted to a
 * monetary cost) so cost can be computed downstream against whatever pricing applies later.
 */
export interface ReasoningProviderDiagnostics {
  version: "1.0.0";
  provider: string;
  model?: string;
  callCount: number;
  acceptedDecisionCount: number;
  rejectedDecisionCount: number;
  fallbackDecisionCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  retryCount: number;
  decisions?: ReasoningProviderDecisionSummary[];
}

export type SemanticVerifierDecisionOutcome = "satisfied" | "not_satisfied" | "error" | "cache_hit";

export interface SemanticVerifierDecisionSummary {
  attempt: number;
  outcome: SemanticVerifierDecisionOutcome;
  confidence?: number;
  evidence?: string;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
}

/**
 * Versioned separately from TaskResponse.schemaVersion, same pattern as
 * ReasoningProviderDiagnostics. Aggregated from a SemanticCriterionVerifier's own decision
 * log -- a bounded, structured-output model call used only to adjudicate a
 * semantic_page_match criterion the deterministic (lexical token-overlap) evaluator could
 * not resolve, entirely separate from navigation decisions (see
 * src/reasoning/semanticCriterionVerifier.ts). callCount excludes cacheHitCount: a cached
 * verdict is reused for identical (criterion, page-evidence) pairs so an unchanged page is
 * never re-verified. Contains only safe metadata (confidence, a short evidence excerpt
 * quoted from page signals already visible in Observation, token/latency counts) -- never
 * prompts, raw model responses, page content, request bodies, API keys, headers, or
 * credentials.
 */
export interface SemanticVerifierDiagnostics {
  version: "1.0.0";
  provider: string;
  model?: string;
  callCount: number;
  cacheHitCount: number;
  satisfiedCount: number;
  rejectedCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalLatencyMs: number;
  retryCount: number;
  decisions?: SemanticVerifierDecisionSummary[];
}

export type DomainTrustReason =
  | "caller_supplied"
  | "exact_start_host"
  | "redirect_landing_host"
  | "same_registrable_domain_subdomain";

export type DomainCandidateEvidenceType =
  | "redirect_landing_host"
  | "canonical_url"
  | "visible_anchor"
  | "nav_anchor"
  | "objective_candidate_anchor";

export type DomainRejectionReason =
  | "unsupported_protocol"
  | "unparseable_url"
  | "localhost"
  | "loopback_address"
  | "link_local_address";

export interface TrustedDomainEntry {
  hostname: string;
  reason: DomainTrustReason;
  evidenceType?: DomainCandidateEvidenceType;
  sourceUrl?: string;
}

export interface ExternalDomainCandidate {
  hostname: string;
  registrableDomain: string | null;
  evidenceType: DomainCandidateEvidenceType;
  sourceUrl: string;
  reason: string;
}

export interface RejectedDomainCandidate {
  url: string;
  evidenceType: DomainCandidateEvidenceType | "redirect_hop";
  reason: DomainRejectionReason;
}

/**
 * Versioned separately from TaskResponse.schemaVersion, same pattern as
 * ReasoningProviderDiagnostics above. Reports the deterministic preflight domain-discovery
 * phase's findings: what it trusted and why, what it saw but declined to trust, and what it
 * rejected outright -- see docs/architecture.md "Preflight domain discovery" for the
 * conservative validation policy this reflects.
 */
export interface DomainDiscoveryDiagnostics {
  version: "1.0.0";
  startHostname: string;
  startRegistrableDomain?: string | null;
  finalUrl: string;
  redirectChain: string[];
  canonicalUrl?: string;
  trustedDomains: TrustedDomainEntry[];
  externalCandidates?: ExternalDomainCandidate[];
  rejectedCandidates?: RejectedDomainCandidate[];
  proposedAllowedDomains: string[];
  allowedDomainsUsed: string[];
  blockedReason?: string;
}

export interface Diagnostics {
  stepCount: number;
  backtrackCount: number;
  totalDurationMs: number;
  finishReason: string;
  engineVersion?: string;
  /**
   * Ids of required success criteria (successCriteria entries with required !== false)
   * that were never satisfied by the time the run ended. Present only when non-empty --
   * absent for a successful run (enforced empty by src/core/loop.ts before stop_success
   * is honoured) and for any task with no required criteria at all.
   */
  missingRequiredCriteriaIds?: string[];
  reasoningProvider?: ReasoningProviderDiagnostics;
  domainDiscovery?: DomainDiscoveryDiagnostics;
  semanticVerifier?: SemanticVerifierDiagnostics;
}

export interface TaskResponse {
  schemaVersion: "1.3.0";
  taskId: string;
  status: RunStatus;
  statusReason?: string;
  startUrl: string;
  finalUrl: string;
  steps: StepLog[];
  captures: Captures;
  engineAssessment: EngineAssessment;
  diagnostics: Diagnostics;
}
