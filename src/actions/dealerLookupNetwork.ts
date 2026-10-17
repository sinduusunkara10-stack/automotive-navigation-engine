import type { Page, Request, Response } from "playwright";

/**
 * Generic purpose taxonomy for a request observed during a dealer-lookup or submit window. Never
 * decided from a brand's own endpoint name -- only from generic path vocabulary, resource type,
 * status, content type and the response's own *structure* (never its content). A request whose
 * purpose cannot be decided from that evidence is reported as "unknown", never guessed.
 */
export type NetworkRequestPurpose =
  | "email_validation"
  | "form_configuration"
  | "location_lookup"
  | "dealer_lookup"
  | "location_results"
  | "dealer_results"
  | "empty_results"
  | "validation_error"
  | "server_error"
  | "unrelated_tracking"
  | "unknown";

export type NetworkResultCategory = "records" | "empty" | "error" | "not_applicable" | "unknown";

/**
 * Sanitised, diagnostic-only network evidence for a single request observed during a
 * dealer-lookup or submit window. Never carries a request body, a response body's actual content,
 * or any typed/returned value (postcode, address, dealer name, email, phone, etc.) -- only method,
 * timing, status, content-type, and structure derived from the response's *shape* (element/key
 * names and repetition counts), never its values.
 */
export interface SanitizedNetworkRequestEvidence {
  method: string;
  /** origin + pathname only -- no query string, no fragment (a lookup's typed value is routinely
   * sent as a query parameter, so the query string is dropped entirely, never inspected). Any
   * path segment containing a digit is also replaced with "{param}", since a postcode or a record
   * id can equally be embedded directly in the path rather than in the query string. */
  endpointPattern: string;
  resourceType: string;
  /** Relative to when this capture started, not wall-clock. */
  startedAtMs: number;
  outcome: "completed" | "failed" | "pending";
  status: number | null;
  contentType: string | null;
  /** Heuristic only, derived from response shape, never content. Null when this could never be
   * safely determined (failed/pending, an unparseable or unsupported content-type, or the body
   * could not be read within the bounded read timeout). */
  appearsToContainRecords: boolean | null;
  /** Only ever a count, never the records themselves. Null under the same conditions as above. */
  recordCount: number | null;
  /** Time from request start to response completion, or null when it never completed. */
  durationMs: number | null;
  /** Root element name of an XML response, or null for a non-XML/unread response. */
  xmlRootElement: string | null;
  /** Recurring XML element names, or the key names of a JSON response's first record -- names
   * only, never values, sanitised to plain identifier shapes and capped. */
  structureElementNames: string[];
  resultCategory: NetworkResultCategory;
  purpose: NetworkRequestPurpose;
  /** Which generic signal decided `purpose` -- e.g. "path_token:dealer", "status_5xx",
   * "content_type:image". Never a response value. */
  purposeEvidence: string;
  /** The activation step that was in progress when this request started -- see setStep(). */
  activationStep: string;
  /** Filled in by the caller: whether the activation step this request started in was followed by
   * any observable DOM/hidden-field/accessibility change. Null when the caller never assessed it. */
  followedByObservableChange: boolean | null;
}

export interface DealerLookupNetworkStats {
  /** Every captured request, tracking included, before any output bound was applied. */
  totalObserved: number;
  trackingRequestCount: number;
  /** Requests observed but dropped from the returned list to respect the output bound. */
  omittedRequestCount: number;
}

/** Output bound for the detailed list. Non-tracking requests are always kept first -- a chatty page
 * firing tracking pixels can never push a real lookup request out of the evidence (exactly what
 * happened with the previous first-N-only bound, which filled up within the first ~400ms of a live
 * run and silently dropped every later request). */
export const DEALER_LOOKUP_NETWORK_MAX_REQUESTS = 12;
const MAX_TRACKING_REQUESTS_KEPT = 3;
/** Internal memory bound, independent of how many requests a live page fires. */
const MAX_REQUESTS_OBSERVED = 80;
// Past MAX_REQUESTS_OBSERVED only tracking is dropped; a long observation window (a slow lead
// submission) on a tracking-heavy page must never lose the one business request to the bound.
const MAX_NON_TRACKING_REQUESTS_OBSERVED = 200;
const BODY_READ_TIMEOUT_MS = 500;
const MAX_STRUCTURE_BODY_BYTES = 512_000;
const MAX_STRUCTURE_NAMES = 8;

