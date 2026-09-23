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
 * Diagnostic-only relationship between an analytics-emitted URL and the click's own
 * ctaElementDestinationUrl/browserResultingUrl -- see this module's own doc comment below
 * on why this is never used as a confirmation gate. Known tracking parameters are stripped
 * only for computing this classification, never for altering a preserved URL value.
 */
export type UrlRelationship =
  | "EXACT_MATCH"
  | "TRACKING_PARAMETERS_ONLY_DIFFERENCE"
  | "SAME_PHYSICAL_PAGE"
  | "DIFFERENT_ANALYTICS_VIRTUAL_STATE"
  | "DIFFERENT_DESTINATION"
  | "UNAVAILABLE";

/**
 * Which phase of this action's own lifecycle produced the confirming evidence -- see
 * core/loop.ts's ga4MidIndex/dataLayerPushMidIndex (captured the instant actionResult
 * resolves, splitting this action's capture window into "during physical dispatch" vs
 * "during post-dispatch settle/fallback"). RECOVERY/BACKTRACK are part of the same closed
 * vocabulary for other action types (stale-target recovery, go_back) but are never produced
 * by classifyActionAnalyticsCapture itself, which only ever classifies click actions.
 */
export type TriggerSegment =
  | "PHYSICAL_CLICK"
  | "POPUP_OR_NEW_TAB"
  | "FALLBACK_NAVIGATION"
  | "DESTINATION_SETTLEMENT"
  | "RECOVERY"
  | "BACKTRACK";

/**
 * Confirmed-event safety (see this module's own doc comment on classifyEvidenceItem): the
 * per-event/per-push category one piece of evidence inside an action's capture window
 * actually earns, never merely "was observed inside the window". Window/segment ownership
 * alone is necessary but never sufficient -- see classifyEvidenceItem.
 */
export type EvidenceClassification =
  | "CLICK_EVENT"
  | "PHYSICAL_PAGE_CHANGE"
  | "VIRTUAL_PAGE_CHANGE"
  | "FORM_OR_CONFIGURATOR_STATE"
  | "OTHER_MEANINGFUL_EVENT"
  | "CORRELATION_UNRESOLVED";

/**
 * The dedicated-click-tag outcome for one action, distinct from the action's overall
 * analyticsCapture.status: an action can have healthy, complete, CAPTURED overall evidence
 * (page/virtual-state events all confirmed) while still having no dedicated click tag of its
 * own -- that is WEBSITE_NO_OBSERVED_CLICK_TAG, never CORRELATION_UNRESOLVED. See
 * classifyActionAnalyticsCapture's own doc comment.
 */
export type PrimaryClickEventStatus =
  | "CAPTURED"
  | "WEBSITE_NO_OBSERVED_CLICK_TAG"
  | "CORRELATION_UNRESOLVED"
  | "ENGINE_CAPTURE_INCOMPLETE"
  | "CAPTURE_UNCERTAIN_CONSENT_STATE";

/** One GA4 request or dataLayer push inside this action's window, tagged with the category it actually earned -- see EvidenceClassification. Exactly one of ga4Event/dataLayerPush is set. */
export interface ClassifiedEvidence {
  classification: EvidenceClassification;
  ga4Event?: Ga4NetworkEventCapture;
  dataLayerPush?: DataLayerCapture;
  /** Which phase of the action produced this specific item -- see TriggerSegment. Always populated for an item observed in-window; never inferred downstream. */
  triggerSegment?: TriggerSegment;
}

/** Best-effort, non-brand-specific virtual-page/form-state metadata read verbatim from a dataLayer push -- see extractAnalyticsVirtualPageMetadata. */
export interface AnalyticsVirtualPageMetadata {
  virtualPageUrl?: string;
  pageName?: string;
  pageCategory?: string;
  formName?: string;
  stepName?: string;
  stepNumber?: string | number;
}

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
 * GA4 Enhanced Measurement's own "link_url" click parameter (query or batched POST body) --
 * the destination URL the analytics event itself emitted for an outbound-click/CTA event,
 * kept strictly separate from the page's own dl (physical page location). Never inferred
 * when absent.
 */
export function extractAnalyticsEventDestinationUrl(event: Ga4NetworkEventCapture): string | undefined {
  if (event.params?.link_url) {
    return event.params.link_url;
  }
  for (const body of event.postDataParams ?? []) {
    if (body.link_url) {
      return body.link_url;
    }
  }
  return undefined;
}

