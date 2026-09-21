import type { DataLayerCapture, Ga4NetworkEventCapture } from "../types/task-response.js";
import type { ConsentStorageEvidence } from "./consentEvidence.js";

/**
 * The five outcomes this engine can honestly distinguish for one click's analytics
 * evidence -- see docs/architecture.md "Generic action-attributed analytics capture" and
 * a real-site CTA-click analytics-correlation investigation this module was added to resolve. Deliberately a
 * closed, generic vocabulary: never a brand/vendor-specific value.
 */
export type AnalyticsCaptureStatus =
  | "CAPTURED"
  | "WEBSITE_NO_OBSERVED_TAG"
  | "ENGINE_CAPTURE_INCOMPLETE"
  | "CORRELATION_UNRESOLVED"
  | "CAPTURE_UNCERTAIN_CONSENT_STATE";

/**
 * Generic, mechanical health facts about this action's own capture window -- never an
 * inference about what the evidence *means* (that's analyticsCapture.status below), only
 * about whether the *mechanism* that would have observed it was itself healthy. See
 * CLAUDE.md "Keep raw, website-derived evidence... strictly separate from... engine-
 * generated classification": every field here is a structural fact this engine can assert
 * about its own instrumentation, not a claim about the target site.
 */
export interface CaptureHealth {
  captureWindowStartedBeforeClick: boolean;
  dataLayerReplaced: boolean;
  /** True whenever the run-lifetime push-observer (capture-modules/dataLayer.ts) is attached and reporting -- see engine.ts/popupCapture.ts's own attach-success plumbing. */
  dataLayerPushListenerActive: boolean;
  /** True whenever the run-lifetime GA4 request listener (capture-modules/ga4NetworkEvents.ts) is attached for this action's page/context. */
  networkListenerActive: boolean;
  /**
   * True only when dataLayerDelta.replaced is true (a full navigation reset the array) AND
   * no push-observer entry inside this action's own window can account for what a click
   * handler may have pushed immediately before that navigation tore its JS context down --
   * see dataLayer.ts's own doc comment on this exact race. False whenever a navigation
   * didn't happen, or the push-observer did capture something in-window.
   */
  unobservedDataLayerGapPossible: boolean;
  captureComplete: boolean;
  issues: string[];
}

export function computeCaptureHealth(params: {
  isClick: boolean;
  dataLayerReplaced: boolean;
  dataLayerPushListenerActive: boolean;
  networkListenerActive: boolean;
  dataLayerPushesObservedInWindowCount: number;
  dataLayerModuleRequested: boolean;
  ga4ModuleRequested: boolean;
}): CaptureHealth {
  const issues: string[] = [];
  const unobservedDataLayerGapPossible =
    params.dataLayerReplaced && params.dataLayerPushesObservedInWindowCount === 0;

  if (params.dataLayerModuleRequested && !params.dataLayerPushListenerActive) {
    issues.push("data_layer_evidence push listener failed to attach for this page/context");
  }
  if (params.ga4ModuleRequested && !params.networkListenerActive) {
    issues.push("ga4_network_events network listener failed to attach for this page/context");
  }
  if (unobservedDataLayerGapPossible) {
    issues.push(
      "dataLayer was replaced by a full navigation and no push-observer entry was captured inside this action's window -- a click-handler push immediately before navigation cannot be ruled out as lost",
    );
  }

  return {
    captureWindowStartedBeforeClick: params.isClick,
    dataLayerReplaced: params.dataLayerReplaced,
    dataLayerPushListenerActive: params.dataLayerPushListenerActive,
    networkListenerActive: params.networkListenerActive,
    unobservedDataLayerGapPossible,
    captureComplete: issues.length === 0,
    issues,
  };
}

/** Standard GA4 Measurement Protocol page-location parameter, read from query or (batched) POST params -- never inferred. */
export function extractGa4PageLocation(event: Ga4NetworkEventCapture): string | undefined {
  if (event.params?.dl) {
    return event.params.dl;
  }
  for (const body of event.postDataParams ?? []) {
    if (body.dl) {
      return body.dl;
    }
  }
  return undefined;
}

/**
 * Deliberately exact string equality only -- never normalized (trailing slash, query order,
 * casing) and never a substring/fuzzy match. An exact match is the one form of URL
 * comparison that carries no risk of a false-positive attribution; anything else is left as
 * an unresolved candidate rather than silently "corrected" into a match.
 */
function urlsMatch(a: string | undefined, b: string | undefined): boolean {
  return Boolean(a && b && a === b);
}

