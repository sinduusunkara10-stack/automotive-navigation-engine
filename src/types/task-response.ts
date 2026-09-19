import type { ActionType, SelectedAction } from "./actions.js";
import type { ConsentControlIntent } from "./consentControl.js";
import type { ConsentInteractionPolicy } from "./task-request.js";
import type { AlternativeExplorationDiagnostics, ConsentDiagnostics, RecoveryDiagnostics } from "./recovery.js";

export type RunStatus =
  | "success"
  | "blocked"
  | "failure"
  | "max_steps_reached"
  | "max_backtracks_reached"
  | "max_duration_reached"
  | "container_memory_threshold_reached";

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
  /**
   * Short (<=80 char) text of the nearest enclosing heading (h1-h4), found via a bounded
   * ancestor walk -- a cheap, markup-agnostic proxy for "which repeated card/list-item is
   * this control part of" (e.g. a listing of cards each with its own product heading and an
   * identically-labelled action button). Used by src/core/routeMemory.ts to disambiguate
   * route-memory candidate identity for controls that would otherwise collapse to the same
   * role+accessibleName identity across multiple repeated cards. Absent when no heading was
   * found within the bounded walk.
   */
  nearestHeadingText?: string;
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
  /**
   * Modal-aware observation (see CLAUDE.md and docs/architecture.md "Modal-aware
   * observation"): present when a visible dialog/modal surface (role="dialog",
   * aria-modal="true", or a native <dialog>) exists in the main document at the time of
   * this observation. A compact, generic identity only -- role and a short accessible-name
   * excerpt -- never the dialog's full content (that's still carried, element by element,
   * in interactiveElements as usual). Lets the reasoning layer and prompt builder
   * distinguish "no modal is open" from "a modal is open" without inferring it indirectly
   * from interactiveElements[].covered alone.
   */
  activeDialog?: { role: string; accessibleName: string };
  /**
   * Multilingual consent handling (see CLAUDE.md and docs/architecture.md "Consent
   * behaviour -- multilingual"): the page's own declared language (`<html lang>`),
   * normalised to its primary subtag only (e.g. "fr-FR" -> "fr") -- one signal among
   * several src/safety/consentClassifier.ts combines, never a translation and never used
   * on its own to decide anything. Absent when the page declares no language.
   */
  pageLanguage?: string;
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

/**
 * Adaptive settling (see CLAUDE.md and docs/architecture.md "Adaptive settling"): the
 * outcome of one bounded wait for the page to go quiet after an action or navigation,
 * computed by src/core/robustNavigation.ts's waitForAdaptiveSettle. `elapsedMs` is always
 * <= the effective ceiling used for that wait (task.settling?.maxSettleMs when the task
 * set one, else the engine default, itself always <= the hard 10s cap). "quiet_window":
 * the page went quiet (no DOM mutations, no change in interactive-element count) for the
 * configured window before the ceiling was reached -- the common, fast-page case.
 * "ceiling_reached": the page never quieted and the wait was cut off at the ceiling --
 * worth surfacing distinctly since it's the signal a caller would use to decide whether a
 * task-level ceiling override is warranted for a given site.
 */
