import { createHash } from "node:crypto";
import type {
  ActionAnalytics,
  AnalyticsCaptureStatus,
  AnalyticsVirtualPageMetadata,
  ClassifiedEvidence,
  CtaClickCapture,
  DataLayerCapture,
  EvidenceCaptureSource,
  EvidenceClassification,
  Ga4NetworkEventCapture,
  PageVisitCapture,
  PrimaryClickEventStatus,
  TriggerSegment,
  UrlRelationship,
} from "../types/task-response.js";
import {
  bestRelationship,
  classifyEvidenceItem,
  clickRichnessScore,
  computeUrlRelationship,
  readDataLayerEvidenceFields,
  readGa4EvidenceFields,
  readStringField,
} from "./analyticsCaptureClassification.js";

/**
 * Engine-owned analytics reporting contract (see the coordinator's own migration document,
 * docs/n8n-analytics-reporting-migration.md): this module is the single place that finalises
 * correlation, classification, canonicalisation, deduplication, and event roles for every run
 * -- n8n consumes analyticsReportingRows[] directly and must never reconstruct, re-classify, or
 * deduplicate analytics evidence itself again. Deliberately reuses
 * capture-modules/analyticsCaptureClassification.ts's own classification decision
 * (classifyEvidenceItem) and its already-computed per-action ownership/triggerSegment -- this
 * module only adds what that coarser, per-whole-capture classifier structurally cannot do:
 * expanding a bundled dataLayer push into its own distinct logical events (see "DATA-LAYER
 * BUNDLES" below) and producing a stable, canonical eventId per distinct event.
 */

export type ReportingRecordType = "START_PAGE" | "CTA_CLICK" | "ANALYTICS_EVENT";

export type ReportingEventRole =
  | "START_PAGE"
  | "PRIMARY_CLICK"
  | "CLICK_CANDIDATE"
  | "ASSOCIATED_RESULT"
  | "RAW_CAPTURE_IN_ACTION_WINDOW";

export type ReportingCorrelationStatus = "NOT_APPLICABLE" | "CONFIRMED" | "UNRESOLVED" | "WEBSITE_NO_OBSERVED_TAG";

/**
 * EvidenceClassification widened with two reporting-only values: JOURNEY_MARKER (the
 * START_PAGE row, never a captured analytics event) and UNCLASSIFIED_RAW_CAPTURE, a defensive
 * fallback for a raw entry with no classification at all -- structurally unreachable today
 * (classifyEvidenceItem always returns one of EvidenceClassification's six values), kept for
 * the same reason MilestoneEvidenceRecord.evidenceTier keeps its own unreachable "assumed"
 * value: so absence is auditable from the type itself rather than merely asserted.
 */
export type ReportingEventClassification = EvidenceClassification | "JOURNEY_MARKER" | "UNCLASSIFIED_RAW_CAPTURE";

/** Short, closed, generic vocabulary explaining how correlationStatus was derived -- never a per-brand/vendor value. */
export type ReportingCorrelationSource =
  | "engine_journey_marker"
  | "engine_confirmed_primary_click"
  | "engine_click_candidate"
  | "engine_capture_gate"
  | "engine_no_observed_click_tag"
  | "engine_confirmed_associated_event"
  | "engine_action_window_raw_capture";

export interface AnalyticsReportingRow {
  runId: string;
  taskId: string;
  schemaVersion: string;
  journeyType?: string;
  /** Assigned only after final ordering and deduplication -- 1-based, continuous across the whole run. */
  journeySequence: number;
  recordType: ReportingRecordType;
  actionId?: string;
  /** Stable, deterministic identity for one distinct captured analytics event -- see computeEventId below. Absent for START_PAGE and for a CTA_CLICK row with no confirmed primary click. */
  eventId?: string;
  stepIndex: number;
  timestamp: string;
  ctaText?: string;
  sourcePageUrl?: string;
  ctaElementDestinationUrl?: string;
  browserResultingUrl?: string;
  destinationPageTitle?: string;
  actionSuccessful?: boolean;
  navigationSuccessful?: boolean;
  milestoneIdsCompleted?: string[];
  journeyRelevant?: boolean;
  analyticsCaptureStatus?: AnalyticsCaptureStatus;
  primaryClickTagStatus?: PrimaryClickEventStatus;
  captureComplete?: boolean;
  captureIssues?: string[];
  eventRole: ReportingEventRole;
  eventClassification: ReportingEventClassification;
  correlationStatus: ReportingCorrelationStatus;
  triggerSegment?: TriggerSegment;
  evidenceSource?: EvidenceCaptureSource;
  eventName?: string;
  eventCategory?: string;
  eventAction?: string;
  eventLabel?: string;
  analyticsEventDestinationUrl?: string;
  analyticsPageLocation?: string;
  analyticsReferrer?: string;
  analyticsFullUrl?: string;
  analyticsVirtualPageUrl?: string;
  pageTitle?: string;
  pageName?: string;
  pageCategory?: string;
  pageType?: string;
  componentId?: string;
  formName?: string;
  formCategory?: string;
  formType?: string;
  stepName?: string;
  stepNumber?: string | number;
  vehicleYear?: string;
  measurementId?: string;
  collectionEndpoint?: string;
  contextId?: string;
  urlRelationship?: UrlRelationship;
  correlationSource?: ReportingCorrelationSource;
  classificationReason?: string;
  rawEvidenceJson?: string;
}

