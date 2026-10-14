import type { Page, Request, Response } from "playwright";

/**
 * Sanitised, diagnostic-only network evidence for a single xhr/fetch request observed during a
 * dealer-lookup window. Never carries a request body, a response body's actual content, or any
 * typed/returned value (postcode, address, dealer name, email, phone, etc.) -- only method,
 * timing, status, content-type, and a record-presence heuristic derived from response *shape*
 * (array length), never response *content*.
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
  /** Heuristic only, derived from response shape, never content: a JSON array, or an object
   * holding at least one array-valued field, with length > 0. Null when this could never be
   * safely determined (failed/pending, non-JSON content-type, or the body could not be read
   * within the bounded read timeout). */
  appearsToContainRecords: boolean | null;
  /** Only ever a count, never the records themselves. Null under the same conditions as above. */
  recordCount: number | null;
}

/** Bounded independent of how many requests a live page actually fires -- a chatty page can
 * never grow this payload unbounded. */
export const DEALER_LOOKUP_NETWORK_MAX_REQUESTS = 5;
const JSON_BODY_READ_TIMEOUT_MS = 500;

function sanitizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").map((segment) => (segment.length > 0 && /\d/.test(segment) ? "{param}" : segment));
    return `${parsed.origin}${segments.join("/")}`;
  } catch {
    return "unparseable-url";
  }
}

function isRelevantResourceType(resourceType: string): boolean {
  return resourceType === "xhr" || resourceType === "fetch";
}

async function deriveRecordEvidence(response: Response): Promise<{ appearsToContainRecords: boolean | null; recordCount: number | null }> {
  const contentType = response.headers()["content-type"] ?? "";
  if (!contentType.includes("json")) return { appearsToContainRecords: null, recordCount: null };
  try {
    const body: unknown = await Promise.race([
      response.json(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), JSON_BODY_READ_TIMEOUT_MS)),
    ]);
    if (Array.isArray(body)) return { appearsToContainRecords: body.length > 0, recordCount: body.length };
    if (body && typeof body === "object") {
      const arrayField = Object.values(body as Record<string, unknown>).find((value): value is unknown[] => Array.isArray(value));
      if (arrayField) return { appearsToContainRecords: arrayField.length > 0, recordCount: arrayField.length };
      return { appearsToContainRecords: false, recordCount: 0 };
    }
    return { appearsToContainRecords: null, recordCount: null };
  } catch {
    return { appearsToContainRecords: null, recordCount: null };
  }
}

export interface DealerLookupNetworkCapture {
  /** Detaches the listeners and returns the sanitised evidence collected so far. Idempotent
   * is not required -- called exactly once, from a `finally`, by resolveDealerLookup. */
  stop(): Promise<SanitizedNetworkRequestEvidence[]>;
}

/**
 * Observes only sanitised request/response metadata for xhr/fetch requests that start while
 * active. Correlation to the dealer-lookup window is deliberately simple -- "started while this
 * capture was running" -- never tied to a specific selector, URL, or brand. Never reads a request
 * body. Never logs or persists the raw trace anywhere -- the caller only ever receives the
 * sanitised summary below, which is itself only exposed under FORM_DISCOVERY_DIAGNOSTIC=1.
 */
export function startDealerLookupNetworkCapture(page: Page): DealerLookupNetworkCapture {
  const start = Date.now();
  const entries: SanitizedNetworkRequestEvidence[] = [];
  const pending = new Map<Request, SanitizedNetworkRequestEvidence>();

  const onRequest = (request: Request): void => {
    if (!isRelevantResourceType(request.resourceType())) return;
    if (entries.length >= DEALER_LOOKUP_NETWORK_MAX_REQUESTS) return;
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
    };
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
    void deriveRecordEvidence(response)
      .then((derived) => {
        evidence.appearsToContainRecords = derived.appearsToContainRecords;
        evidence.recordCount = derived.recordCount;
      })
      .catch(() => {});
  };

  const onRequestFailed = (request: Request): void => {
    const evidence = pending.get(request);
    if (!evidence) return;
    pending.delete(request);
    evidence.outcome = "failed";
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  return {
    async stop() {
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
      // Give any in-flight response/JSON-body handler a brief moment to settle before this
      // capture's evidence is read -- otherwise a response that arrived a few ms before stop()
      // would be misreported as still "pending".
      await new Promise((resolve) => setTimeout(resolve, 100));
      return entries.slice(0, DEALER_LOOKUP_NETWORK_MAX_REQUESTS);
    },
  };
}

/** Human-readable, still fully sanitised summary of the captured evidence -- never includes a
 * URL, a status code's originating endpoint, or any derived-record count by name; only aggregate
 * counts. */
export function summarizeDealerLookupNetworkActivity(requests: SanitizedNetworkRequestEvidence[]): string {
  if (requests.length === 0) return "no xhr/fetch request was observed during the dealer-lookup window";
  const completed = requests.filter((r) => r.outcome === "completed");
  const failed = requests.filter((r) => r.outcome === "failed");
  const pending = requests.filter((r) => r.outcome === "pending");
  const withRecords = completed.filter((r) => r.appearsToContainRecords === true);
  const parts = [`${requests.length} xhr/fetch request(s) observed`];
  if (completed.length > 0) parts.push(`${completed.length} completed`);
  if (failed.length > 0) parts.push(`${failed.length} failed`);
  if (pending.length > 0) parts.push(`${pending.length} still pending when capture stopped`);
  if (withRecords.length > 0) parts.push(`${withRecords.length} appear to carry records`);
  else if (completed.length > 0) parts.push("none of the completed requests appear to carry records");
  return parts.join(", ");
}
