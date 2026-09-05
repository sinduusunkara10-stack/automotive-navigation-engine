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
  /**
   * True when another element currently sits visually on top of this one's centre point
   * (e.g. a modal, an overlay, a banner) -- the same mechanical elementFromPoint hit-test
   * src/observation/observationBuilder.ts's readElementState already uses to revalidate a
   * click target immediately before dispatch, computed here up front instead so the
   * reasoning layer can see it too, rather than only discovering it after a wasted
   * decision and a failed click. A covered element is still reported (never silently
   * dropped) -- an element being visible but covered is itself informative, generic
   * evidence, never engine interpretation.
   */
  covered?: boolean;
  /**
   * Origin (scheme+host+port, never a full URL) of the same-origin child frame this
   * element was found in -- present only for an element outside the main document. See
   * src/observation/frames.ts. Absent for every main-document element, which remains the
   * overwhelming common case.
   */
  frameOrigin?: string;
}

export interface Observation {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  notableText?: string[];
  /** Generic, brand-agnostic progress-indicator text (e.g. "Step 2 of 4"), when present. */
  progressIndicatorText?: string[];
  /**
   * Bounded (capped small), deduplicated list of origins of same-origin-scan-eligible
   * child frames the engine detected but could not evaluate script in at the time of this
   * observation (removed mid-scan, or otherwise inaccessible -- see
   * src/observation/frames.ts). Present only when at least one such frame was seen. Never
   * frame content, never a reason it couldn't be read beyond the fact that it couldn't.
   */
  inaccessibleFrameOrigins?: string[];
  /**
   * Bounded, generic diagnostic evidence about the interactive-element scan itself, always
   * computed fresh alongside interactiveElements (see src/observation/observationBuilder.ts)
   * -- lets a caller distinguish "the page genuinely has no interactive controls yet" from
   * "controls exist but were excluded" (hidden/zero-size) or "controls exist inside a
   * structure this scan cannot see" (a non-zero shadowHostCount alongside an empty
   * interactiveElements is the generic, brand-agnostic signature of that specific gap --
   * see docs/architecture.md "Observation evidence"). Summed across the main document and
   * every accessible child frame, matching how interactiveElements itself is a flat
   * cross-frame list.
   */
  elementDiscoveryDiagnostics?: ElementDiscoveryDiagnostics;
}

/**
 * See Observation.elementDiscoveryDiagnostics above. `rawElementCount` is every node
 * matched by the same interactive-element selector interactiveElements is built from,
 * before any visibility filtering -- so rawElementCount > 0 with an empty
 * interactiveElements array means candidates existed but were all excluded (the
 * excluded*Count fields say why); rawElementCount === 0 means the selector matched nothing
 * at all at scan time (a genuinely empty page, or one that hadn't rendered its controls
 * yet). `buttonLikeCount`/`linkLikeCount`/`otherRoleCount` always sum to rawElementCount,
 * bucketed by each element's own role/tag (button-like: role or tag "button"; link-like:
 * role or tag "a"/"link"; everything else the selector matches -- tabs, options, radio/
 * checkbox-style controls, etc. -- as otherRoleCount). The three excluded*Count fields are
 * not mutually exclusive (a single excluded element can be zero-size *and* display:none),
 * so they need not sum to (rawElementCount - visibleElementCount). `shadowHostCount` counts
 * elements in the document with a non-null, *open* shadow root -- a closed shadow root's
 * presence is fundamentally undetectable from outside the component that created it (the
 * DOM API gives no way to ask), so a page using closed shadow DOM can still report
 * shadowHostCount: 0 despite hosting controls this scan cannot discover.
 */
export interface ElementDiscoveryDiagnostics {
  rawElementCount: number;
  buttonLikeCount: number;
  linkLikeCount: number;
  otherRoleCount: number;
  visibleElementCount: number;
  excludedZeroSizeCount: number;
  excludedDisplayNoneCount: number;
  excludedVisibilityHiddenCount: number;
  shadowHostCount: number;
}