function readStringField(raw: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Best-effort, cross-vendor page_location/full_url extraction from one raw dataLayer push
 * entry (GTM/gtag-style tag-management conventions, never a brand/vendor-specific key) --
 * documented candidate key names only, never a guess beyond an exact key match. This is the
 * analytics-emitted value CLAUDE.md's "keep raw evidence separate from classification"
 * principle and the CLICK EVENT/PHYSICAL PAGE ANALYTICS rules both require to be preserved
 * verbatim, never overwritten by the browser's own resulting URL.
 */
export function extractDataLayerPageLocationFields(raw: Record<string, unknown>): {
  pageLocation?: string;
  fullUrl?: string;
  eventDestinationUrl?: string;
} {
  return {
    pageLocation: readStringField(raw, ["page_location", "pageLocation"]),
    fullUrl: readStringField(raw, ["full_url", "fullUrl", "page_full_url"]),
    eventDestinationUrl: readStringField(raw, [
      "link_url",
      "linkUrl",
      "destination_url",
      "destinationUrl",
      "click_url",
      "clickUrl",
      "outbound_url",
      "eventDestinationUrl",
      "event_destination_url",
      // Google Tag Manager's own built-in Link Click auto-event variable -- vendor-neutral,
      // not brand-specific (GTM reserves the "gtm." key namespace for its own auto-events).
      "gtm.elementUrl",
    ]),
  };
}

/**
 * Best-effort, cross-vendor virtual-page/form-state metadata from one raw dataLayer push
 * entry -- see AnalyticsVirtualPageMetadata's own doc comment. Returns undefined when none
 * of the documented candidate keys are present, so its presence alone is meaningful
 * confirming evidence (VIRTUAL PAGE OR FORM STATE rule: confirmed independent of whether the
 * browser URL changed).
 */
export function extractAnalyticsVirtualPageMetadata(raw: Record<string, unknown>): AnalyticsVirtualPageMetadata | undefined {
  const virtualPageUrl = readStringField(raw, ["virtualpage_url", "virtualPageUrl", "virtualPagePath"]);
  const pageName = readStringField(raw, ["page_name", "pageName"]);
  const pageCategory = readStringField(raw, ["page_category", "pageCategory"]);
  const formName = readStringField(raw, ["form_name", "formName"]);
  const stepName = readStringField(raw, ["step_name", "stepName"]);
  const stepNumberRaw = raw["step_number"] ?? raw["stepNumber"];
  const stepNumber =
    typeof stepNumberRaw === "string" || typeof stepNumberRaw === "number" ? stepNumberRaw : undefined;

  if (!virtualPageUrl && !pageName && !pageCategory && !formName && !stepName && stepNumber === undefined) {
    return undefined;
  }
  return {
    ...(virtualPageUrl ? { virtualPageUrl } : {}),
    ...(pageName ? { pageName } : {}),
    ...(pageCategory ? { pageCategory } : {}),
    ...(formName ? { formName } : {}),
    ...(stepName ? { stepName } : {}),
    ...(stepNumber !== undefined ? { stepNumber } : {}),
  };
}

/** Whether virtual-page metadata is itself a virtual-page identity (vs. a form/configurator step identity) -- picks VIRTUAL_PAGE_CHANGE over FORM_OR_CONFIGURATOR_STATE when both kinds of field happen to be present on the same push. */
function isVirtualPageIdentity(metadata: AnalyticsVirtualPageMetadata): boolean {
  return Boolean(metadata.virtualPageUrl || metadata.pageName || metadata.pageCategory);
}

/** GA4 Enhanced Measurement's own standard outbound-click parameters (link_id/link_classes), and cross-vendor dataLayer equivalents -- a *direct*, mechanical tie to a specific clicked control, independent of whether its value happens to textually match the control's own accessible name/text. */
const CTA_IDENTIFIER_KEYS = ["cta", "cta_id", "ctaId", "link_id", "linkId", "link_classes", "linkClasses", "element_id", "elementId"];
/**
 * Cross-vendor text-ish fields naming the clicked control's own label -- compared against the
 * actually-clicked element's ctaText/accessibleName for a genuine label/accessibility-name
 * match. Includes both Universal-Analytics-style "eventLabel"/"event_label" (still the
 * standard label field for many GTM custom-event tags) and Google Tag Manager's own built-in
 * Link Click auto-event variable "gtm.elementText" -- vendor-neutral, not brand-specific.
 */
const CTA_TEXT_KEYS = [
  "ctaText",
  "cta_text",
  "link_text",
  "linkText",
  "label",
  "button_text",
  "buttonText",
  "eventLabel",
  "event_label",
  "gtm.elementText",
];
/** Cross-vendor "what kind of interaction was this" fields -- used only for click-richness scoring (see clickRichnessScore), never as an independent CLICK_EVENT classification signal on their own: a bare interaction-sounding word in an event's name/category/action is never sufficient by itself (see classifyEvidenceItem's own doc comment). */
const EVENT_CATEGORY_KEYS = ["eventCategory", "event_category"];
const EVENT_ACTION_KEYS = ["eventAction", "event_action"];
/**
 * GA4/GTM's own reserved, vendor-neutral interaction event names -- generic, not brand-specific
 * (GA4 Enhanced Measurement's own "click" outbound-click event, and Google Tag Manager's own
 * built-in Link Click/Form Submission/Click auto-event trigger names, all in GTM's reserved
 * "gtm." key namespace).
 */
const INTERACTION_EVENT_NAMES = new Set(["click", "outbound_click", "gtm.linkclick", "gtm.formsubmit", "gtm.click"]);

/** GA4/gtag-standard page-load event names -- generic, not brand-specific. An event carrying page_location/full_url is only page-change evidence when it either has no event-name identity of its own (an implicit/default hit) or is explicitly one of these. */
const PAGE_VIEW_EVENT_NAMES = new Set(["page_view", "pageview"]);

function normalizeForComparison(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

/** A genuine label/accessibility-name match between an analytics-emitted text field and the actually-clicked element's own ctaText/accessibleName -- never a bare "some text field exists" check. */
function ctaLabelMatches(candidate: string | undefined, ctaText?: string, ctaAccessibleName?: string): boolean {
  if (!candidate) {
    return false;
  }
  const normalizedCandidate = normalizeForComparison(candidate);
  if (!normalizedCandidate) {
    return false;
  }
  for (const target of [ctaText, ctaAccessibleName]) {
    if (!target) {
      continue;
    }
    const normalizedTarget = normalizeForComparison(target);
    if (!normalizedTarget) {
      continue;
    }
    if (normalizedCandidate === normalizedTarget || normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
      return true;
    }
  }
  return false;
}

interface Ga4EvidenceFields {
  location?: string;
  eventDestinationUrl?: string;
  ctaIdentifierPresent: boolean;
  ctaLabelMatch: boolean;
  isInteractionEvent: boolean;
  eventName?: string;
  eventCategory?: string;
  eventAction?: string;
  virtualMetadata?: AnalyticsVirtualPageMetadata;
}

function readGa4EvidenceFields(event: Ga4NetworkEventCapture, ctaText?: string, ctaAccessibleName?: string): Ga4EvidenceFields {
  const bodies: Record<string, string>[] = [event.params ?? {}, ...(event.postDataParams ?? [])];
  let ctaIdentifierPresent = false;
  let ctaLabelMatch = false;
  let eventCategory: string | undefined;
  let eventAction: string | undefined;
  let virtualMetadata: AnalyticsVirtualPageMetadata | undefined;
  for (const body of bodies) {
    if (!ctaIdentifierPresent && CTA_IDENTIFIER_KEYS.some((key) => typeof body[key] === "string" && body[key].length > 0)) {
      ctaIdentifierPresent = true;
    }
    if (!ctaLabelMatch) {
      const labelValue = CTA_TEXT_KEYS.map((key) => body[key]).find((v) => typeof v === "string" && v.length > 0);
      if (ctaLabelMatches(labelValue, ctaText, ctaAccessibleName)) {
        ctaLabelMatch = true;
      }
    }
    eventCategory ??= readStringField(body, EVENT_CATEGORY_KEYS);
    eventAction ??= readStringField(body, EVENT_ACTION_KEYS);
    if (!virtualMetadata) {
      virtualMetadata = extractAnalyticsVirtualPageMetadata(body);
    }
  }
  const eventName = event.params?.en ?? event.postDataParams?.find((body) => body.en)?.en;
  return {
    location: extractGa4PageLocation(event),
    eventDestinationUrl: extractAnalyticsEventDestinationUrl(event),
    ctaIdentifierPresent,
    ctaLabelMatch,
    isInteractionEvent: eventName ? INTERACTION_EVENT_NAMES.has(eventName.toLowerCase()) : false,
    eventName,
    eventCategory,
    eventAction,
    virtualMetadata,
  };
}

interface DataLayerEvidenceFields {
  location?: string;
  fullUrl?: string;
  eventDestinationUrl?: string;
  ctaIdentifierPresent: boolean;
  ctaLabelMatch: boolean;
  isInteractionEvent: boolean;
  eventName?: string;
  eventCategory?: string;
  eventAction?: string;
  virtualMetadata?: AnalyticsVirtualPageMetadata;
}

function readDataLayerEvidenceFields(entry: DataLayerCapture, ctaText?: string, ctaAccessibleName?: string): DataLayerEvidenceFields {
  let location: string | undefined;
  let fullUrl: string | undefined;
  let eventDestinationUrl: string | undefined;
  let ctaIdentifierPresent = false;
  let ctaLabelMatch = false;
  let eventName: string | undefined;
  let eventCategory: string | undefined;
  let eventAction: string | undefined;
  let virtualMetadata: AnalyticsVirtualPageMetadata | undefined;

  for (const raw of entry.raw) {
    const fields = extractDataLayerPageLocationFields(raw);
    location ??= fields.pageLocation;
    fullUrl ??= fields.fullUrl;
    eventDestinationUrl ??= fields.eventDestinationUrl;
    if (!ctaIdentifierPresent && CTA_IDENTIFIER_KEYS.some((key) => typeof raw[key] === "string" && (raw[key] as string).length > 0)) {
      ctaIdentifierPresent = true;
    }
    if (!ctaLabelMatch) {
      const labelValue = readStringField(raw, CTA_TEXT_KEYS);
      if (ctaLabelMatches(labelValue, ctaText, ctaAccessibleName)) {
        ctaLabelMatch = true;
      }
    }
    const rawEventName = readStringField(raw, ["event"]);
    eventName ??= rawEventName;
    eventCategory ??= readStringField(raw, EVENT_CATEGORY_KEYS);
    eventAction ??= readStringField(raw, EVENT_ACTION_KEYS);
    if (!virtualMetadata) {
      virtualMetadata = extractAnalyticsVirtualPageMetadata(raw);
    }
  }

  const isInteractionEvent = eventName ? INTERACTION_EVENT_NAMES.has(eventName.toLowerCase()) : false;

  return {
    location,
    fullUrl,
    eventDestinationUrl,
    ctaIdentifierPresent,
    ctaLabelMatch,
    isInteractionEvent,
    eventName,
    eventCategory,
    eventAction,
    virtualMetadata,
  };
}

/** Known cross-vendor tracking/campaign/linker query parameters, stripped only when computing the diagnostic urlRelationship below -- never when preserving an original URL value. */
const TRACKING_PARAM_NAMES = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "gclid",
  "gclsrc",
  "dclid",
  "fbclid",
  "msclkid",
  "mc_eid",
  "mc_cid",
  "_ga",
  "_gl",
  "gad_source",
  "gad_campaignid",
  "igshid",
  "ttclid",
  "twclid",
  "yclid",
]);