export interface AnalyticsCaptureResult {
  status: AnalyticsCaptureStatus;
  classificationReason: string;
  /** GA4 requests in this action's window whose own page-location exactly matches the click's resultingUrl/destinationUrl. */
  confirmedGa4Events: Ga4NetworkEventCapture[];
  /** GA4 requests in this action's window that could not be safely assigned (page-location absent, or naming a different page). */
  unresolvedGa4Candidates: Ga4NetworkEventCapture[];
  /** dataLayer pushes (from the real-time push-observer stream, not the before/after diff) in this action's window whose own captured url exactly matches resultingUrl. */
  confirmedDataLayerPushes: DataLayerCapture[];
  unresolvedDataLayerPushes: DataLayerCapture[];
  measurementIds: string[];
  consent: ConsentStorageEvidence & { required: boolean; verified: boolean };
}

export function classifyActionAnalyticsCapture(params: {
  resultingUrl?: string;
  destinationUrl?: string;
  dataLayerReplaced: boolean;
  dataLayerHasNewEntries: boolean;
  ga4EventsInWindow: Ga4NetworkEventCapture[];
  dataLayerPushesInWindow: DataLayerCapture[];
  captureHealth: CaptureHealth;
  consentRequired: boolean;
  consentEvidence: ConsentStorageEvidence;
}): AnalyticsCaptureResult {
  const targetUrls = [params.resultingUrl, params.destinationUrl].filter((u): u is string => Boolean(u));
  const matchesTarget = (candidate: string | undefined) => targetUrls.some((target) => urlsMatch(candidate, target));

  const confirmedGa4Events = params.ga4EventsInWindow.filter((event) => matchesTarget(extractGa4PageLocation(event)));
  const unresolvedGa4Candidates = params.ga4EventsInWindow.filter((event) => !matchesTarget(extractGa4PageLocation(event)));
  const confirmedDataLayerPushes = params.dataLayerPushesInWindow.filter((entry) => matchesTarget(entry.url));
  const unresolvedDataLayerPushes = params.dataLayerPushesInWindow.filter((entry) => !matchesTarget(entry.url));

  const measurementIds = Array.from(
    new Set(params.ga4EventsInWindow.map((event) => event.measurementId).filter((id): id is string => Boolean(id))),
  );

  const consentVerified = !params.consentRequired || params.consentEvidence.analyticsStorageGranted === true;
  const consent = { ...params.consentEvidence, required: params.consentRequired, verified: consentVerified };

  if (params.consentRequired && !consentVerified) {
    return {
      status: "CAPTURE_UNCERTAIN_CONSENT_STATE",
      classificationReason:
        "consentInteractionPolicy requires optional consent to be accepted, but no analytics_storage=granted evidence was observed for this run before this action",
      confirmedGa4Events,
      unresolvedGa4Candidates,
      confirmedDataLayerPushes,
      unresolvedDataLayerPushes,
      measurementIds,
      consent,
    };
  }

  if (!params.captureHealth.captureComplete) {
    return {
      status: "ENGINE_CAPTURE_INCOMPLETE",
      classificationReason: params.captureHealth.issues.join("; "),
      confirmedGa4Events,
      unresolvedGa4Candidates,
      confirmedDataLayerPushes,
      unresolvedDataLayerPushes,
      measurementIds,
      consent,
    };
  }

  const confirmedEventCount =
    confirmedGa4Events.length + confirmedDataLayerPushes.length + (params.dataLayerHasNewEntries && !params.dataLayerReplaced ? 1 : 0);
  const unresolvedCandidateCount = unresolvedGa4Candidates.length + unresolvedDataLayerPushes.length;

  if (unresolvedCandidateCount > 0 && confirmedEventCount === 0) {
    return {
      status: "CORRELATION_UNRESOLVED",
      classificationReason:
        "analytics evidence exists inside this action's capture window, but none of it names this click's own resulting/destination URL -- it cannot be safely assigned",
      confirmedGa4Events,
      unresolvedGa4Candidates,
      confirmedDataLayerPushes,
      unresolvedDataLayerPushes,
      measurementIds,
      consent,
    };
  }

  if (confirmedEventCount === 0 && unresolvedCandidateCount === 0) {
    return {
      status: "WEBSITE_NO_OBSERVED_TAG",
      classificationReason: "capture was healthy and complete for this action's window, and no analytics evidence was observed at all",
      confirmedGa4Events,
      unresolvedGa4Candidates,
      confirmedDataLayerPushes,
      unresolvedDataLayerPushes,
      measurementIds,
      consent,
    };
  }

  return {
    status: "CAPTURED",
    classificationReason: "analytics evidence observed in this action's window was safely matched to its resulting/destination URL",
    confirmedGa4Events,
    unresolvedGa4Candidates,
    confirmedDataLayerPushes,
    unresolvedDataLayerPushes,
    measurementIds,
    consent,
  };
}