const CAPTURED_RESOURCE_TYPES = new Set(["xhr", "fetch", "script", "ping", "image", "other", "eventsource"]);
const TRACKING_RESOURCE_TYPES = new Set(["ping", "image"]);

function sanitizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").map((segment) => (segment.length > 0 && /\d/.test(segment) ? "{param}" : segment));
    return `${parsed.origin}${segments.join("/")}`;
  } catch {
    return "unparseable-url";
  }
}

function pathTokens(endpointPattern: string): string[] {
  let path = endpointPattern;
  try {
    path = new URL(endpointPattern).pathname;
  } catch {
    // keep the raw pattern
  }
  return path
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function hostTokens(endpointPattern: string): string[] {
  try {
    return new URL(endpointPattern).hostname.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Short words only ever match a whole token (so "log" never matches "catalog"/"login"); longer
 * stems may match inside a compound token (so "dealer" matches "dealerlocator"). */
function matchesVocabulary(tokens: string[], exact: string[], stems: string[]): string | null {
  for (const token of tokens) {
    if (exact.includes(token)) return token;
    const stem = stems.find((s) => token.includes(s));
    if (stem) return stem;
  }
  return null;
}

const TRACKING_EXACT = ["log", "logs", "pixel", "px", "collect", "beacon", "track", "tracking", "tracker", "analytics", "metrics", "telemetry", "stats", "impression", "impressions", "rum", "tag", "tags", "ads", "event", "events"];
const TRACKING_STEMS = ["analytics", "pixel", "beacon", "tracking", "telemetry", "impression", "doubleclick"];
const EMAIL_STEMS = ["email", "mail"];
const VALIDATION_STEMS = ["valid", "verif", "check"];
const DEALER_EXACT = ["pos", "pdv", "store", "stores", "shop", "shops", "outlet", "outlets", "garage", "garages", "agent", "agents"];
const DEALER_STEMS = ["dealer", "retailer", "concession", "haendler", "handler", "distributor", "showroom", "storelocator", "dealership", "concesionari", "rivenditor", "dealerlocator"];
const LOCATION_EXACT = ["geo", "zip", "plz", "cp", "city", "cities", "town", "towns", "place", "places", "ort", "ville", "villes", "commune", "communes", "locality", "address", "addresses"];
const LOCATION_STEMS = ["geocod", "autocomplet", "suggest", "postcode", "postalcode", "postal", "localit", "location", "citta", "ciudad", "miejscow"];
const CONFIG_EXACT = ["config", "configuration", "settings", "i18n", "translations", "labels", "init", "schema", "metadata", "form", "forms"];
const CONFIG_STEMS = ["config", "setting", "translation"];

/**
 * Pure, generic purpose classifier -- exported for unit tests. Precedence is deliberate:
 * transport-level evidence (tracking transport, 5xx) first, then a 4xx/error-structure, then path
 * vocabulary, then response structure. Never infers a purpose from a successful status alone.
 */
export function classifyRequestPurpose(input: {
  endpointPattern: string;
  resourceType: string;
  status: number | null;
  contentType: string | null;
  resultCategory: NetworkResultCategory;
  structureElementNames: string[];
  xmlRootElement: string | null;
}): { purpose: NetworkRequestPurpose; evidence: string } {
  const tokens = pathTokens(input.endpointPattern);
  const contentType = (input.contentType ?? "").toLowerCase();

  if (TRACKING_RESOURCE_TYPES.has(input.resourceType)) return { purpose: "unrelated_tracking", evidence: `resource_type:${input.resourceType}` };
  if (contentType.startsWith("image/")) return { purpose: "unrelated_tracking", evidence: "content_type:image" };
  const trackingToken = matchesVocabulary(tokens, TRACKING_EXACT, TRACKING_STEMS) ?? matchesVocabulary(hostTokens(input.endpointPattern), [], TRACKING_STEMS);
  if (trackingToken) return { purpose: "unrelated_tracking", evidence: `path_token:${trackingToken}` };
  if (input.status === 204 && input.resourceType !== "xhr" && input.resourceType !== "fetch") return { purpose: "unrelated_tracking", evidence: "status_204_non_xhr" };

  if (input.status !== null && input.status >= 500) return { purpose: "server_error", evidence: "status_5xx" };
  if (input.status !== null && input.status >= 400) return { purpose: "validation_error", evidence: "status_4xx" };
  if (input.resultCategory === "error") return { purpose: "validation_error", evidence: "response_structure:error_element" };

  const emailToken = matchesVocabulary(tokens, [], EMAIL_STEMS);
  if (emailToken && matchesVocabulary(tokens, [], VALIDATION_STEMS)) return { purpose: "email_validation", evidence: `path_token:${emailToken}+validation` };

  const structureTokens = input.structureElementNames.concat(input.xmlRootElement ? [input.xmlRootElement] : []).flatMap((name) => pathTokens(`/${name}`));
  const dealerToken = matchesVocabulary(tokens, DEALER_EXACT, DEALER_STEMS);
  const locationToken = dealerToken ? null : matchesVocabulary(tokens, LOCATION_EXACT, LOCATION_STEMS);
  const structureDealerToken = matchesVocabulary(structureTokens, DEALER_EXACT, DEALER_STEMS);
  const structureLocationToken = structureDealerToken ? null : matchesVocabulary(structureTokens, LOCATION_EXACT, LOCATION_STEMS);
  const domain: "dealer" | "location" | null = dealerToken || (!locationToken && structureDealerToken) ? "dealer" : locationToken || structureLocationToken ? "location" : null;
  const domainEvidence = dealerToken
    ? `path_token:${dealerToken}`
    : locationToken
      ? `path_token:${locationToken}`
      : structureDealerToken
        ? `structure_name:${structureDealerToken}`
        : structureLocationToken
          ? `structure_name:${structureLocationToken}`
          : "";

  if (domain) {
    if (input.resultCategory === "empty") return { purpose: "empty_results", evidence: `${domainEvidence}+empty_structure` };
    if (input.resultCategory === "records") return { purpose: domain === "dealer" ? "dealer_results" : "location_results", evidence: `${domainEvidence}+records` };
    return { purpose: domain === "dealer" ? "dealer_lookup" : "location_lookup", evidence: domainEvidence };
  }

  const configToken = matchesVocabulary(tokens, CONFIG_EXACT, CONFIG_STEMS);
  if (configToken) return { purpose: "form_configuration", evidence: `path_token:${configToken}` };
  // An undecidable path is never assumed to serve a single purpose: only its own response
  // structure can move it out of "unknown", and only towards "empty".
  if (input.resultCategory === "empty") return { purpose: "empty_results", evidence: "empty_structure" };
  return { purpose: "unknown", evidence: "no_generic_signal" };
}

/** Request-time classification, before any response exists -- used only to decide whether a step
 * produced lookup-like activity and whether a request is tracking noise. */
export function isLookupLikePurpose(purpose: NetworkRequestPurpose): boolean {
  return purpose !== "unrelated_tracking" && purpose !== "email_validation" && purpose !== "form_configuration";
}

function sanitizeStructureName(name: string): string | null {
  const local = name.includes(":") ? name.split(":").pop()! : name;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,39}$/.test(local)) return null;
  if ((local.match(/\d/g) ?? []).length > 3) return null;
  return local;
}

/**
 * Structural-only XML analysis -- a tag-name walk with a depth stack, never a value read. Text
 * nodes, attribute values, comments and CDATA are discarded before the walk. "Records" means a
 * repeated element that itself carries child elements, directly under the root or under a single
 * wrapper element; a leaf-only response (e.g. a lone status element) is never counted as a record.
 */
export function analyzeXmlStructure(text: string): {
  root: string | null;
  recurringNames: string[];
  recordCount: number;
  errorSignal: boolean;
} {
  const stripped = text
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  const tagPattern = /<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;
  const stack: { name: string; hasElementChildren: boolean }[] = [];
  let root: string | null = null;
  const depthCounts: Map<string, number>[] = [new Map(), new Map(), new Map()];
  const nonLeafNames: Set<string>[] = [new Set(), new Set(), new Set()];
  const depth1Names: string[] = [];
  let errorSignal = false;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(stripped)) !== null) {
    const closing = match[1] === "/";
    const name = match[2]!;
    const selfClosing = match[3] === "/";
    if (closing) {
      const popped = stack.pop();
      if (popped && popped.hasElementChildren && stack.length >= 1 && stack.length <= 3) nonLeafNames[stack.length - 1]!.add(popped.name);
      continue;
    }
    if (/error|fault|exception/i.test(name) && stack.length <= 2) errorSignal = true;
    if (stack.length === 0 && root === null) root = name;
    if (stack.length > 0) stack[stack.length - 1]!.hasElementChildren = true;
    const depth = stack.length;
    if (depth >= 1 && depth <= 3) {
      const counts = depthCounts[depth - 1]!;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (depth === 1) depth1Names.push(name);
    }
    if (!selfClosing) stack.push({ name, hasElementChildren: false });
  }

  const recordCountAt = (level: number): { name: string | null; count: number } => {
    let best: { name: string | null; count: number } = { name: null, count: 0 };
    depthCounts[level]!.forEach((count, name) => {
      if (nonLeafNames[level]!.has(name) && !/error|fault|exception/i.test(name) && count > best.count) best = { name, count };
    });
    return best;
  };
  let records = recordCountAt(0);
  const singleWrapper = depthCounts[0]!.size === 1 && [...depthCounts[0]!.values()][0] === 1;
  if (singleWrapper) {
    const nested = recordCountAt(1);
    if (nested.count >= 1) records = nested;
    else records = { name: null, count: 0 };
  }

  const recurring = new Set<string>();
  if (records.name) recurring.add(records.name);
  for (const counts of depthCounts) {
    counts.forEach((count, name) => {
      if (count >= 2) recurring.add(name);
    });
  }
  return {
    root: root ? sanitizeStructureName(root) : null,
    recurringNames: [...recurring].map(sanitizeStructureName).filter((n): n is string => n !== null).slice(0, MAX_STRUCTURE_NAMES),
    recordCount: records.count,
    errorSignal: errorSignal && records.count === 0,
  };
}