// ---------------------------------------------------------------------------------------------
// Canonicalisation and stable event identity
// ---------------------------------------------------------------------------------------------

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

/**
 * Deterministic, non-reversible identity for one distinct captured analytics event -- never
 * the raw payload text itself (see rawEvidenceJson for that). Every field that participates in
 * an event's identity is nested inside `identity` and the whole object is canonicalised
 * (recursive key sort, array order preserved) before hashing, so two identity objects that
 * differ only in property order hash identically.
 */
function computeEventId(identity: Record<string, unknown>): string {
  const hash = createHash("sha256").update(stableStringify(identity)).digest("hex");
  return `evt_${hash.slice(0, 24)}`;
}

/**
 * A single raw dataLayer.push() argument may itself be an array wrapping exactly one event
 * object (some tag-management libraries push `[event]` rather than `event` directly) -- this
 * unwraps that one specific shape so raw:[event] and raw:event canonicalise identically. A
 * multi-element array is never unwrapped here; see flattenDataLayerCapture, which expands a
 * genuine multi-entry array into its own distinct entries instead.
 */
function unwrapSingleElementArray(value: unknown): unknown {
  if (Array.isArray(value) && value.length === 1 && isPlainObject(value[0])) {
    return value[0];
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface FlattenedDataLayerEntry {
  raw: Record<string, unknown>;
  rawEntryIndex: number;
  rawEntryCount: number;
}

/**
 * DATA-LAYER BUNDLES: one DataLayerCapture.raw[] element is either a single event object, or an
 * array -- either wrapping exactly one event (unwrapped, see unwrapSingleElementArray) or
 * genuinely holding several independent events pushed together in one dataLayer.push() call
 * (expanded here into its own distinct entries, each with its own rawEntryIndex). Flat indexing
 * runs across the whole capture.raw array (not nested per top-level element), so the common
 * case -- one push call per raw[] element -- gives rawEntryIndex values matching raw[]'s own
 * position exactly.
 */
function flattenDataLayerCapture(capture: DataLayerCapture): FlattenedDataLayerEntry[] {
  const flat: Record<string, unknown>[] = [];
  for (const element of capture.raw as unknown[]) {
    const unwrapped = unwrapSingleElementArray(element);
    if (Array.isArray(unwrapped)) {
      for (const sub of unwrapped) {
        if (isPlainObject(sub)) {
          flat.push(sub);
        }
      }
    } else if (isPlainObject(unwrapped)) {
      flat.push(unwrapped);
    }
  }
  const rawEntryCount = flat.length;
  return flat.map((raw, rawEntryIndex) => ({ raw, rawEntryIndex, rawEntryCount }));
}

// ---------------------------------------------------------------------------------------------
// Field extraction: classification-critical fields (location, destination URL, CTA
// identity, virtual-page metadata, event name/category/action) are read exclusively via
// analyticsCaptureClassification.ts's own readGa4EvidenceFields/readDataLayerEvidenceFields --
// never a second, hand-maintained alias list -- so this module's classification can never
// drift from the engine's existing classification. A parallel alias list here previously
// missed several of that module's own aliases (e.g. destination_url/click_url/outbound_url
// for a dataLayer event's own link-destination field), silently misclassifying real click
// evidence as CORRELATION_UNRESOLVED. Only genuinely new, reporting-only fields the old
// module has no concept of (referrer, page title/type, component id, form category/type,
// vehicle year, measurement id, a display copy of the CTA-label text) get their own narrow
// alias list below.
// ---------------------------------------------------------------------------------------------

const REFERRER_ALIASES = ["pageReferrer", "page_referrer", "pageLatestReferrer", "analyticsReferrer", "dr"];
const PAGE_TITLE_ALIASES = ["pageTitle", "page_title"];
const PAGE_TYPE_ALIASES = ["pageType", "page_type"];
const COMPONENT_ID_ALIASES = ["componentId", "component_id", "eventComponent", "dataGtmEventComponent"];
const FORM_CATEGORY_ALIASES = ["formCategory", "form_category"];
const FORM_TYPE_ALIASES = ["formType", "form_type"];
const VEHICLE_YEAR_ALIASES = ["vehicleYear", "vehicle_year", "displayedVehicleYear"];
const MEASUREMENT_ID_ALIASES = ["measurementId", "measurement_id", "tid"];
const EVENT_LABEL_ALIASES = ["eventLabel", "event_label", "el", "gtm.elementText"];

interface GenericAnalyticsFields {
  pageLocation?: string;
  referrer?: string;
  fullUrl?: string;
  virtualPageUrl?: string;
  pageTitle?: string;
  pageName?: string;
  pageCategory?: string;
  pageType?: string;
  componentId?: string;
  formName?: string;
  formCategory?: string;
  formType?: string;
  stepName?: string;
  stepNumber?: string | number;
  vehicleYear?: string;
  measurementId?: string;
  eventDestinationUrl?: string;
  eventName?: string;
  eventCategory?: string;
  eventAction?: string;
  eventLabel?: string;
}

interface SupplementaryFields {
  referrer?: string;
  pageTitle?: string;
  pageType?: string;
  componentId?: string;
  formCategory?: string;
  formType?: string;
  vehicleYear?: string;
  measurementId?: string;
  eventLabel?: string;
}

/** The reporting-only fields old module has no concept of -- see this section's own doc comment. Never invents a value beyond an exact alias-key match. */
function readSupplementaryFields(raw: Record<string, unknown>): SupplementaryFields {
  return {
    referrer: readStringField(raw, REFERRER_ALIASES),
    pageTitle: readStringField(raw, PAGE_TITLE_ALIASES),
    pageType: readStringField(raw, PAGE_TYPE_ALIASES),
    componentId: readStringField(raw, COMPONENT_ID_ALIASES),
    formCategory: readStringField(raw, FORM_CATEGORY_ALIASES),
    formType: readStringField(raw, FORM_TYPE_ALIASES),
    vehicleYear: readStringField(raw, VEHICLE_YEAR_ALIASES),
    measurementId: readStringField(raw, MEASUREMENT_ID_ALIASES),
    eventLabel: readStringField(raw, EVENT_LABEL_ALIASES),
  };
}

/**
 * Merges the old module's authoritative classification-critical fields (location, fullUrl,
 * eventDestinationUrl, virtualMetadata, eventName/Category/Action) with this module's own
 * reporting-only supplementary fields into one row-shaped field set.
 */
function combineFields(
  classFields: {
    location?: string;
    eventDestinationUrl?: string;
    eventName?: string;
    eventCategory?: string;
    eventAction?: string;
    virtualMetadata?: AnalyticsVirtualPageMetadata;
  },
  fullUrl: string | undefined,
  supplementary: SupplementaryFields,
): GenericAnalyticsFields {
  const vm = classFields.virtualMetadata;
  return {
    pageLocation: classFields.location,
    referrer: supplementary.referrer,
    fullUrl,
    virtualPageUrl: vm?.virtualPageUrl,
    pageTitle: supplementary.pageTitle,
    pageName: vm?.pageName,
    pageCategory: vm?.pageCategory,
    pageType: supplementary.pageType,
    componentId: supplementary.componentId,
    formName: vm?.formName,
    formCategory: supplementary.formCategory,
    formType: supplementary.formType,
    stepName: vm?.stepName,
    stepNumber: vm?.stepNumber,
    vehicleYear: supplementary.vehicleYear,
    measurementId: supplementary.measurementId,
    eventDestinationUrl: classFields.eventDestinationUrl,
    eventName: classFields.eventName,
    eventCategory: classFields.eventCategory,
    eventAction: classFields.eventAction,
    eventLabel: supplementary.eventLabel,
  };
}

function mergedGa4Params(event: Ga4NetworkEventCapture): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const body of [event.params ?? {}, ...(event.postDataParams ?? [])]) {
    for (const [key, value] of Object.entries(body)) {
      if (merged[key] === undefined) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function collectionEndpointOf(requestUrl: string): string | undefined {
  try {
    const url = new URL(requestUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Per-action evidence expansion and classification
// ---------------------------------------------------------------------------------------------

interface EvidenceEntry {
  eventId: string;
  classification: EvidenceClassification;
  evidenceSource: EvidenceCaptureSource;
  contextId?: string;
  stepIndex: number;
  timestamp: string;
  triggerSegment?: TriggerSegment;
  rawEntryIndex?: number;
  ctaIdentifierPresent: boolean;
  ctaLabelMatch: boolean;
  fields: GenericAnalyticsFields;
  urlRelationship?: UrlRelationship;
  collectionEndpoint?: string;
  rawEvidenceJson: string;
}

interface TriggerSegmentLookup {
  ga4: Map<Ga4NetworkEventCapture, TriggerSegment | undefined>;
  dataLayer: Map<DataLayerCapture, TriggerSegment | undefined>;
}

/**
 * Reuses the engine's own already-computed per-item triggerSegment (action ownership: which
 * phase of the action produced this evidence) from analyticsCaptureClassification.ts's
 * classifiedEvidence, keyed by object reference -- classifiedEvidence's ga4Event/dataLayerPush
 * are the very same array elements as ActionAnalytics.ga4RequestsObservedDuringActionWindow/
 * dataLayerPushesObservedDuringActionWindow, so this is a lookup, never a re-derivation from
 * timestamps. Every flattened sub-entry of one DataLayerCapture shares that capture's own
 * triggerSegment, since the whole push happened atomically in one phase of the action.
 */
function buildTriggerSegmentLookup(classifiedEvidence: ClassifiedEvidence[]): TriggerSegmentLookup {
  const ga4 = new Map<Ga4NetworkEventCapture, TriggerSegment | undefined>();
  const dataLayer = new Map<DataLayerCapture, TriggerSegment | undefined>();
  for (const item of classifiedEvidence) {
    if (item.ga4Event) {
      ga4.set(item.ga4Event, item.triggerSegment);
    }
    if (item.dataLayerPush) {
      dataLayer.set(item.dataLayerPush, item.triggerSegment);
    }
  }
  return { ga4, dataLayer };
}

function buildEvidenceEntries(
  action: ActionAnalytics,
  targets: string[],
  ctaText: string | undefined,
  ctaAccessibleName: string | undefined,
  triggerLookup: TriggerSegmentLookup,
): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];

  for (const event of action.ga4RequestsObservedDuringActionWindow ?? []) {
    const classFields = readGa4EvidenceFields(event, ctaText, ctaAccessibleName);
    const merged = mergedGa4Params(event);
    const supplementary = readSupplementaryFields(merged);
    supplementary.measurementId ??= event.measurementId;
    const fields = combineFields(classFields, undefined, supplementary);
    const classification = classifyEvidenceItem({
      location: classFields.location,
      eventDestinationUrl: classFields.eventDestinationUrl,
      ctaIdentifierPresent: classFields.ctaIdentifierPresent,
      ctaLabelMatch: classFields.ctaLabelMatch,
      isInteractionEvent: classFields.isInteractionEvent,
      eventName: classFields.eventName,
      virtualMetadata: classFields.virtualMetadata,
      targets,
    });
    entries.push({
      eventId: computeEventId({
        kind: "ga4",
        actionId: action.actionId ?? null,
        evidenceSource: event.source,
        contextId: event.contextId ?? null,
        stepIndex: event.stepIndex,
        timestamp: event.timestamp,
        requestUrl: event.requestUrl,
        method: event.method,
        measurementId: event.measurementId ?? null,
        params: canonicalizeValue(event.params ?? {}),
        postDataParams: canonicalizeValue(event.postDataParams ?? []),
        postDataRaw: event.postDataRaw ?? null,
      }),
      classification,
      evidenceSource: event.source,
      ...(event.contextId ? { contextId: event.contextId } : {}),
      stepIndex: event.stepIndex,
      timestamp: event.timestamp,
      triggerSegment: triggerLookup.ga4.get(event),
      ctaIdentifierPresent: classFields.ctaIdentifierPresent,
      ctaLabelMatch: classFields.ctaLabelMatch,
      fields,
      urlRelationship: bestRelationship(fields.pageLocation ?? fields.fullUrl ?? fields.eventDestinationUrl, targets),
      collectionEndpoint: collectionEndpointOf(event.requestUrl),
      rawEvidenceJson: stableStringify({
        requestUrl: event.requestUrl,
        method: event.method,
        params: event.params,
        postDataParams: event.postDataParams,
        postDataRaw: event.postDataRaw,
      }),
    });
  }

  for (const capture of action.dataLayerPushesObservedDuringActionWindow ?? []) {
    const triggerSegment = triggerLookup.dataLayer.get(capture);
    for (const { raw, rawEntryIndex } of flattenDataLayerCapture(capture)) {
      // A synthetic single-element capture so readDataLayerEvidenceFields (which scans
      // entry.raw as a whole) sees exactly this one flattened bundle sub-entry -- see that
      // function's own doc comment on this exact reuse pattern.
      const classFields = readDataLayerEvidenceFields({ ...capture, raw: [raw] }, ctaText, ctaAccessibleName);
      const supplementary = readSupplementaryFields(raw);
      const fields = combineFields(classFields, classFields.fullUrl, supplementary);
      const classification = classifyEvidenceItem({
        // PHYSICAL PAGE ANALYTICS rule (see classifyEvidenceItem): a dataLayer push's own
        // full_url-shaped field counts as page-location evidence too, exactly like the
        // engine's existing classifyActionAnalyticsCapture -- never page_location alone.
        location: classFields.location ?? classFields.fullUrl,
        eventDestinationUrl: classFields.eventDestinationUrl,
        ctaIdentifierPresent: classFields.ctaIdentifierPresent,
        ctaLabelMatch: classFields.ctaLabelMatch,
        isInteractionEvent: classFields.isInteractionEvent,
        eventName: classFields.eventName,
        virtualMetadata: classFields.virtualMetadata,
        targets,
      });
      entries.push({
        eventId: computeEventId({
          kind: "data_layer",
          actionId: action.actionId ?? null,
          evidenceSource: capture.source,
          contextId: capture.contextId ?? null,
          stepIndex: capture.stepIndex,
          timestamp: capture.timestamp,
          rawEntryIndex,
          payload: canonicalizeValue(raw),
        }),
        classification,
        evidenceSource: capture.source,
        ...(capture.contextId ? { contextId: capture.contextId } : {}),
        stepIndex: capture.stepIndex,
        timestamp: capture.timestamp,
        triggerSegment,
        rawEntryIndex,
        ctaIdentifierPresent: classFields.ctaIdentifierPresent,
        ctaLabelMatch: classFields.ctaLabelMatch,
        fields,
        urlRelationship: bestRelationship(fields.pageLocation ?? fields.fullUrl ?? fields.eventDestinationUrl, targets),
        rawEvidenceJson: stableStringify(raw),
      });
    }
  }

  return entries;
}

function dedupeByEventId(entries: EvidenceEntry[]): EvidenceEntry[] {
  const seen = new Set<string>();
  const result: EvidenceEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.eventId)) {
      continue;
    }
    seen.add(entry.eventId);
    result.push(entry);
  }
  return result;
}

/** ORDERING rule (within one action's analytics rows): timestamp, evidence source, context ID, raw entry index, then eventId as a deterministic fallback. */
function sortEntries(entries: EvidenceEntry[]): EvidenceEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) ||
      a.evidenceSource.localeCompare(b.evidenceSource) ||
      (a.contextId ?? "").localeCompare(b.contextId ?? "") ||
      (a.rawEntryIndex ?? -1) - (b.rawEntryIndex ?? -1) ||
      a.eventId.localeCompare(b.eventId),
  );
}