export interface SettleDiagnostic {
  elapsedMs: number;
  reason: "quiet_window" | "ceiling_reached";
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
  /**
   * Overlay-click-detection fix (see actions/click.ts), target-attributable click-success
   * fix: true only when a bounded post-click check found generic evidence, attributable to
   * the clicked target specifically (its own aria-expanded/covered state changing, or it
   * disappearing -- see detectTargetAttributableSideEffect), that this click produced a real
   * interaction-state change -- including the case where the direct dispatch appeared to
   * fail as intercepted/timed-out because the overlay it opened came to cover the trigger
   * itself, so the click is reported as a success on that basis instead of falling through
   * to the destinationUrl fallback. An unrelated element elsewhere on the page changing at
   * the same moment (e.g. a cookie/consent overlay re-rendering independently of this click)
   * no longer counts. Absent (never false), consistent with every other boolean evidence
   * flag in this schema, whenever no such evidence was found or no check applied.
   */
  clickSideEffectDetected?: boolean;
  /**
   * Overlay-click-detection / fallback-verification fix (see actions/click.ts), target-
   * attributable click-success fix: present only when a generic destinationUrl navigation
   * fallback was actually used to recover an unactionable click. True means the fallback's
   * resulting page state was verified as a genuine, meaningful change attributable to the
   * clicked target (a different page path/origin, or target-attributable evidence of a new
   * interactive surface) rather than assumed equivalent to a real click; false means the
   * fallback only changed the URL (e.g. a same-document hash-only navigation) with no
   * verified further evidence. This is no longer diagnostic-only: `success` itself is false
   * whenever fallbackVerified is false (see `staleTarget` below) -- an unverified fallback is
   * never reported as a successful action, not merely excluded from route-memory's
   * "advanced" classification.
   */
  fallbackVerified?: boolean;
  /**
   * Fallback-verification fix (see actions/click.ts's verifyFallbackNavigation): present
   * whenever fallbackVerified is present, naming the specific mechanism that produced that
   * verdict -- e.g. "path_changed" (a genuinely different page was reached), a
   * ClickSideEffectType value (target-attributable evidence found), or
   * "unverified_hash_or_query_only_change" (fallbackVerified: false). Purely explanatory --
   * never itself a gating condition anywhere in the engine.
   */
  fallbackVerificationReason?: string;
  /**
   * Popup/new-context capture (see src/capture-modules/popupCapture.ts): true only when this
   * click produced a "popup" event (a target="_blank" anchor or a window.open() call from a
   * click handler) -- regardless of whether that context was successfully instrumented.
   * Absent (never false) whenever no such context was opened.
   */
  openedNewContext?: boolean;
  /**
   * Present only when openedNewContext is true. True when the opened context was actually
   * adopted long enough to attach analytics capture to it (see popupCapture.ts's bounded
   * adoption window) before being closed; false when it closed, navigated away, or otherwise
   * became unavailable before instrumentation could attach. Never asserts that the context
   * produced any particular evidence -- only that it was observed at all.
   */
  observedNewContext?: boolean;
  /**
   * PR 1C-a (drawer/modal/half-window detection beyond role="dialog"/aria-modal, post-click
   * surface awareness): true only for a non-navigating click whose bounded post-click
   * readiness wait found generic evidence -- via a *broader*, non-target-attributed
   * heuristic than clickSideEffectDetected -- that a new interactive surface likely
   * appeared: a dialog/modal appearing or changing, or a large newly-appeared fixed/
   * absolute/sticky panel co-occurring with several new controls (the shape of a drawer/
   * side-panel/half-window that never uses role="dialog"/aria-modal). Deliberately
   * separate from, and never a substitute for, clickSideEffectDetected: that field alone
   * still governs click-success/route-progress attribution. This field is purely
   * informational context threaded into the *next* decision (see RecordedAction.
   * surfaceChangeType, src/reasoning/promptBuilder.ts) -- never itself a success or
   * progress signal. Absent (never false) whenever no such evidence was found.
   */
  surfaceChangeDetected?: boolean;
  /** Present only when surfaceChangeDetected is true, naming which heuristic matched: "dialog_appeared", "dialog_changed", or "layer_panel_appeared". Purely explanatory. */
  surfaceChangeType?: string;
  /**
   * Adaptive settling (see SettleDiagnostic above): present whenever this action ran a
   * settle wait against the tracked page at all -- every navigate, and every click that
   * doesn't fail before dispatch. Absent for an action type that never settles (scroll,
   * wait, go_back, capture, the stop_* actions) and for a click that opens a popup/new
   * context (that context's own bounded capture window settles independently -- see
   * src/capture-modules/popupCapture.ts -- and is never reported here, since this field
   * always describes the tracked page's own settle wait).
   */
  settleDiagnostic?: SettleDiagnostic;
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
  /** Mirrors ActionResult.settleDiagnostic for this step's dispatched action -- see its own doc comment. */
  settleDiagnostic?: SettleDiagnostic;
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

/**
 * Which browsing context/frame this piece of evidence was actually read from -- a
 * generic, mechanical fact about *how* the evidence was captured, never an interpretation
 * of what it means. "main_frame"/"child_frame" both refer to frames of the one Page the
 * engine is navigating (see src/observation/frames.ts, reused here); "popup_context" means
 * a separate Page object opened by a click (target="_blank"/window.open()) and adopted for
 * a short, bounded capture window (see src/capture-modules/popupCapture.ts) rather than the
 * tracked page itself.
 */
export type EvidenceCaptureSource = "main_frame" | "child_frame" | "popup_context";

export interface DataLayerCapture {
  stepIndex: number;
  url: string;
  timestamp: string;
  raw: Record<string, unknown>[];
  source: EvidenceCaptureSource;
  /** Origin (scheme+host+port) of the child frame this entry was read from -- present only for source: "child_frame". */
  frameOrigin?: string;
  /** Stable id distinguishing the tracked page ("main") from a specific adopted popup context. Absent for legacy/untagged callers only. */
  contextId?: string;
  /** True when this entry's raw array was cut down to MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT (oldest dropped first) -- never a silent truncation. */
  truncated?: boolean;
}

export interface Ga4NetworkEventCapture {
  stepIndex: number;
  requestUrl: string;
  timestamp: string;
  /** HTTP method of the outgoing request, e.g. "GET", "POST" -- generic Playwright request.method(). */
  method: string;
  /** Query-string parameters, unchanged from before this fix. */
  params?: Record<string, string>;
  /**
   * Raw POST/sendBeacon request body, bounded to MAX_GA4_POST_BODY_BYTES (see
   * src/config/captureLimits.ts) and truncated (never dropped) past that. Absent for a GET
   * request, or a POST/sendBeacon request with no body.
   */
  postDataRaw?: string;
  /**
   * Body parameters, generically parsed only when the raw body is unambiguously
   * form-urlencoded (one or more "key=value&key=value" lines) -- never a client-specific
   * parsing rule. One entry per newline-delimited hit, matching how a batched GA4
   * sendBeacon body concatenates multiple hits. Absent when the body doesn't confidently
   * parse this way; never a guess.
   */
  postDataParams?: Record<string, string>[];
  /** Mechanically read from the standard GA4 Measurement Protocol "tid" parameter (query or body) when present. Never inferred when absent. */
  measurementId?: string;
  /** Mechanically read from the standard GA4 consent-state parameters ("gcs", "dma", "dma_cps") when present, verbatim. Never inferred when absent. */
  consentState?: Record<string, string>;
  source: EvidenceCaptureSource;
  /** Stable id distinguishing the tracked page ("main") from a specific adopted popup context. Absent for legacy/untagged callers only. */
  contextId?: string;
  /** Origin of the child frame this request originated from -- present only for source: "child_frame". */
  frameOrigin?: string;
  /** True when postDataRaw was cut down to MAX_GA4_POST_BODY_BYTES -- never a silent truncation. */
  truncated?: boolean;
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
  /** Mirrors ActionResult.openedNewContext for this click -- see its own doc comment. */
  openedNewContext?: boolean;
  /** Mirrors ActionResult.observedNewContext for this click -- see its own doc comment. */
  observedNewContext?: boolean;
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
  /**
   * PR 1D (truthful milestone evaluation, see docs/architecture.md §21): a rollup of
   * diagnostics.milestoneEvidence[].evidenceTier across every milestone this run satisfied,
   * so a caller can see at a glance whether this run's outcome rests entirely on hard
   * observed evidence or partly on inferred (semantic/model) judgement, without walking the
   * full evidence list by hand. assumedCount is always 0 -- see MilestoneEvidenceRecord.
   * evidenceTier's own doc comment -- present so that absence is auditable from the response
   * itself rather than merely asserted in documentation. Present only when at least one
   * criterion was satisfied during the run (i.e. whenever diagnostics.milestoneEvidence is
   * itself non-empty).
   */
  evidenceTierSummary?: { observedCount: number; inferredCount: number; assumedCount: number };
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
  /** Relevant candidates that did not survive selection -- see omissionReason below for why. */
  excludedRelevantCount: number;
  /**
   * Candidate-selection redesign (see CLAUDE.md and docs/architecture.md "The 40-element
   * limit"): how many elements were included only because they strongly matched the
   * currently-unresolved milestone specifically (selectPromptInteractiveElements's bounded
   * guaranteed-inclusion top-up), on top of the ordinary relevance/structural budgets.
   */
  guaranteedInclusionCount: number;
  /** Short, fixed label naming which selection strategy produced this diagnostic -- "none" when candidateCount was already within the cap. */
  truncationStrategy: string;
  /** Present only when excludedRelevantCount > 0, explaining generically why a relevant candidate still did not survive. */
  omissionReason?: string;
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
  /**
   * This decision's self-reported consent semantics (see types/consentControl.ts), present
   * whenever the provider produced a parseable response -- on acceptance and on a
   * consent_policy_violation rejection alike, so the full attempt-by-attempt consent history
   * is auditable even when nothing was ultimately dispatched.
   */
  consentControlIntent?: ConsentControlIntent;
  /**
   * Whether consentControlIntent (above) complied with this run's consentInteractionPolicy,
   * per src/safety/consentPolicyGuard.ts's deterministic check. Present alongside
   * consentControlIntent.
   */
  consentPolicyCompliant?: boolean;
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
  version: "1.2.0";
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
  /**
   * The resolved consentInteractionPolicy (task-request.ts) this run actually enforced --
   * present so a caller can audit which policy applied even when the request itself omitted
   * the field and the documented default ("reject_optional") applied instead. Absent only
   * for a provider (e.g. MockReasoningProvider) that never resolved a policy.
   */
  consentInteractionPolicy?: ConsentInteractionPolicy;
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

/**
 * Present only when MEMORY_CIRCUIT_BREAKER_ENABLED was enabled for this run (src/config/
 * containerMemoryCircuitBreakerConfig.ts, src/safety/containerMemoryGuard.ts). Reports the
 * single latest sample taken before the run ended -- not a growing history -- from generic
 * Linux cgroup memory accounting (cgroup v2, falling back to v1), never anything about the
 * page/task/brand being run. `available: false` means this container did not expose
 * readable cgroup memory files; the breaker is then always inert (never breaches) rather
 * than failing the task.
 */
export interface ContainerMemoryDiagnostics {
  enabled: true;
  available: boolean;
  version?: "v2" | "v1";
  thresholdFraction: number;
  limitBytes?: number;
  latestSampleBytes?: number;
  breached: boolean;
}

/**
 * Recorded once per success criterion, at the moment it first becomes satisfied -- never
 * re-recorded (satisfiedCriteriaIds is a one-way ratchet, see src/core/state.ts, so a
 * criterion contributes at most one record for the life of a run). Exists so a caller can
 * see *why* the engine judged each milestone satisfied -- which page, which phase of the
 * step, and what evidence actually satisfied it (a matched URL pattern, a matched selector,
 * a deterministic vocabulary-overlap score, or a semanticVerifier's own cited evidence) --
 * without reconstructing it from steps[]/captures. This is engine classification (the
 * "why"), deliberately kept in diagnostics rather than captures, which stays raw,
 * website-derived evidence only -- see CLAUDE.md's non-negotiable design rule.
 */
export interface MilestoneEvidenceRecord {
  criterionId: string;
  /** The criterion's own successCriteria[].type value, e.g. "semantic_page_match". */
  criterionType: string;
  /** The criterion's own description text, echoed for readability. */
  description: string;
  stepIndex: number;
  /** Whether this criterion was evaluated before this step's own action was dispatched, or immediately after it. */
  phase: "pre_action" | "post_action";
  /** Page URL at the moment this criterion was judged satisfied. */
  pageUrl: string;
  pageTitle: string;
  /**
   * Which mechanism actually satisfied the criterion, e.g. "url_pattern",
   * "element_present", "semantic_page_match:deterministic", "semantic_page_match:verifier",
   * "data_layer_event", "network_event".
   */
  evidenceSource: string;
  /**
   * PR 1D (truthful milestone evaluation, see docs/architecture.md §21): a deterministic
   * classification of *how* evidenceSource established this criterion, computed by
   * src/core/successEvaluator.ts's computeEvidenceTier -- never a separate judgement call.
   * "observed": a direct mechanical DOM/URL/event read with no reasoning-layer or
   * model involvement at all (url_pattern, element_present, data_layer_event,
   * network_event). "inferred": a vocabulary-overlap score or model judgement
   * (semantic_page_match, either its deterministic lexical path or its optional
   * semanticVerifier fallback) -- real evidence, but over textual/semantic similarity
   * rather than a literal fact. "assumed": reserved for a milestone satisfied with no
   * independent corroborating evidence at all; structurally unreachable from this
   * evaluator's own code today (every code path that can append a MilestoneEvidenceRecord
   * requires either "observed" or "inferred" evidenceSource) -- see
   * tests/unit/milestoneEvidenceTiers.test.ts for the test enforcing this as an invariant,
   * not merely a convention.
   */
  evidenceTier: "observed" | "inferred" | "assumed";
  /**
   * Deterministic vocabulary-overlap score or semanticVerifier confidence for an "inferred"
   * entry; always 1.0 (unambiguous) for an "observed" entry. Always present (uniform
   * across every evidenceTier) so a caller can sort/filter diagnostics.milestoneEvidence by
   * confidence without special-casing which criterion type happened to produce it.
   */
  score: number;
  /** The literal pattern/selector/match object that satisfied this criterion, when applicable. */
  matchedValue?: string;
  /** Short human-readable explanation of why the criterion was judged satisfied. */
  reason: string;
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
  /**
   * The opt-in container-memory circuit breaker's latest sample and outcome -- see
   * ContainerMemoryDiagnostics above. Absent when MEMORY_CIRCUIT_BREAKER_ENABLED wasn't
   * set for this run (the default).
   */
  containerMemory?: ContainerMemoryDiagnostics;
  /**
   * One record per success criterion the moment it first becomes satisfied -- see
   * MilestoneEvidenceRecord above. Present only when at least one criterion was satisfied
   * during the run (bounded implicitly by successCriteria.length).
   */
  milestoneEvidence?: MilestoneEvidenceRecord[];
  /**
   * Milestone-anchored recovery (see CLAUDE.md and docs/architecture.md "Milestone-anchored
   * recovery"): every recovery-anchor restore attempt this run made, whether it succeeded or
   * not -- see src/types/recovery.ts. Present only when at least one restore was attempted.
   */
  recovery?: RecoveryDiagnostics;
  /**
   * Alternative Route Exploration (see CLAUDE.md and docs/architecture.md "Alternative
   * route exploration"): every distinct candidate this run tried at a recovery anchor's
   * decision point, and its progress outcome -- see src/types/recovery.ts. Present only
   * when at least one bounded exploration cycle ran.
   */
  alternativeExploration?: AlternativeExplorationDiagnostics;
  /**
   * Consent behaviour (see CLAUDE.md and docs/architecture.md "Consent behaviour"): every
   * consent surface the engine's own independent, deterministic classifier evaluated this
   * run (detected or not), and any proactive accept-all action taken under
   * consentInteractionPolicy "accept_optional" -- see src/types/recovery.ts. Present only
   * when at least one surface was evaluated.
   */
  consent?: ConsentDiagnostics;
}

export interface TaskResponse {
  schemaVersion: "1.18.0";
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