function stripTrackingParams(url: URL): string {
  const params = new URLSearchParams(url.search);
  for (const key of Array.from(params.keys())) {
    if (TRACKING_PARAM_NAMES.has(key.toLowerCase())) {
      params.delete(key);
    }
  }
  const query = params.toString();
  return `${url.origin}${url.pathname}${query ? `?${query}` : ""}${url.hash}`;
}

/**
 * Diagnostic-only URL relationship (URL RELATIONSHIP rule): never a gate for confirming
 * analytics evidence -- see classifyActionAnalyticsCapture's own doc comment. `candidate` is
 * an analytics-emitted value (page_location/full_url/eventDestinationUrl); `target` is
 * ctaElementDestinationUrl or browserResultingUrl. Neither input is ever mutated or
 * normalised in place -- only this classification's own return value reflects stripping.
 */
export function computeUrlRelationship(candidate: string | undefined, target: string | undefined): UrlRelationship {
  if (!candidate || !target) {
    return "UNAVAILABLE";
  }
  if (candidate === target) {
    return "EXACT_MATCH";
  }

  let candidateUrl: URL | undefined;
  let targetUrl: URL | undefined;
  try {
    candidateUrl = new URL(candidate);
  } catch {
    candidateUrl = undefined;
  }
  try {
    targetUrl = new URL(target);
  } catch {
    targetUrl = undefined;
  }

  if (!candidateUrl || !targetUrl) {
    // At least one side isn't an absolute URL at all -- typically a virtual-page/form-state
    // identifier (e.g. a page_name or a virtualpage_url path fragment) rather than a real
    // browser-navigable location. Distinct from DIFFERENT_DESTINATION on purpose: a virtual
    // state naturally differs from a physical URL and must never be treated as evidence of
    // an unrelated destination (see the VIRTUAL PAGE OR FORM STATE rule).
    return "DIFFERENT_ANALYTICS_VIRTUAL_STATE";
  }

  const strippedCandidate = stripTrackingParams(candidateUrl);
  const strippedTarget = stripTrackingParams(targetUrl);
  if (strippedCandidate === strippedTarget) {
    return "TRACKING_PARAMETERS_ONLY_DIFFERENCE";
  }

  if (candidateUrl.origin === targetUrl.origin && candidateUrl.pathname === targetUrl.pathname) {
    return "SAME_PHYSICAL_PAGE";
  }

  return "DIFFERENT_DESTINATION";
}