interface StructureEvidence {
  appearsToContainRecords: boolean | null;
  recordCount: number | null;
  xmlRootElement: string | null;
  structureElementNames: string[];
  resultCategory: NetworkResultCategory;
}

const UNKNOWN_STRUCTURE: StructureEvidence = { appearsToContainRecords: null, recordCount: null, xmlRootElement: null, structureElementNames: [], resultCategory: "unknown" };

function jsonStructure(body: unknown): StructureEvidence {
  const keyNames = (record: unknown): string[] =>
    record && typeof record === "object" && !Array.isArray(record)
      ? Object.keys(record as Record<string, unknown>).map(sanitizeStructureName).filter((n): n is string => n !== null).slice(0, MAX_STRUCTURE_NAMES)
      : [];
  if (Array.isArray(body)) {
    return { appearsToContainRecords: body.length > 0, recordCount: body.length, xmlRootElement: null, structureElementNames: keyNames(body[0]), resultCategory: body.length > 0 ? "records" : "empty" };
  }
  if (body && typeof body === "object") {
    const entries = Object.entries(body as Record<string, unknown>);
    const arrayEntry = entries.find(([, value]) => Array.isArray(value)) as [string, unknown[]] | undefined;
    if (arrayEntry) {
      const [key, list] = arrayEntry;
      const names = [sanitizeStructureName(key)].filter((n): n is string => n !== null).concat(keyNames(list[0])).slice(0, MAX_STRUCTURE_NAMES);
      return { appearsToContainRecords: list.length > 0, recordCount: list.length, xmlRootElement: null, structureElementNames: names, resultCategory: list.length > 0 ? "records" : "empty" };
    }
    const hasErrorKey = entries.some(([key]) => /error|fault|exception/i.test(key));
    return {
      appearsToContainRecords: false,
      recordCount: 0,
      xmlRootElement: null,
      structureElementNames: keyNames(body),
      resultCategory: hasErrorKey ? "error" : entries.length === 0 ? "empty" : "not_applicable",
    };
  }
  return UNKNOWN_STRUCTURE;
}

