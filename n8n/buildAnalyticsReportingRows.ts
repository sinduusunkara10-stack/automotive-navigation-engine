// n8n "Build Analytics Reporting Rows" Code node -- pure transform, no n8n runtime dependency.
//
// The engine is the single source of truth for classification, correlation, deduplication and
// ordering -- this module discovers response.analyticsReportingRows wherever the upstream n8n
// node wrapped it, sanitizes sensitive visitor/session/linker identifiers wherever they appear
// (top-level fields, rawEvidenceJson, nested/encoded URLs, GA4 request/response bodies), adds
// snake_case compatibility aliases, and derives one small n8n-side-only field (adoptionStatus)
// from diagnostics.surfaceAdoption -- it never re-derives anything the engine already decided,
// and never computes milestone completion from analytics.
//
// To use inside n8n's Code node, paste the body of this file (minus the `export` keywords) and
// end it with:
//   return buildAnalyticsReportingRowsItems($input.all().map((item) => item.json));
// (see build-analytics-reporting-rows-node.js, generated from this file, for the ready-to-paste
// version).

// ---------------------------------------------------------------------------------------------
// Sensitive-key matching. Broad legacy pattern (kept for backward compatibility -- it already
// catches things like "sessionToken" or "apiKey" via substring match) plus precise, anchored
// patterns for the specific analytics/linker identifiers that must never reach a report,
// covering both camelCase and snake_case spellings. Matching is by normalized key name, never by
// scanning a value's text for a substring -- a legitimate field is never redacted just because
// part of its value happens to look like a sensitive token.
// ---------------------------------------------------------------------------------------------

const LEGACY_SENSITIVE_KEY_PATTERN = /token|password|secret|cookie|session|auth|api[-_]?key/i;

const IDENTIFIER_KEY_PATTERNS: RegExp[] = [
  /^cid$/i,
  /^client[-_]?id$/i,
  /^up\.client[-_]?id$/i,
  /^_?fplc$/i,
  /^_?fpau$/i,
  /^_gl$/i,
  /^_ga(_[A-Za-z0-9]+)?$/i,
  /^_?gcl[-_]?au$/i,
  /^gclid$/i,
  /^dclid$/i,
  /^gbraid$/i,
  /^wbraid$/i,
  /^user[-_]?id$/i,
  /^session[-_]?id$/i,
  /^sid$/i,
  /^ecid$/i,
  /^evnid$/i,
  /^sst\.rnd$/i,
];

function isRedactedKey(key: string): boolean {
  if (LEGACY_SENSITIVE_KEY_PATTERN.test(key)) return true;
  return IDENTIFIER_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

const REDACTED = "[redacted]";

// ---------------------------------------------------------------------------------------------
// Deep, generic sanitizer. Walks any value -- object, array, JSON-string, URL-string, or bare
// application/x-www-form-urlencoded string -- recursively, redacting matched keys and never
// mutating its input. Because it inspects VALUES structurally (is this a URL? a query string? a
// JSON document?) rather than keying off a hardcoded field-name list, it automatically covers
// every camelCase/snake_case field pair, every nested evidence shape (rawEvidenceJson,
// raw_evidence_json, GA4 request/response params, gtm.elementUrl, ep.full_url, dl, ...) and any
// future field with the same shape, without the core ever knowing a brand- or platform-specific
// field name.
// ---------------------------------------------------------------------------------------------

const MAX_DEPTH = 24;
const MAX_DECODE_ITERATIONS = 4;
const PLACEHOLDER_BASE = "http://placeholder.invalid";

const ABSOLUTE_URL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const RELATIVE_URL_WITH_QUERY_PATTERN = /^\/[^\s?]*\?\S*$/;
const QUERY_STRING_PATTERN = /^[^\s&=]+=[^\s&]*(&[^\s&=]+=[^\s&]*)+$/;

function looksLikeUrl(value: string): boolean {
  return ABSOLUTE_URL_PATTERN.test(value) || RELATIVE_URL_WITH_QUERY_PATTERN.test(value);
}

function looksLikeJsonString(trimmed: string): boolean {
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

function looksLikeQueryString(value: string): boolean {
  return QUERY_STRING_PATTERN.test(value);
}

function decodeFormComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20"));
  } catch {
    return value;
  }
}