/** Priority order used only to pick the single most-specific relationship to report when more than one target URL is available. */
const RELATIONSHIP_SPECIFICITY: UrlRelationship[] = [
  "EXACT_MATCH",
  "TRACKING_PARAMETERS_ONLY_DIFFERENCE",
  "SAME_PHYSICAL_PAGE",
  "DIFFERENT_ANALYTICS_VIRTUAL_STATE",
  "DIFFERENT_DESTINATION",
  "UNAVAILABLE",
];

function bestRelationship(candidate: string | undefined, targets: string[]): UrlRelationship {
  if (targets.length === 0) {
    return "UNAVAILABLE";
  }
  const relationships = targets.map((target) => computeUrlRelationship(candidate, target));
  return relationships.sort((a, b) => RELATIONSHIP_SPECIFICITY.indexOf(a) - RELATIONSHIP_SPECIFICITY.indexOf(b))[0] ?? "UNAVAILABLE";
}

/**
 * Confirmed-event safety: turns one piece of window-observed evidence into the specific
 * category it actually earned. Action-window ownership makes an event an *action candidate*
 * only -- it is never, by itself, enough to confirm a CTA tag or a destination-page tag; see
 * this function's own decision order below, which mirrors the CLICK EVENT / PHYSICAL PAGE
 * ANALYTICS / VIRTUAL PAGE OR FORM STATE rules exactly. Deliberately shape-based rather than
 * gated on the beforeMid/afterMid array position (core/loop.ts's ga4MidIndex/
 * dataLayerPushMidIndex): a same-tab navigation's destination-page script can run, and its
 * own analytics beacon land in `captures.*`, before this engine's own dispatchAction promise
 * resolves in Node -- an artifact of event-loop/network timing, not evidence about what the
 * tag actually is. beforeMid/afterMid is still used (in classifyActionAnalyticsCapture) to
 * label the reported triggerSegment, but is never itself a classification gate here.
 *
 * - VIRTUAL_PAGE_CHANGE / FORM_OR_CONFIGURATOR_STATE: emitted virtual-page/page/form/step/
 *   configurator metadata is present -- confirmed independent of URL, since this evidence
 *   class is defined by never needing one.
 * - CLICK_EVENT: the evidence carries at least one direct confirming signal of its own: an
 *   emitted destination URL (eventDestinationUrl/link_url), a direct CTA identifier field
 *   (link_id/link_classes/cta/...), a genuine CTA label/accessibility-name match, or a GA4/
 *   GTM reserved interaction event name (click/outbound_click). Being merely present in the
 *   window is never enough.
 * - PHYSICAL_PAGE_CHANGE: the evidence carries an emitted page-location/full-url value that
 *   isn't ruled a genuinely different destination against this action's own
 *   ctaElementDestinationUrl/browserResultingUrl, AND the event has no distinct event-name
 *   identity of its own other than an explicit page-load name (page_view/pageview) -- a named
 *   business event that merely carries ambient page-location context (e.g. a search/session
 *   event) is never promoted to PHYSICAL_PAGE_CHANGE on that field alone; it stays
 *   OTHER_MEANINGFUL_EVENT.
 * - Otherwise: a real page-location value that didn't qualify above (a genuinely different
 *   destination) is CORRELATION_UNRESOLVED (ambiguous -- could be this action's evidence, but
 *   not confirmed); an event with its own clear identity (an event/en name) but none of the
 *   above is a distinct OTHER_MEANINGFUL_EVENT that must never be silently promoted into this
 *   action's own tag; anything with neither is CORRELATION_UNRESOLVED.
 */
function classifyEvidenceItem(params: {
  location: string | undefined;
  eventDestinationUrl: string | undefined;
  ctaIdentifierPresent: boolean;
  ctaLabelMatch: boolean;
  isInteractionEvent: boolean;
  eventName: string | undefined;
  virtualMetadata: AnalyticsVirtualPageMetadata | undefined;
  targets: string[];
}): EvidenceClassification {
  if (params.virtualMetadata) {
    return isVirtualPageIdentity(params.virtualMetadata) ? "VIRTUAL_PAGE_CHANGE" : "FORM_OR_CONFIGURATOR_STATE";
  }

  if (params.eventDestinationUrl || params.ctaIdentifierPresent || params.ctaLabelMatch || params.isInteractionEvent) {
    return "CLICK_EVENT";
  }

  // PHYSICAL PAGE ANALYTICS rule: an event carrying a page_location/full_url-shaped field is
  // only page-change evidence when it either has no event-name identity of its own (an
  // implicit/default hit -- most real GA4 page-load requests omit "en" in this engine's own
  // fixtures) or is itself an explicit page-load event name (PAGE_VIEW_EVENT_NAMES). A distinct
  // named business event (e.g. a search/session event) that merely happens to carry ambient
  // page-location context alongside its own payload must never be promoted to
  // PHYSICAL_PAGE_CHANGE on the strength of that ambient field alone -- it keeps its own
  // identity as OTHER_MEANINGFUL_EVENT instead.
  const hasDistinctNonPageEventIdentity = Boolean(params.eventName) && !PAGE_VIEW_EVENT_NAMES.has(params.eventName!.toLowerCase());

  if (params.location && !hasDistinctNonPageEventIdentity) {
    const relationship = bestRelationship(params.location, params.targets);
    if (relationship !== "DIFFERENT_DESTINATION") {
      return "PHYSICAL_PAGE_CHANGE";
    }
  }

  if (hasDistinctNonPageEventIdentity) {
    return "OTHER_MEANINGFUL_EVENT";
  }

  if (params.location) {
    return "CORRELATION_UNRESOLVED";
  }
  return params.eventName ? "OTHER_MEANINGFUL_EVENT" : "CORRELATION_UNRESOLVED";
}