interface ClickResolution {
  status: PrimaryClickEventStatus;
  primary?: EvidenceEntry;
  candidates: EvidenceEntry[];
}

/** MULTIPLE OR UNRESOLVED CLICK CANDIDATES / EXACTLY ONE CONFIRMED PRIMARY CLICK EVENT rules. Mirrors analyticsCaptureClassification.ts's own primary-click resolution (richness score + genuine-conflict check), applied here to this module's finer-grained, bundle-expanded candidate set. */
function resolveClickTag(clickEntries: EvidenceEntry[], correlationUnresolvedCount: number): ClickResolution {
  if (clickEntries.length === 0) {
    return {
      status: correlationUnresolvedCount > 0 ? "CORRELATION_UNRESOLVED" : "WEBSITE_NO_OBSERVED_CLICK_TAG",
      candidates: [],
    };
  }

  const destinations = clickEntries.map((e) => e.fields.eventDestinationUrl).filter((u): u is string => Boolean(u));
  for (let i = 0; i < destinations.length; i++) {
    for (let j = i + 1; j < destinations.length; j++) {
      if (computeUrlRelationship(destinations[i], destinations[j]) === "DIFFERENT_DESTINATION") {
        return { status: "CORRELATION_UNRESOLVED", candidates: clickEntries };
      }
    }
  }

  let primary: EvidenceEntry | undefined;
  let bestScore = -Infinity;
  for (const entry of clickEntries) {
    const score = clickRichnessScore({
      eventName: entry.fields.eventName,
      eventCategory: entry.fields.eventCategory,
      eventAction: entry.fields.eventAction,
      ctaLabelMatch: entry.ctaLabelMatch,
      ctaIdentifierPresent: entry.ctaIdentifierPresent,
      eventDestinationUrl: entry.fields.eventDestinationUrl,
    });
    if (score > bestScore) {
      bestScore = score;
      primary = entry;
    }
  }
  return { status: "CAPTURED", primary, candidates: clickEntries.filter((e) => e !== primary) };
}