export interface ActionResult {
  success: boolean;
  error?: string;
  resultingUrl?: string;
  /**
   * True only when a failed action's cause was mechanically classified as the target
   * having gone stale (hidden, detached, covered/intercepted, timed out, or its owning
   * frame becoming unavailable) between decision and dispatch -- never a genuinely wrong
   * or unsafe decision. Drives core/loop.ts's bounded, non-fatal recovery: a step whose
   * actionResult carries staleTarget does not by itself end the run (see
   * Diagnostics/StepLog.recoveryAttempts below for the bound). Absent (never false) when
   * not applicable, consistent with every other boolean evidence flag in this schema.
   */
  staleTarget?: boolean;
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
  /**
   * True when this step's pre-dispatch revalidation found the originally-decided click
   * target no longer actionable and asked the reasoning provider again against a freshly
   * rebuilt observation before dispatching anything (see core/loop.ts). Absent (never
   * false) for a step that never needed this -- the ordinary case.
   */
  reObservationAttempted?: boolean;
  /**
   * How many additional decision/revalidation cycles this step's pre-dispatch recovery
   * used before settling on the action it actually dispatched -- bounded by a small fixed
   * constant (see MAX_STALE_TARGET_RECOVERY_ATTEMPTS in core/loop.ts). Absent (never 0)
   * when no recovery cycle ran.
   */
  recoveryAttempts?: number;
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
  | "limit_stop"
  /**
   * A click target went stale (hidden, detached, covered/intercepted, timed out, or its
   * owning frame became unavailable) between decision and dispatch -- recorded once per
   * occurrence, whether or not the run ultimately recovered from it (severity/recoverable/
   * stoppedRun distinguish an in-progress recovery from the bounded allowance finally
   * being exhausted). See core/loop.ts and actions/click.ts's staleTarget classification.
   */
  | "stale_target_recovery";

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

export interface CookieNameEntry {
  name: string;
  domain: string;
}

export interface StorageKeyEntry {
  store: "local" | "session";
  key: string;
}

/**
 * Bounded, name-only footprint of cookies and localStorage/sessionStorage keys on the
 * current page, captured only when this step's hostname differs from the previous step's
 * (see src/capture-modules/hostContext.ts and CLAUDE.md "Secrets") -- lets a caller
 * empirically confirm, from Get Task Result, whether cookie/storage state carried across a
 * cross-host navigation without ever exposing a value: cookie/storage *names* and cookie
 * *domains* are structural facts about where state lives, not the state's content.
 * Deliberately never attempts to classify a name/key as "consent-related" -- that would
 * require exactly the kind of vendor-specific dictionary this engine's core must not
 * contain; every name/key present on the page is reported, and a human or a later,
 * out-of-band analysis decides what's relevant.
 */
export interface HostContextSnapshotCapture {
  stepIndex: number;
  timestamp: string;
  hostname: string;
  cookieNames: CookieNameEntry[];
  storageKeyNames: StorageKeyEntry[];
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
  host_context_snapshot?: HostContextSnapshotCapture[];
}

export interface EngineAssessment {
  objectiveAchieved: boolean;
  confidence: number;
  summary: string;
  satisfiedSuccessCriteriaIds?: string[];
  notes?: string;
}

export type ReasoningProviderDecisionOutcome = "accepted" | "rejected" | "error" | "fallback";

/**
 * Bounded diagnostic explaining which interactive elements from the step's Observation
 * were actually included in this one decision attempt's model prompt, and why (see
 * selection algorithm in src/reasoning/promptBuilder.ts) -- lets a caller confirm whether
 * a specific element visible in StepLog.observation actually reached the model, without
 * reconstructing the selection logic themselves. Bounded by construction: `selected` never
 * exceeds the same per-step interactive-element cap already applied to the prompt itself
 * (see promptBuilder.ts's MAX_INTERACTIVE_ELEMENTS), and `excludedRelevantCount` is a count
 * only, never a list -- this never duplicates the full observation or the raw prompt.
 */
export interface PromptElementSelectionDiagnostic {
  candidateCount: number;
  selectedCount: number;
  relevantSelectedCount: number;
  structuralSelectedCount: number;
  excludedRelevantCount: number;
  selected: { id: string; accessibleName: string; reason: "relevant" | "structural" }[];
}

export interface ReasoningProviderDecisionSummary {
  stepIndex?: number;
  attempt: number;
  outcome: ReasoningProviderDecisionOutcome;
  confidence?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  elementSelection?: PromptElementSelectionDiagnostic;
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
  version: "1.1.0";
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

/**
 * One process.memoryUsage() sample, taken at a specific, generic lifecycle point -- never
 * anything about the page/task being run. See Diagnostics.memory below and
 * docs/architecture.md "Memory stability" for why this exists and how it's bounded.
 */
export interface MemorySample {
  timestamp: string;
  label: "run_start" | "step" | "after_cleanup";
  stepIndex?: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
}

/**
 * One resource type's tally under low-memory browser mode (see Diagnostics.resourceRouting
 * and docs/architecture.md "Low-memory browser mode"). `resourceType` is one of
 * Playwright's own request.resourceType() values (document, stylesheet, image, media,
 * font, script, texttrack, xhr, fetch, eventsource, websocket, manifest, other) -- never
 * anything about a specific site or brand. `allowedBytesMeasured` is summed from actual
 * Content-Length response headers when present (a real, measured number); requests
 * without that header contribute 0, so this can under-count but never fabricates a
 * number. `blockedBytesEstimated` is `blockedCount` times a fixed, documented
 * per-resource-type average (see src/api/browserResourceRouting.ts) -- an estimate,
 * never a measurement, since a blocked resource is never actually fetched.
 */
export interface ResourceRoutingEntry {
  resourceType: string;
  allowedCount: number;
  allowedBytesMeasured: number;
  blockedCount: number;
  blockedBytesEstimated: number;
}

/**
 * Present only when LOW_MEMORY_BROWSER_MODE was enabled for this run (src/config/
 * lowMemoryBrowserConfig.ts). One entry per resource type actually seen -- inherently
 * bounded by Playwright's own small, fixed resourceType vocabulary, never per-request.
 */
export interface ResourceRoutingDiagnostics {
  mode: "low_memory";
  byResourceType: ResourceRoutingEntry[];
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
  /**
   * Bounded (most-recent-N, see src/core/boundedArray.ts) process.memoryUsage() samples:
   * one at run start, one after each step, and one appended by the API layer after browser
   * cleanup (src/api/runner.ts) once it's available -- entirely generic Node.js runtime
   * evidence, never anything about the page or brand being navigated. Exists to let an
   * operator correlate a specific run with memory growth, and to distinguish "one run
   * spiked" from "memory climbed gradually across the whole run" after an incident like a
   * container OOM kill. Present whenever at least one sample was taken (effectively every
   * run).
   */
  memory?: MemorySample[];
  /**
   * Counts and approximate bytes of network requests allowed/blocked by low-memory
   * browser mode -- see ResourceRoutingDiagnostics above. Absent when that mode wasn't
   * enabled for this run (the default), matching how domainDiscovery/semanticVerifier are
   * absent when their own feature wasn't in play for a run.
   */
  resourceRouting?: ResourceRoutingDiagnostics;
}

export interface TaskResponse {
  schemaVersion: "1.8.0";
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