const CONFIRMING_CLASSIFICATIONS = new Set<EvidenceClassification>([
  "CLICK_EVENT",
  "PHYSICAL_PAGE_CHANGE",
  "VIRTUAL_PAGE_CHANGE",
  "FORM_OR_CONFIGURATOR_STATE",
]);

interface ClickRichnessFields {
  eventName?: string;
  eventCategory?: string;
  eventAction?: string;
  ctaLabelMatch: boolean;
  ctaIdentifierPresent: boolean;
  eventDestinationUrl?: string;
}

/** A Google Tag Manager built-in auto-event ("gtm."-namespaced) is always a generic, mechanical record of an interaction, never the richest available description of it -- see the "richest business event" rule. */
function isGenericGtmAutoEventName(eventName: string | undefined): boolean {
  return Boolean(eventName) && eventName!.toLowerCase().startsWith("gtm.");
}

function clickRichnessFieldsOf(item: ClassifiedEvidence, ctaText?: string, ctaAccessibleName?: string): ClickRichnessFields {
  if (item.ga4Event) {
    const fields = readGa4EvidenceFields(item.ga4Event, ctaText, ctaAccessibleName);
    return {
      eventName: fields.eventName,
      eventCategory: fields.eventCategory,
      eventAction: fields.eventAction,
      ctaLabelMatch: fields.ctaLabelMatch,
      ctaIdentifierPresent: fields.ctaIdentifierPresent,
      eventDestinationUrl: fields.eventDestinationUrl,
    };
  }
  if (item.dataLayerPush) {
    const fields = readDataLayerEvidenceFields(item.dataLayerPush, ctaText, ctaAccessibleName);
    return {
      eventName: fields.eventName,
      eventCategory: fields.eventCategory,
      eventAction: fields.eventAction,
      ctaLabelMatch: fields.ctaLabelMatch,
      ctaIdentifierPresent: fields.ctaIdentifierPresent,
      eventDestinationUrl: fields.eventDestinationUrl,
    };
  }
  return { ctaLabelMatch: false, ctaIdentifierPresent: false };
}

/**
 * Ranks how much this one CLICK_EVENT-classified record actually describes the click, so that
 * when several records describe the same physical click (e.g. a rich business event alongside
 * a generic GTM auto-event trigger) the richest one is reported as the primary click, never a
 * generic GTM click record. Emitted business fields (event name, category, action, a genuine
 * CTA label match, a direct CTA identifier, an emitted destination URL) each add to the score;
 * a bare "gtm."-namespaced auto-event name is never preferred over a named business event with
 * the same fields.
 */
function clickRichnessScore(fields: ClickRichnessFields): number {
  let score = isGenericGtmAutoEventName(fields.eventName) ? 0 : 10;
  if (fields.eventCategory) score += 1;
  if (fields.eventAction) score += 1;
  if (fields.ctaLabelMatch) score += 1;
  if (fields.ctaIdentifierPresent) score += 1;
  if (fields.eventDestinationUrl) score += 1;
  return score;
}

/**
 * True when two or more CLICK_EVENT-classified records in the same action's window name
 * genuinely different, incompatible destinations -- e.g. two distinct business events each
 * pointing at a different CTA -- rather than several records (a rich business event plus a
 * generic GTM auto-event trigger) describing the very same physical click. A genuine conflict
 * means no single record can be safely reported as *the* primary click; see
 * PrimaryClickEventStatus's own CORRELATION_UNRESOLVED value.
 */
function clickEvidenceConflicts(items: ClassifiedEvidence[], ctaText?: string, ctaAccessibleName?: string): boolean {
  const destinations = items
    .map((item) => clickRichnessFieldsOf(item, ctaText, ctaAccessibleName).eventDestinationUrl)
    .filter((url): url is string => Boolean(url));
  for (let i = 0; i < destinations.length; i++) {
    for (let j = i + 1; j < destinations.length; j++) {
      if (computeUrlRelationship(destinations[i], destinations[j]) === "DIFFERENT_DESTINATION") {
        return true;
      }
    }
  }
  return false;
}