/** Reads the body only to derive structure, inside a bounded timeout and size cap, then drops it --
 * the body itself is never stored, returned, or logged. */
async function deriveStructureEvidence(response: Response): Promise<StructureEvidence> {
  const contentType = (response.headers()["content-type"] ?? "").toLowerCase();
  const declaredLength = Number(response.headers()["content-length"] ?? "0");
  if (declaredLength > MAX_STRUCTURE_BODY_BYTES) return UNKNOWN_STRUCTURE;
  const isJson = contentType.includes("json");
  const isXml = contentType.includes("xml");
  if (!isJson && !isXml && !contentType.startsWith("text/plain")) return { ...UNKNOWN_STRUCTURE, resultCategory: response.status() === 204 ? "empty" : "unknown" };
  try {
    const text = await Promise.race([
      response.text(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), BODY_READ_TIMEOUT_MS)),
    ]);
    if (text.length > MAX_STRUCTURE_BODY_BYTES) return UNKNOWN_STRUCTURE;
    const trimmed = text.trim();
    if (trimmed.length === 0) return { ...UNKNOWN_STRUCTURE, appearsToContainRecords: false, recordCount: 0, resultCategory: "empty" };
    if (isJson || trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return jsonStructure(JSON.parse(trimmed));
      } catch {
        return UNKNOWN_STRUCTURE;
      }
    }
    if (trimmed.startsWith("<")) {
      const xml = analyzeXmlStructure(trimmed);
      return {
        appearsToContainRecords: xml.recordCount > 0,
        recordCount: xml.recordCount,
        xmlRootElement: xml.root,
        structureElementNames: xml.recurringNames,
        resultCategory: xml.recordCount > 0 ? "records" : xml.errorSignal ? "error" : "empty",
      };
    }
    return UNKNOWN_STRUCTURE;
  } catch {
    return UNKNOWN_STRUCTURE;
  }
}