function reencode(value: string, times: number): string {
  let out = value;
  for (let i = 0; i < times; i += 1) out = encodeURIComponent(out);
  return out;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input)) {
      out[key] = isRedactedKey(key) ? REDACTED : sanitizeValue(input[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") {
    return sanitizeStringValue(value, depth);
  }
  return value;
}

function sanitizeStringValue(value: string, depth: number): string {
  if (value.length === 0 || depth > MAX_DEPTH) return value;
  const trimmed = value.trim();
  if (looksLikeJsonString(trimmed)) return sanitizeJsonString(value, depth);
  if (looksLikeUrl(value)) return sanitizeUrlLike(value, depth);
  if (looksLikeQueryString(value)) return sanitizeQueryString(value, depth);
  return value;
}

function sanitizeJsonString(value: string, depth: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return value; // not JSON -- left as-is rather than mangled
  }
  const sanitized = sanitizeValue(parsed, depth + 1);
  try {
    return JSON.stringify(sanitized);
  } catch {
    return value;
  }
}

// A GA4/gtag "_gl" linker value embeds other identifiers (_ga, _gcl_au, FPAU, _fplc, ...) in an
// internal, versioned, undocumented encoding. Rather than partially decoding it (and risking a
// future encoding change silently letting an embedded identifier back through), "_gl" is matched
// by IDENTIFIER_KEY_PATTERNS and redacted wholesale wherever it appears as a key -- see
// isRedactedKey.

function sanitizeUrlLike(value: string, depth: number): string {
  if (depth > MAX_DEPTH) return value;
  const isAbsolute = ABSOLUTE_URL_PATTERN.test(value);
  let url: URL;
  try {
    url = isAbsolute ? new URL(value) : new URL(value, PLACEHOLDER_BASE);
  } catch {
    return value; // not a parseable URL -- left as-is, never guessed at
  }

  let changed = false;
  const newParams = new URLSearchParams();
  for (const [key, paramValue] of url.searchParams.entries()) {
    if (isRedactedKey(key)) {
      newParams.append(key, REDACTED);
      changed = true;
      continue;
    }
    const sanitized = sanitizeParamValue(paramValue, depth + 1);
    if (sanitized !== paramValue) changed = true;
    newParams.append(key, sanitized);
  }

  if (!changed) return value; // no-op: preserve the original string exactly
  url.search = newParams.toString();
  return isAbsolute ? url.toString() : url.pathname + url.search + url.hash;
}

function sanitizeQueryString(value: string, depth: number): string {
  if (depth > MAX_DEPTH) return value;
  const pairs = value.split("&").map((pair) => {
    const idx = pair.indexOf("=");
    const rawKey = idx === -1 ? pair : pair.slice(0, idx);
    const rawValue = idx === -1 ? "" : pair.slice(idx + 1);
    const key = decodeFormComponent(rawKey);
    const decodedValue = decodeFormComponent(rawValue);
    const finalValue = isRedactedKey(key) ? REDACTED : sanitizeParamValue(decodedValue, depth + 1);
    return `${encodeURIComponent(key)}=${encodeURIComponent(finalValue)}`;
  });
  return pairs.join("&");
}

// A query-parameter value can itself be a URL, a JSON document, or another query string --
// possibly percent-encoded one or more times (e.g. a "customBackUrl" nested inside a URL,
// double-encoded). This decodes bounded-iteratively, sanitizes the first recognizable shape it
// finds, then re-encodes exactly as many times as it decoded, so the surrounding structure is
// preserved.
function sanitizeParamValue(value: string, depth: number): string {
  if (depth > MAX_DEPTH || value.length === 0) return value;
  let current = value;
  let decodes = 0;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i += 1) {
    if (looksLikeUrl(current)) {
      return reencode(sanitizeUrlLike(current, depth + 1), decodes);
    }
    const trimmed = current.trim();
    if (looksLikeJsonString(trimmed)) {
      return reencode(sanitizeJsonString(current, depth + 1), decodes);
    }
    if (decodes > 0 && looksLikeQueryString(current)) {
      return reencode(sanitizeQueryString(current, depth + 1), decodes);
    }
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    current = next;
    decodes += 1;
  }
  return value;
}

// Backward-compatible named exports (used directly by existing tests and any external caller).
export function sanitizeUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  return sanitizeStringValue(url, 0);
}