export interface AnalyticsCaptureResult {
  status: AnalyticsCaptureStatus;
  classificationReason: string;
  /** Every GA4 request and dataLayer push observed in this action's own window, each tagged with the specific category it earned -- see EvidenceClassification. The authoritative, auditable record of this action's own confirmed-event-safety decisions. */
  classifiedEvidence: ClassifiedEvidence[];
  /** GA4 requests classified CLICK_EVENT/PHYSICAL_PAGE_CHANGE/VIRTUAL_PAGE_CHANGE/FORM_OR_CONFIGURATOR_STATE -- see classifyEvidenceItem. Window/segment ownership alone is never sufficient. */
  confirmedGa4Events: Ga4NetworkEventCapture[];
  /** GA4 requests classified OTHER_MEANINGFUL_EVENT or CORRELATION_UNRESOLVED -- not confirmed as this action's own evidence. */
  unresolvedGa4Candidates: Ga4NetworkEventCapture[];
  /** dataLayer pushes (from the real-time push-observer stream, not the before/after diff) classified as confirming this action. */
  confirmedDataLayerPushes: DataLayerCapture[];
  unresolvedDataLayerPushes: DataLayerCapture[];
  measurementIds: string[];
  consent: ConsentStorageEvidence & { required: boolean; verified: boolean };
  /** The clicked CTA element's own href/destination, unchanged -- see CtaClickCapture.destinationUrl. Supporting/diagnostic context, never analytics evidence itself. */
  ctaElementDestinationUrl?: string;
  /** GA4 Enhanced Measurement link_url (or a dataLayer push's own eventDestinationUrl-shaped field) from the first confirmed evidence that carries one -- the destination URL the analytics event itself emitted for this click. */
  analyticsEventDestinationUrl?: string;
  /** GA4's own `dl` / a dataLayer push's own page_location field, verbatim -- never overwritten by browserResultingUrl. */
  analyticsPageLocation?: string;
  /** A dataLayer push's own full_url-shaped field, verbatim -- never overwritten by browserResultingUrl. */
  analyticsFullUrl?: string;
  /** A dataLayer push's own virtualpage_url-shaped field, verbatim -- confirms a virtual/SPA destination even when the browser URL never changes. */
  analyticsVirtualPageUrl?: string;
  /** Companion page_name/page_category/form_name/step_name/step_number metadata, when any of it was present alongside analyticsVirtualPageUrl (or on its own). */
  analyticsVirtualPageMetadata?: AnalyticsVirtualPageMetadata;
  /** The tracked page's actual resulting URL after this action -- unchanged, see ActionResult.resultingUrl. Supporting navigation/diagnostic evidence only, never a gate. */
  browserResultingUrl?: string;
  /** Diagnostic-only relationship between the analytics-emitted location and the browser/CTA URLs -- see computeUrlRelationship. Never used to gate confirmation. */
  urlRelationship?: UrlRelationship;
  /** Which phase of this action produced the primary confirming evidence -- see TriggerSegment. Absent when no evidence confirmed this action at all. */
  triggerSegment?: TriggerSegment;
  /**
   * The dedicated-click-tag outcome for this action, distinct from the overall `status` above:
   * `status` can be CAPTURED purely from associated page/virtual-state evidence while this
   * field is WEBSITE_NO_OBSERVED_CLICK_TAG -- see PrimaryClickEventStatus. Always populated.
   */
  primaryClickEventStatus: PrimaryClickEventStatus;
  /** The single richest CLICK_EVENT-classified record for this action (see clickRichnessScore) -- present only when primaryClickEventStatus is CAPTURED. */
  primaryClickEvent?: ClassifiedEvidence;
  /** Every other CLICK_EVENT-classified record describing the same physical click as primaryClickEvent (e.g. a generic GTM auto-event trigger alongside the richer business event) -- never a second primary. */
  supportingEvidence: ClassifiedEvidence[];
  /** Confirmed non-click evidence for this action (PHYSICAL_PAGE_CHANGE/VIRTUAL_PAGE_CHANGE/FORM_OR_CONFIGURATOR_STATE) -- present independently of whether a dedicated click tag was ever observed. */
  associatedEvents: ClassifiedEvidence[];
  /** CORRELATION_UNRESOLVED-classified records for this action -- genuinely ambiguous candidates, never silently folded into either primaryClickEvent or associatedEvents. */
  unresolvedCandidates: ClassifiedEvidence[];
}

/** Per-item version of the action-level triggerSegment rule below -- computed once per GA4 event/dataLayer push so every item in classifiedEvidence carries its own segment, never left blank for a caller to infer downstream. */
function computeItemTriggerSegment(params: { isBeforeMid: boolean; openedNewContext?: boolean; fallbackVerified?: boolean }): TriggerSegment {
  if (params.openedNewContext) {
    return "POPUP_OR_NEW_TAB";
  }
  if (params.isBeforeMid) {
    return "PHYSICAL_CLICK";
  }
  return params.fallbackVerified !== undefined ? "FALLBACK_NAVIGATION" : "DESTINATION_SETTLEMENT";
}