export interface DealerLookupNetworkCapture {
  /** Labels every request that starts from now on with this activation step. */
  setStep(step: string): void;
  /** Requests started since the given capture-relative time, split by request-time purpose. */
  activitySince(sinceMs: number): { started: number; lookupLike: number; pending: number };
  /** Capture-relative "now", for activitySince(). */
  now(): number;
  /** Requests still awaiting a response right now that look lookup-like. */
  pendingLookupLike(): number;
  /** Live view of every request observed so far (same objects stop() later bounds), for callers that classify while observing. */
  snapshot(): readonly SanitizedNetworkRequestEvidence[];
  /** Detaches the listeners and returns the sanitised, bounded evidence collected so far. */
  stop(): Promise<SanitizedNetworkRequestEvidence[]>;
  /** Totals for the evidence returned by stop(), including what the output bound omitted. */
  stats(): DealerLookupNetworkStats;
}

/**
 * Observes only sanitised request/response metadata for requests that start while active.
 * Correlation is by time window and the caller-labelled activation step -- never tied to a
 * specific selector, URL, or brand. Never reads a request body. Never logs or persists the raw
 * trace anywhere -- the caller only ever receives the sanitised summary below, which is itself only
 * exposed under FORM_DISCOVERY_DIAGNOSTIC=1.
 */