function applyEvidenceFieldsToRow(row: AnalyticsReportingRow, entry: EvidenceEntry): void {
  row.evidenceSource = entry.evidenceSource;
  if (entry.contextId) row.contextId = entry.contextId;
  if (entry.triggerSegment) row.triggerSegment = entry.triggerSegment;
  if (entry.fields.eventName) row.eventName = entry.fields.eventName;
  if (entry.fields.eventCategory) row.eventCategory = entry.fields.eventCategory;
  if (entry.fields.eventAction) row.eventAction = entry.fields.eventAction;
  if (entry.fields.eventLabel) row.eventLabel = entry.fields.eventLabel;
  if (entry.fields.eventDestinationUrl) row.analyticsEventDestinationUrl = entry.fields.eventDestinationUrl;
  if (entry.fields.pageLocation) row.analyticsPageLocation = entry.fields.pageLocation;
  if (entry.fields.referrer) row.analyticsReferrer = entry.fields.referrer;
  if (entry.fields.fullUrl) row.analyticsFullUrl = entry.fields.fullUrl;
  if (entry.fields.virtualPageUrl) row.analyticsVirtualPageUrl = entry.fields.virtualPageUrl;
  if (entry.fields.pageTitle) row.pageTitle = entry.fields.pageTitle;
  if (entry.fields.pageName) row.pageName = entry.fields.pageName;
  if (entry.fields.pageCategory) row.pageCategory = entry.fields.pageCategory;
  if (entry.fields.pageType) row.pageType = entry.fields.pageType;
  if (entry.fields.componentId) row.componentId = entry.fields.componentId;
  if (entry.fields.formName) row.formName = entry.fields.formName;
  if (entry.fields.formCategory) row.formCategory = entry.fields.formCategory;
  if (entry.fields.formType) row.formType = entry.fields.formType;
  if (entry.fields.stepName) row.stepName = entry.fields.stepName;
  if (entry.fields.stepNumber !== undefined) row.stepNumber = entry.fields.stepNumber;
  if (entry.fields.vehicleYear) row.vehicleYear = entry.fields.vehicleYear;
  if (entry.fields.measurementId) row.measurementId = entry.fields.measurementId;
  if (entry.collectionEndpoint) row.collectionEndpoint = entry.collectionEndpoint;
  if (entry.urlRelationship) row.urlRelationship = entry.urlRelationship;
  if (entry.rawEvidenceJson) row.rawEvidenceJson = entry.rawEvidenceJson;
}