export function sanitizeRawEvidenceJson(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return raw;
  return sanitizeStringValue(raw, 0);
}

// ---------------------------------------------------------------------------------------------
// snake_case compatibility aliases. Generic camelCase -> snake_case conversion, applied to every
// field on a row (not a hardcoded field list), so legacy consumers built against the old
// hand-rolled node's snake_case output keep working. Aliases are derived from the already
// sanitized value, so a camelCase field and its snake_case alias always carry the identical
// sanitized value.
// ---------------------------------------------------------------------------------------------

function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

function addSnakeCaseAliases(row: AnalyticsReportingRow): void {
  for (const key of Object.keys(row)) {
    const snakeKey = toSnakeCase(key);
    if (snakeKey !== key && !(snakeKey in row)) {
      row[snakeKey] = row[key];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Adoption-status derivation (unchanged from the previous implementation).
// ---------------------------------------------------------------------------------------------

interface SurfaceAdoptionAttempt {
  stepIndex: number;
  surfaceId: string;
  event: string;
}

type AnalyticsReportingRow = Record<string, unknown>;
type TaskResponseLike = {
  analyticsReportingRows?: AnalyticsReportingRow[];
  diagnostics?: { surfaceAdoption?: { attempts?: SurfaceAdoptionAttempt[] } };
  [key: string]: unknown;
};

/**
 * Derives adoptionStatus for popup-sourced rows from diagnostics.surfaceAdoption.attempts --
 * an n8n-side-only convenience field (the engine does not stamp this onto a row directly).
 * "adopted" / "rejected" reflect the outcome at the step that opened the candidate;
 * "returned" / "return_failed" / "closed_unexpectedly" reflect a later terminal event on that
 * same adopted surface, when one occurred. Purely additive -- never alters or drops a row, and
 * absent when unknown.
 */
function buildAdoptionStatusLookup(attempts: SurfaceAdoptionAttempt[] | undefined) {
  const openEventByStep = new Map<number, { event: string; surfaceId: string }>();
  const terminalEventBySurface = new Map<string, string>();
  for (const attempt of attempts || []) {
    if (attempt.event === "adopted" || attempt.event === "rejected") {
      openEventByStep.set(attempt.stepIndex, { event: attempt.event, surfaceId: attempt.surfaceId });
    } else if (attempt.event === "returned" || attempt.event === "return_failed" || attempt.event === "closed_unexpectedly") {
      terminalEventBySurface.set(attempt.surfaceId, attempt.event);
    }
  }
  return { openEventByStep, terminalEventBySurface };
}

function adoptionStatusForRow(
  row: AnalyticsReportingRow,
  lookup: ReturnType<typeof buildAdoptionStatusLookup>,
): string | undefined {
  if (row.evidenceSource !== "popup_context" || typeof row.contextId !== "string") {
    return row.evidenceSource === "main_frame" ? "not_applicable" : undefined;
  }
  const match = /^popup:(\d+)$/.exec(row.contextId);
  if (!match) return undefined;
  const openEvent = lookup.openEventByStep.get(Number(match[1]));
  if (!openEvent) return undefined;
  if (openEvent.event === "rejected") return "rejected";
  const terminal = lookup.terminalEventBySurface.get(openEvent.surfaceId);
  return terminal || "adopted";
}

// ---------------------------------------------------------------------------------------------
// Bounded, generic discovery of analyticsReportingRows inside an arbitrarily-wrapped n8n item.
// The engine's TaskResponse can arrive nested at different depths depending on which n8n nodes
// sit between "Navigation Engine - Get Task Result" and this one (an HTTP Request node wraps a
// JSON body in { headers, statusCode, statusMessage, body }; other setups may nest it under
// result/data/response). A list of known wrapper shapes is checked first (fast path, and the
// list a future maintainer extends first); a bounded, circular-reference-safe recursive search
// is the fallback. Never silently returns nothing -- a genuinely missing field throws, naming
// what was expected, what was searched, and what the item actually contained.
// ---------------------------------------------------------------------------------------------

const PREFERRED_WRAPPER_PATHS: string[][] = [
  [],
  ["body"],
  ["result"],
  ["body", "result"],
  ["body", "result", "result"],
  ["data"],
  ["response"],
  ["taskResult"],
  ["taskResponse"],
  ["output"],
];

const MAX_DISCOVERY_DEPTH = 6;

function getAtPath(root: unknown, path: string[]): unknown {
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isReportingRowsContainer(value: unknown): value is TaskResponseLike {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).analyticsReportingRows)
  );
}

function findContainerRecursively(root: unknown, maxDepth: number): { container: TaskResponseLike; depth: number } | undefined {
  const visited = new WeakSet<object>();
  const queue: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];

  while (queue.length > 0) {
    const { value, depth } = queue.shift()!;
    if (value === null || typeof value !== "object") continue;
    if (visited.has(value as object)) continue;
    visited.add(value as object);

    if (isReportingRowsContainer(value)) {
      return { container: value, depth };
    }
    if (depth >= maxDepth) continue;

    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return undefined;
}

interface DiscoveredContainer {
  rows: AnalyticsReportingRow[];
  diagnostics: TaskResponseLike["diagnostics"];
}

function describePath(path: string[]): string {
  return path.length === 0 ? "(top level)" : path.join(".");
}

function discoverAnalyticsReportingRowsContainer(item: unknown, itemIndex: number, totalItems: number): DiscoveredContainer {
  for (const path of PREFERRED_WRAPPER_PATHS) {
    const candidate = getAtPath(item, path);
    if (isReportingRowsContainer(candidate)) {
      return { rows: candidate.analyticsReportingRows as AnalyticsReportingRow[], diagnostics: candidate.diagnostics };
    }
  }

  const recursive = findContainerRecursively(item, MAX_DISCOVERY_DEPTH);
  if (recursive) {
    return {
      rows: recursive.container.analyticsReportingRows as AnalyticsReportingRow[],
      diagnostics: recursive.container.diagnostics,
    };
  }

  const topLevelKeys =
    item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item as Record<string, unknown>) : [];
  const searchedPaths = PREFERRED_WRAPPER_PATHS.map(describePath).join(", ");
  throw new Error(
    `Build Analytics Reporting Rows: could not locate "analyticsReportingRows" on input item ${itemIndex + 1} of ${totalItems}. ` +
      `Available top-level keys on this item: [${topLevelKeys.join(", ") || "none"}]. ` +
      `Searched wrapper locations: ${searchedPaths}, plus a recursive search up to depth ${MAX_DISCOVERY_DEPTH}. ` +
      `Confirm the "Navigation Engine - Get Task Result" node is connected and returning a TaskResponse with analyticsReportingRows.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Pure transform: an array of n8n-item-shaped ($input.all().map((item) => item.json)) values in,
// an array of n8n-item-shaped rows ({ json }) out. Never filters a row on navigationSuccessful,
// whether the opener URL changed, or overall run status -- every row the engine emitted is
// preserved.
// ---------------------------------------------------------------------------------------------

export function buildAnalyticsReportingRowsItems(items: unknown[]): { json: AnalyticsReportingRow }[] {
  const outputRows: AnalyticsReportingRow[] = [];
  const seenEventIds = new Set<string>();

  items.forEach((item, index) => {
    const { rows, diagnostics } = discoverAnalyticsReportingRowsContainer(item, index, items.length);
    const attempts = diagnostics?.surfaceAdoption?.attempts;
    const lookup = buildAdoptionStatusLookup(attempts);

    for (const row of rows) {
      // Deduplicate only truly equivalent records: the engine already guarantees a stable
      // eventId is unique per logical event; this is a defensive, engine-agnostic backstop
      // only, never a looser heuristic.
      const eventId = typeof row.eventId === "string" ? row.eventId : undefined;
      if (eventId) {
        if (seenEventIds.has(eventId)) continue;
        seenEventIds.add(eventId);
      }

      const sanitized = sanitizeValue(row, 0) as AnalyticsReportingRow;

      const adoptionStatus = adoptionStatusForRow(sanitized, lookup);
      if (adoptionStatus) {
        sanitized.adoptionStatus = adoptionStatus;
      }

      addSnakeCaseAliases(sanitized);
      outputRows.push(sanitized);
    }
  });

  // Deterministic journey ordering: the engine already emits rows in journeySequence order;
  // this sort is a defensive guarantee only (a no-op on already-sorted input).
  outputRows.sort((a, b) => ((a.journeySequence as number) ?? 0) - ((b.journeySequence as number) ?? 0));

  return outputRows.map((json) => ({ json }));
}