export function startDealerLookupNetworkCapture(page: Page, options: { includeDocumentRequests?: boolean } = {}): DealerLookupNetworkCapture {
  const start = Date.now();
  const entries: SanitizedNetworkRequestEvidence[] = [];
  const pending = new Map<Request, SanitizedNetworkRequestEvidence>();
  const structureReads: Promise<void>[] = [];
  let step = "before_activation";
  let dropped = 0;
  let selectedCount = 0;
  let stats: DealerLookupNetworkStats = { totalObserved: 0, trackingRequestCount: 0, omittedRequestCount: 0 };

  const reclassify = (evidence: SanitizedNetworkRequestEvidence): void => {
    const classified = classifyRequestPurpose(evidence);
    evidence.purpose = classified.purpose;
    evidence.purposeEvidence = classified.evidence;
  };

  const onRequest = (request: Request): void => {
    if (!CAPTURED_RESOURCE_TYPES.has(request.resourceType()) && !(options.includeDocumentRequests && request.resourceType() === "document")) return;
    if (entries.length >= MAX_NON_TRACKING_REQUESTS_OBSERVED) {
      dropped += 1;
      return;
    }
    const evidence: SanitizedNetworkRequestEvidence = {
      method: request.method(),
      endpointPattern: sanitizeEndpoint(request.url()),
      resourceType: request.resourceType(),
      startedAtMs: Date.now() - start,
      outcome: "pending",
      status: null,
      contentType: null,
      appearsToContainRecords: null,
      recordCount: null,
      durationMs: null,
      xmlRootElement: null,
      structureElementNames: [],
      resultCategory: "unknown",
      purpose: "unknown",
      purposeEvidence: "",
      activationStep: step,
      followedByObservableChange: null,
    };
    reclassify(evidence);
    if (entries.length >= MAX_REQUESTS_OBSERVED && evidence.purpose === "unrelated_tracking") {
      dropped += 1;
      return;
    }
    pending.set(request, evidence);
    entries.push(evidence);
  };

  const onResponse = (response: Response): void => {
    const request = response.request();
    const evidence = pending.get(request);
    if (!evidence) return;
    pending.delete(request);
    evidence.status = response.status();
    evidence.contentType = response.headers()["content-type"] ?? null;
    evidence.outcome = "completed";
    evidence.durationMs = Date.now() - start - evidence.startedAtMs;
    reclassify(evidence);
    if (evidence.purpose === "unrelated_tracking") {
      evidence.resultCategory = "not_applicable";
      return;
    }
    structureReads.push(
      deriveStructureEvidence(response)
        .then((derived) => {
          evidence.appearsToContainRecords = derived.appearsToContainRecords;
          evidence.recordCount = derived.recordCount;
          evidence.xmlRootElement = derived.xmlRootElement;
          evidence.structureElementNames = derived.structureElementNames;
          evidence.resultCategory = derived.resultCategory;
          reclassify(evidence);
        })
        .catch(() => {}),
    );
  };

  const onRequestFailed = (request: Request): void => {
    const evidence = pending.get(request);
    if (!evidence) return;
    pending.delete(request);
    evidence.outcome = "failed";
    evidence.durationMs = Date.now() - start - evidence.startedAtMs;
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return {
    setStep(next: string) {
      step = next;
    },
    now() {
      return Date.now() - start;
    },
    activitySince(sinceMs: number) {
      const since = entries.filter((e) => e.startedAtMs >= sinceMs);
      return {
        started: since.length,
        lookupLike: since.filter((e) => isLookupLikePurpose(e.purpose)).length,
        pending: since.filter((e) => e.outcome === "pending").length,
      };
    },
    snapshot() {
      return entries;
    },
    pendingLookupLike() {
      return [...pending.values()].filter((e) => isLookupLikePurpose(e.purpose)).length;
    },
    async stop() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      // Give any in-flight response/structure read a brief, bounded moment to settle before this
      // capture's evidence is read -- otherwise a response that arrived a few ms before stop()
      // would be misreported as still "pending".
      await new Promise((resolve) => setTimeout(resolve, 100));
      await Promise.race([Promise.all(structureReads), new Promise((resolve) => setTimeout(resolve, BODY_READ_TIMEOUT_MS))]);
      const tracking = entries.filter((e) => e.purpose === "unrelated_tracking");
      const nonTracking = entries.filter((e) => e.purpose !== "unrelated_tracking");
      const keptNonTracking = nonTracking.slice(0, DEALER_LOOKUP_NETWORK_MAX_REQUESTS);
      const keptTracking = tracking.slice(0, Math.max(0, Math.min(MAX_TRACKING_REQUESTS_KEPT, DEALER_LOOKUP_NETWORK_MAX_REQUESTS - keptNonTracking.length)));
      const kept = [...keptNonTracking, ...keptTracking].sort((a, b) => a.startedAtMs - b.startedAtMs);
      selectedCount = kept.length;
      stats = {
        totalObserved: entries.length + dropped,
        trackingRequestCount: tracking.length,
        omittedRequestCount: entries.length + dropped - selectedCount,
      };
      return kept;
    },
    stats() {
      return stats;
    },
  };
}

/** Human-readable, still fully sanitised summary of the captured evidence -- never includes a
 * URL or any value; only aggregate counts and purpose categories. */
export function summarizeDealerLookupNetworkActivity(requests: SanitizedNetworkRequestEvidence[]): string {
  if (requests.length === 0) return "no request was observed during the dealer-lookup window";
  const completed = requests.filter((r) => r.outcome === "completed");
  const failed = requests.filter((r) => r.outcome === "failed");
  const pending = requests.filter((r) => r.outcome === "pending");
  const withRecords = completed.filter((r) => r.appearsToContainRecords === true);
  const parts = [`${requests.length} request(s) observed`];
  if (completed.length > 0) parts.push(`${completed.length} completed`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (pending.length > 0) parts.push(`${pending.length} still pending when capture stopped`);
  if (withRecords.length > 0) parts.push(`${withRecords.length} appear to carry records`);
  else if (completed.length > 0) parts.push("none of the completed requests appear to carry records");
  const purposes = new Map<string, number>();
  requests.forEach((r) => purposes.set(r.purpose, (purposes.get(r.purpose) ?? 0) + 1));
  parts.push(`purposes: ${[...purposes.entries()].map(([purpose, count]) => `${purpose}=${count}`).join(", ")}`);
  return parts.join(", ");
}