function buildAnalyticsEventRow(
  base: Pick<AnalyticsReportingRow, "runId" | "taskId" | "schemaVersion" | "journeyType" | "actionId">,
  entry: EvidenceEntry,
  stepIndex: number,
  eventRole: ReportingEventRole,
  correlationStatus: ReportingCorrelationStatus,
  correlationSource: ReportingCorrelationSource,
): AnalyticsReportingRow {
  const row: AnalyticsReportingRow = {
    ...base,
    journeySequence: 0,
    recordType: "ANALYTICS_EVENT",
    stepIndex,
    timestamp: entry.timestamp,
    eventId: entry.eventId,
    eventRole,
    eventClassification: entry.classification,
    correlationStatus,
    correlationSource,
  };
  applyEvidenceFieldsToRow(row, entry);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Per-CTA-click row assembly
// ---------------------------------------------------------------------------------------------

function buildRowsForCtaClick(
  ctaClick: CtaClickCapture,
  ctx: { runId: string; taskId: string; schemaVersion: string; journeyType?: string },
): AnalyticsReportingRow[] {
  const base: Pick<AnalyticsReportingRow, "runId" | "taskId" | "schemaVersion" | "journeyType" | "actionId"> = {
    runId: ctx.runId,
    taskId: ctx.taskId,
    schemaVersion: ctx.schemaVersion,
    ...(ctx.journeyType ? { journeyType: ctx.journeyType } : {}),
    ...(ctaClick.actionId ? { actionId: ctaClick.actionId } : {}),
  };

  const action = ctaClick.actionAnalytics;
  const analyticsCapture = action?.analyticsCapture;

  const ctaClickRow: AnalyticsReportingRow = {
    ...base,
    journeySequence: 0,
    recordType: "CTA_CLICK",
    stepIndex: ctaClick.stepIndex,
    timestamp: ctaClick.timestamp,
    ctaText: ctaClick.ctaText,
    sourcePageUrl: ctaClick.sourcePageUrl,
    ...(ctaClick.destinationUrl ? { ctaElementDestinationUrl: ctaClick.destinationUrl } : {}),
    ...(ctaClick.resultingUrl ? { browserResultingUrl: ctaClick.resultingUrl } : {}),
    ...(ctaClick.resultingTitle ? { destinationPageTitle: ctaClick.resultingTitle } : {}),
    actionSuccessful: ctaClick.actionSucceeded,
    navigationSuccessful: ctaClick.navigationSucceeded,
    // Every dispatched CTA click action was itself selected by the reasoning layer in
    // pursuit of this run's objective -- the engine has no separate, narrower concept of
    // "irrelevant click" for an action it already chose to dispatch and capture.
    journeyRelevant: true,
    eventRole: "PRIMARY_CLICK",
    eventClassification: "CLICK_EVENT",
    correlationStatus: "NOT_APPLICABLE",
  };
  if (action?.newlySatisfiedCriteriaIds && action.newlySatisfiedCriteriaIds.length > 0) {
    ctaClickRow.milestoneIdsCompleted = action.newlySatisfiedCriteriaIds;
  }

  if (!action || !analyticsCapture) {
    // No analytics capture module was requested for this run (or this action produced none) --
    // the CTA_CLICK row is still reported, with no analytics fields fabricated.
    return [ctaClickRow];
  }

  ctaClickRow.analyticsCaptureStatus = analyticsCapture.status;
  if (action.captureHealth) {
    ctaClickRow.captureComplete = action.captureHealth.captureComplete;
    if (action.captureHealth.issues.length > 0) {
      ctaClickRow.captureIssues = action.captureHealth.issues;
    }
  }
  if (analyticsCapture.classificationReason) {
    ctaClickRow.classificationReason = analyticsCapture.classificationReason;
  }

  const targets = [ctaClick.destinationUrl, ctaClick.resultingUrl].filter((u): u is string => Boolean(u));
  const triggerLookup = buildTriggerSegmentLookup(analyticsCapture.classifiedEvidence);
  const entries = dedupeByEventId(
    buildEvidenceEntries(action, targets, ctaClick.ctaText, ctaClick.accessibleName, triggerLookup),
  );

  const clickEntries = entries.filter((e) => e.classification === "CLICK_EVENT");
  const associatedEntries = entries.filter(
    (e) =>
      e.classification === "PHYSICAL_PAGE_CHANGE" ||
      e.classification === "VIRTUAL_PAGE_CHANGE" ||
      e.classification === "FORM_OR_CONFIGURATOR_STATE",
  );
  const otherEntries = entries.filter((e) => e.classification === "OTHER_MEANINGFUL_EVENT" || e.classification === "CORRELATION_UNRESOLVED");
  const correlationUnresolvedCount = entries.filter((e) => e.classification === "CORRELATION_UNRESOLVED").length;

  // Consent/capture-health gates are safety-relevant facts the engine has already computed
  // (analyticsCaptureClassification.ts's own consentRequired/captureHealth checks) -- reused
  // verbatim here rather than re-derived, per this run's own capture-modules contract.
  const engineGate: PrimaryClickEventStatus | undefined =
    analyticsCapture.status === "CAPTURE_UNCERTAIN_CONSENT_STATE" || analyticsCapture.status === "ENGINE_CAPTURE_INCOMPLETE"
      ? analyticsCapture.status
      : undefined;

  const resolved = engineGate ? undefined : resolveClickTag(clickEntries, correlationUnresolvedCount);
  const primaryClickTagStatus: PrimaryClickEventStatus = engineGate ?? resolved!.status;
  ctaClickRow.primaryClickTagStatus = primaryClickTagStatus;
  ctaClickRow.correlationStatus =
    primaryClickTagStatus === "CAPTURED"
      ? "CONFIRMED"
      : primaryClickTagStatus === "WEBSITE_NO_OBSERVED_CLICK_TAG"
        ? "WEBSITE_NO_OBSERVED_TAG"
        : "UNRESOLVED";
  ctaClickRow.correlationSource = engineGate
    ? "engine_capture_gate"
    : primaryClickTagStatus === "CAPTURED"
      ? "engine_confirmed_primary_click"
      : primaryClickTagStatus === "WEBSITE_NO_OBSERVED_CLICK_TAG"
        ? "engine_no_observed_click_tag"
        : "engine_click_candidate";

  const primary = !engineGate ? resolved!.primary : undefined;
  if (primary) {
    ctaClickRow.eventId = primary.eventId;
    applyEvidenceFieldsToRow(ctaClickRow, primary);
  }

  const candidateEntries = engineGate ? clickEntries : (resolved!.candidates ?? []);
  const candidateCorrelationStatus: ReportingCorrelationStatus = primaryClickTagStatus === "CAPTURED" ? "CONFIRMED" : "UNRESOLVED";
  const candidateCorrelationSource: ReportingCorrelationSource = engineGate ? "engine_capture_gate" : "engine_click_candidate";

  const rows: AnalyticsReportingRow[] = [ctaClickRow];
  for (const entry of sortEntries(candidateEntries)) {
    rows.push(buildAnalyticsEventRow(base, entry, ctaClick.stepIndex, "CLICK_CANDIDATE", candidateCorrelationStatus, candidateCorrelationSource));
  }
  for (const entry of sortEntries(associatedEntries)) {
    rows.push(buildAnalyticsEventRow(base, entry, ctaClick.stepIndex, "ASSOCIATED_RESULT", "CONFIRMED", "engine_confirmed_associated_event"));
  }
  for (const entry of sortEntries(otherEntries)) {
    rows.push(buildAnalyticsEventRow(base, entry, ctaClick.stepIndex, "RAW_CAPTURE_IN_ACTION_WINDOW", "UNRESOLVED", "engine_action_window_raw_capture"));
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------------------------

export function buildAnalyticsReportingRows(params: {
  taskId: string;
  journeyType?: string;
  startUrl: string;
  schemaVersion: string;
  pageVisits: PageVisitCapture[];
  ctaClicks: CtaClickCapture[];
  /** Used only when no page_visits capture and no cta_clicks exist to derive a START_PAGE timestamp from. */
  fallbackTimestamp?: string;
}): AnalyticsReportingRow[] {
  const { taskId, journeyType, startUrl, schemaVersion, pageVisits, ctaClicks } = params;
  const runId = taskId;

  const startVisit = pageVisits[0];
  const startTimestamp = startVisit?.timestamp ?? ctaClicks[0]?.timestamp ?? params.fallbackTimestamp ?? new Date().toISOString();

  const rows: AnalyticsReportingRow[] = [
    {
      runId,
      taskId,
      schemaVersion,
      ...(journeyType ? { journeyType } : {}),
      journeySequence: 0,
      recordType: "START_PAGE",
      stepIndex: startVisit?.stepIndex ?? 0,
      timestamp: startTimestamp,
      sourcePageUrl: startVisit?.url ?? startUrl,
      ...(startVisit?.title ? { destinationPageTitle: startVisit.title } : {}),
      eventRole: "START_PAGE",
      eventClassification: "JOURNEY_MARKER",
      correlationStatus: "NOT_APPLICABLE",
      correlationSource: "engine_journey_marker",
    },
  ];

  for (const ctaClick of ctaClicks) {
    rows.push(...buildRowsForCtaClick(ctaClick, { runId, taskId, schemaVersion, journeyType }));
  }

  return rows.map((row, index) => ({ ...row, journeySequence: index + 1 }));
}