export function classifyActionAnalyticsCapture(params: {
  /** The clicked CTA element's own href/destination -- see CtaClickCapture.destinationUrl. Never a confirmation gate (see this module's own doc comment). */
  ctaElementDestinationUrl?: string;
  /** The tracked page's actual resulting URL after this action -- see ActionResult.resultingUrl. Never a confirmation gate. */
  browserResultingUrl?: string;
  /** The clicked element's own text/accessible name -- used only for a genuine CTA label/accessibility-name match (see classifyEvidenceItem), never for a confirmation gate on its own. */
  ctaText?: string;
  ctaAccessibleName?: string;
  dataLayerReplaced: boolean;
  dataLayerHasNewEntries: boolean;
  /** Every GA4/dataLayer-push event observed in this action's own capture window, in chronological order. */
  ga4EventsInWindow: Ga4NetworkEventCapture[];
  dataLayerPushesInWindow: DataLayerCapture[];
  /** The subset of ga4EventsInWindow/dataLayerPushesInWindow observed before actionResult resolved (during physical dispatch) -- see core/loop.ts's ga4MidIndex/dataLayerPushMidIndex. Reference-equal to elements of the *InWindow arrays, never a copy. */
  ga4EventsBeforeMid: Ga4NetworkEventCapture[];
  dataLayerPushesBeforeMid: DataLayerCapture[];
  /** Mirrors ActionResult.fallbackVerified -- present (defined, true or false) only when the generic destinationUrl fallback was used. Distinguishes FALLBACK_NAVIGATION from ordinary DESTINATION_SETTLEMENT for evidence observed after actionResult resolved. */
  fallbackVerified?: boolean;
  /** Mirrors ActionResult.openedNewContext -- when true, this action's own triggerSegment is POPUP_OR_NEW_TAB regardless of window timing. */
  openedNewContext?: boolean;
  captureHealth: CaptureHealth;
  consentRequired: boolean;
  consentEvidence: ConsentStorageEvidence;
}): AnalyticsCaptureResult {
  const targets = [params.ctaElementDestinationUrl, params.browserResultingUrl].filter((u): u is string => Boolean(u));
  const beforeMidGa4 = new Set(params.ga4EventsBeforeMid);
  const beforeMidDataLayer = new Set(params.dataLayerPushesBeforeMid);

  const classifiedEvidence: ClassifiedEvidence[] = [];
  const confirmedGa4Events: Ga4NetworkEventCapture[] = [];
  const unresolvedGa4Candidates: Ga4NetworkEventCapture[] = [];
  for (const event of params.ga4EventsInWindow) {
    const fields = readGa4EvidenceFields(event, params.ctaText, params.ctaAccessibleName);
    const classification = classifyEvidenceItem({
      location: fields.location,
      eventDestinationUrl: fields.eventDestinationUrl,
      ctaIdentifierPresent: fields.ctaIdentifierPresent,
      ctaLabelMatch: fields.ctaLabelMatch,
      isInteractionEvent: fields.isInteractionEvent,
      eventName: fields.eventName,
      virtualMetadata: fields.virtualMetadata,
      targets,
    });
    const itemTriggerSegment = computeItemTriggerSegment({
      isBeforeMid: beforeMidGa4.has(event),
      openedNewContext: params.openedNewContext,
      fallbackVerified: params.fallbackVerified,
    });
    classifiedEvidence.push({ classification, ga4Event: event, triggerSegment: itemTriggerSegment });
    (CONFIRMING_CLASSIFICATIONS.has(classification) ? confirmedGa4Events : unresolvedGa4Candidates).push(event);
  }

  const confirmedDataLayerPushes: DataLayerCapture[] = [];
  const unresolvedDataLayerPushes: DataLayerCapture[] = [];
  for (const entry of params.dataLayerPushesInWindow) {
    const fields = readDataLayerEvidenceFields(entry, params.ctaText, params.ctaAccessibleName);
    const classification = classifyEvidenceItem({
      location: fields.location ?? fields.fullUrl,
      eventDestinationUrl: fields.eventDestinationUrl,
      ctaIdentifierPresent: fields.ctaIdentifierPresent,
      ctaLabelMatch: fields.ctaLabelMatch,
      isInteractionEvent: fields.isInteractionEvent,
      eventName: fields.eventName,
      virtualMetadata: fields.virtualMetadata,
      targets,
    });
    const itemTriggerSegment = computeItemTriggerSegment({
      isBeforeMid: beforeMidDataLayer.has(entry),
      openedNewContext: params.openedNewContext,
      fallbackVerified: params.fallbackVerified,
    });
    classifiedEvidence.push({ classification, dataLayerPush: entry, triggerSegment: itemTriggerSegment });
    (CONFIRMING_CLASSIFICATIONS.has(classification) ? confirmedDataLayerPushes : unresolvedDataLayerPushes).push(entry);
  }

  const measurementIds = Array.from(
    new Set(params.ga4EventsInWindow.map((event) => event.measurementId).filter((id): id is string => Boolean(id))),
  );

  const consentVerified = !params.consentRequired || params.consentEvidence.analyticsStorageGranted === true;
  const consent = { ...params.consentEvidence, required: params.consentRequired, verified: consentVerified };

  // Primary analytics-evidence extraction (URL RELATIONSHIP / SCHEMA rules): the first
  // *confirmed* event/push carrying each field wins, in chronological window order -- never
  // an inference, never a value invented beyond what was actually emitted, and never sourced
  // from an item that failed confirmed-event-safety classification above.
  let analyticsEventDestinationUrl: string | undefined;
  let analyticsPageLocation: string | undefined;
  let analyticsFullUrl: string | undefined;
  let analyticsVirtualPageUrl: string | undefined;
  let analyticsVirtualPageMetadata: AnalyticsVirtualPageMetadata | undefined;

  for (const event of confirmedGa4Events) {
    const fields = readGa4EvidenceFields(event, params.ctaText, params.ctaAccessibleName);
    analyticsPageLocation ??= fields.location;
    analyticsEventDestinationUrl ??= fields.eventDestinationUrl;
    if (fields.virtualMetadata && !analyticsVirtualPageMetadata) {
      analyticsVirtualPageMetadata = fields.virtualMetadata;
      analyticsVirtualPageUrl ??= fields.virtualMetadata.virtualPageUrl;
    }
  }
  for (const entry of confirmedDataLayerPushes) {
    const fields = readDataLayerEvidenceFields(entry, params.ctaText, params.ctaAccessibleName);
    analyticsPageLocation ??= fields.location;
    analyticsFullUrl ??= fields.fullUrl;
    analyticsEventDestinationUrl ??= fields.eventDestinationUrl;
    if (fields.virtualMetadata && !analyticsVirtualPageMetadata) {
      analyticsVirtualPageMetadata = fields.virtualMetadata;
      analyticsVirtualPageUrl ??= fields.virtualMetadata.virtualPageUrl;
    }
  }

  const urlRelationship = bestRelationship(analyticsPageLocation ?? analyticsFullUrl, targets);

  const confirmedEventCount =
    confirmedGa4Events.length + confirmedDataLayerPushes.length + (params.dataLayerHasNewEntries && !params.dataLayerReplaced ? 1 : 0);
  const unresolvedCandidateCount = unresolvedGa4Candidates.length + unresolvedDataLayerPushes.length;

  let triggerSegment: TriggerSegment | undefined;
  if (confirmedEventCount > 0) {
    if (params.openedNewContext) {
      triggerSegment = "POPUP_OR_NEW_TAB";
    } else {
      const hasBeforeMidEvidence =
        confirmedGa4Events.some((event) => beforeMidGa4.has(event)) ||
        confirmedDataLayerPushes.some((entry) => beforeMidDataLayer.has(entry));
      triggerSegment = hasBeforeMidEvidence
        ? "PHYSICAL_CLICK"
        : params.fallbackVerified !== undefined
          ? "FALLBACK_NAVIGATION"
          : "DESTINATION_SETTLEMENT";
    }
  }

  // Dedicated-click-tag resolution (PRIMARY CLICK EVENT rule): distinct from the action-level
  // status above -- see PrimaryClickEventStatus's own doc comment. Never gated on whether
  // associated page/virtual-state evidence was also observed.
  const clickEvidenceItems = classifiedEvidence.filter((item) => item.classification === "CLICK_EVENT");
  const associatedEvents = classifiedEvidence.filter(
    (item) => item.classification === "PHYSICAL_PAGE_CHANGE" || item.classification === "VIRTUAL_PAGE_CHANGE" || item.classification === "FORM_OR_CONFIGURATOR_STATE",
  );
  const unresolvedCandidates = classifiedEvidence.filter((item) => item.classification === "CORRELATION_UNRESOLVED");

  let primaryClickEvent: ClassifiedEvidence | undefined;
  let supportingEvidence: ClassifiedEvidence[] = [];
  let primaryClickEventStatus: PrimaryClickEventStatus;

  if (params.consentRequired && !consentVerified) {
    primaryClickEventStatus = "CAPTURE_UNCERTAIN_CONSENT_STATE";
  } else if (!params.captureHealth.captureComplete) {
    primaryClickEventStatus = "ENGINE_CAPTURE_INCOMPLETE";
  } else if (clickEvidenceItems.length > 0) {
    if (clickEvidenceConflicts(clickEvidenceItems, params.ctaText, params.ctaAccessibleName)) {
      // Genuinely different, incompatible destinations among the click candidates -- never
      // arbitrarily pick one as primary (rule: "do not create two primary click events").
      primaryClickEventStatus = "CORRELATION_UNRESOLVED";
      supportingEvidence = clickEvidenceItems;
    } else {
      let bestScore = -Infinity;
      for (const item of clickEvidenceItems) {
        const score = clickRichnessScore(clickRichnessFieldsOf(item, params.ctaText, params.ctaAccessibleName));
        if (score > bestScore) {
          bestScore = score;
          primaryClickEvent = item;
        }
      }
      supportingEvidence = clickEvidenceItems.filter((item) => item !== primaryClickEvent);
      primaryClickEventStatus = "CAPTURED";
    }
  } else if (unresolvedCandidates.length > 0) {
    // No dedicated click record confirmed, but a genuinely ambiguous candidate exists -- keep
    // this distinct from "no dedicated tag was ever emitted" (WEBSITE_NO_OBSERVED_CLICK_TAG).
    primaryClickEventStatus = "CORRELATION_UNRESOLVED";
  } else {
    // No dedicated click record and nothing ambiguous either: associated page/virtual-state
    // evidence (if any) is unaffected -- this action's overall status is never downgraded to
    // CORRELATION_UNRESOLVED merely because no dedicated click tag exists.
    primaryClickEventStatus = "WEBSITE_NO_OBSERVED_CLICK_TAG";
  }

  const sharedFields = {
    classifiedEvidence,
    confirmedGa4Events,
    unresolvedGa4Candidates,
    confirmedDataLayerPushes,
    unresolvedDataLayerPushes,
    measurementIds,
    consent,
    ...(params.ctaElementDestinationUrl ? { ctaElementDestinationUrl: params.ctaElementDestinationUrl } : {}),
    ...(analyticsEventDestinationUrl ? { analyticsEventDestinationUrl } : {}),
    ...(analyticsPageLocation ? { analyticsPageLocation } : {}),
    ...(analyticsFullUrl ? { analyticsFullUrl } : {}),
    ...(analyticsVirtualPageUrl ? { analyticsVirtualPageUrl } : {}),
    ...(analyticsVirtualPageMetadata ? { analyticsVirtualPageMetadata } : {}),
    ...(params.browserResultingUrl ? { browserResultingUrl: params.browserResultingUrl } : {}),
    ...(urlRelationship ? { urlRelationship } : {}),
    ...(triggerSegment ? { triggerSegment } : {}),
    primaryClickEventStatus,
    ...(primaryClickEvent ? { primaryClickEvent } : {}),
    supportingEvidence,
    associatedEvents,
    unresolvedCandidates,
  };

  if (params.consentRequired && !consentVerified) {
    return {
      status: "CAPTURE_UNCERTAIN_CONSENT_STATE",
      classificationReason:
        "consentInteractionPolicy requires optional consent to be accepted, but no analytics_storage=granted evidence was observed for this run before this action",
      ...sharedFields,
    };
  }

  if (!params.captureHealth.captureComplete) {
    return {
      status: "ENGINE_CAPTURE_INCOMPLETE",
      classificationReason: params.captureHealth.issues.join("; "),
      ...sharedFields,
    };
  }

  if (unresolvedCandidateCount > 0 && confirmedEventCount === 0) {
    return {
      status: "CORRELATION_UNRESOLVED",
      classificationReason:
        "analytics evidence exists inside this action's capture window, but none of it earned a CLICK_EVENT/PHYSICAL_PAGE_CHANGE/VIRTUAL_PAGE_CHANGE/FORM_OR_CONFIGURATOR_STATE classification (window/segment ownership alone is never sufficient) -- it cannot be safely assigned",
      ...sharedFields,
    };
  }

  if (confirmedEventCount === 0 && unresolvedCandidateCount === 0) {
    return {
      status: "WEBSITE_NO_OBSERVED_TAG",
      classificationReason: "capture was healthy and complete for this action's window, and no analytics evidence was observed at all",
      ...sharedFields,
    };
  }

  return {
    status: "CAPTURED",
    classificationReason:
      "analytics evidence observed in this action's own capture window earned a specific confirming classification (CLICK_EVENT/PHYSICAL_PAGE_CHANGE/VIRTUAL_PAGE_CHANGE/FORM_OR_CONFIGURATOR_STATE), never merely by being observed inside the window",
    ...sharedFields,
  };
}
