import type { Frame, Page, Request } from "playwright";
import type { Captures, EvidenceCaptureSource, Ga4NetworkEventCapture } from "../types/task-response.js";
import { appendBounded } from "../core/boundedArray.js";
import { MAX_GA4_NETWORK_EVENTS, MAX_GA4_POST_BODY_BYTES } from "../config/captureLimits.js";

const GA4_COLLECT_PATH = "/g/collect";

// Bounded wait applied after a click, only when both cta_clicks and ga4_network_events are
// requested, so a GA4 beacon fired asynchronously just after the click (common right before
// or during a navigation) is reliably inside the window correlated with that click -- see
// src/core/loop.ts's action-attributed analytics capture. Deliberately short: this is a
// correlation window, not a wait for full page settling (the engine's own navigation
// handling already covers that separately). Not the *only* correlation mechanism -- see
// stepIndex/contextId, which every entry always carries regardless of this window.
export const GA4_ACTION_WINDOW_MS = 300;

/**
 * Standard GA4 Measurement Protocol parameter names this module reads mechanically --
 * fixed, protocol-level names defined by Google's own GA4 wire format (not any particular
 * automotive client's vocabulary), the same category of name this module already reads
 * (every other query/body key is preserved as-is, unfiltered -- see params/postDataParams
 * below). Never inferred, never guessed: absent when the key itself is absent.
 */
const MEASUREMENT_ID_PARAM = "tid";
const CONSENT_STATE_PARAM_KEYS = ["gcs", "dma", "dma_cps"] as const;

function firstDefined(paramSources: Record<string, string>[], key: string): string | undefined {
  for (const params of paramSources) {
    if (params[key] !== undefined) {
      return params[key];
    }
  }
  return undefined;
}

function extractConsentState(paramSources: Record<string, string>[]): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const key of CONSENT_STATE_PARAM_KEYS) {
    const value = firstDefined(paramSources, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Generically parses a raw request body as form-urlencoded ("key=value&key=value", one
 * entry per newline-delimited line, matching how a batched GA4 sendBeacon body concatenates
 * multiple hits) -- never a client-specific parsing rule, and never a guess: a body that
 * doesn't unambiguously look like this (no "=" on some non-empty line) is left unparsed
 * (undefined) rather than returning a partial/wrong result.
 */
function tryParseFormEncodedBody(raw: string): Record<string, string>[] | undefined {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return undefined;
  }
  const parsed: Record<string, string>[] = [];
  for (const line of lines) {
    if (!line.includes("=")) {
      return undefined;
    }
    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(line).entries()) {
      params[key] = value;
    }
    if (Object.keys(params).length === 0) {
      return undefined;
    }
    parsed.push(params);
  }
  return parsed;
}

function classifyRequestFrame(page: Page, request: Request): { source: EvidenceCaptureSource; frameOrigin?: string } {
  let frame: Frame | null = null;
  try {
    frame = request.frame();
  } catch {
    frame = null;
  }
  if (!frame || frame === page.mainFrame()) {
    return { source: "main_frame" };
  }
  let frameOrigin: string | undefined;
  try {
    frameOrigin = new URL(frame.url()).origin;
  } catch {
    frameOrigin = undefined;
  }
  return { source: "child_frame", ...(frameOrigin ? { frameOrigin } : {}) };
}

export interface Ga4NetworkCaptureContext {
  /** See src/capture-modules/captureContext.ts. Omitted only by legacy/untagged callers. */
  contextId?: string;
  /** Set when attaching to an adopted popup Page -- every request observed there is tagged "popup_context" regardless of which of the popup's own frames it came from. */
  forcedSource?: EvidenceCaptureSource;
}

/**
 * GA4-style requests can fire at any point during a page's lifetime (on load, on a
 * click), not only when a `capture` action is dispatched. This module therefore
 * attaches a request listener for the lifetime of the run rather than sampling the
 * page once, so it doesn't miss traffic generated between explicit capture steps.
 *
 * Reads query-string parameters (unchanged from before this fix) *and* -- for a
 * POST/sendBeacon hit, whose event data can live in the body instead of the query string
 * -- the raw body (bounded, see MAX_GA4_POST_BODY_BYTES) plus a generic, best-effort
 * form-urlencoded parse of it (never a client-specific rule; see tryParseFormEncodedBody).
 * measurementId/consentState are mechanically read from the union of query+body params
 * using GA4's own fixed protocol parameter names -- never invented when absent.
 */
export function attachGa4NetworkCapture(
  page: Page,
  captures: Captures,
  getStepIndex: () => number,
  context: Ga4NetworkCaptureContext = {},
): () => void {
  const handler = (request: Request) => {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (!url.pathname.endsWith(GA4_COLLECT_PATH)) {
      return;
    }

    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      params[key] = value;
    }

    const method = request.method();
    let postDataRaw: string | undefined;
    let postDataParams: Record<string, string>[] | undefined;
    let truncated = false;
    if (method !== "GET" && method !== "HEAD") {
      let raw: string | null = null;
      try {
        raw = request.postData();
      } catch {
        raw = null;
      }
      if (raw) {
        if (raw.length > MAX_GA4_POST_BODY_BYTES) {
          postDataRaw = raw.slice(0, MAX_GA4_POST_BODY_BYTES);
          truncated = true;
        } else {
          postDataRaw = raw;
        }
        postDataParams = tryParseFormEncodedBody(postDataRaw);
      }
    }

    const paramSources = Object.keys(params).length > 0 ? [params, ...(postDataParams ?? [])] : postDataParams ?? [];
    const measurementId = firstDefined(paramSources, MEASUREMENT_ID_PARAM);
    const consentState = extractConsentState(paramSources);

    const frameClassification = context.forcedSource
      ? { source: context.forcedSource }
      : classifyRequestFrame(page, request);

    const entry: Ga4NetworkEventCapture = {
      stepIndex: getStepIndex(),
      requestUrl: request.url(),
      timestamp: new Date().toISOString(),
      method,
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(postDataRaw ? { postDataRaw } : {}),
      ...(postDataParams ? { postDataParams } : {}),
      ...(measurementId ? { measurementId } : {}),
      ...(consentState ? { consentState } : {}),
      source: frameClassification.source,
      ...(context.contextId ? { contextId: context.contextId } : {}),
      ...(frameClassification.frameOrigin ? { frameOrigin: frameClassification.frameOrigin } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
    // Bounded to the most recent MAX_GA4_NETWORK_EVENTS entries -- this listener runs for
    // the whole lifetime of the run (see this function's own comment above), so an
    // unbounded array here grows without limit on a chatty page or a long/high-maxSteps
    // run. See src/core/boundedArray.ts.
    captures.ga4_network_events = appendBounded(captures.ga4_network_events ?? [], entry, MAX_GA4_NETWORK_EVENTS);
  };

  page.on("request", handler);
  return () => page.off("request", handler);
}

/**
 * Resource Timing fallback snapshot: a GA4 hit fired as a GET-style pixel (`new
 * Image().src = ...`, the common cross-browser-compatible beacon shape) before
 * attachGa4NetworkCapture's own listener was attached -- most plausibly a destination
 * document's own page-load beacon, fired from an inline <head>/<body> script during initial
 * parse, before this engine's popup-adoption code can run on the Node side (see
 * popupCapture.ts's adoptOrCapturePopup) -- is otherwise permanently lost: Playwright's
 * request listener never replays a request that completed before it was registered. The
 * browser's own Resource Timing buffer (`performance.getEntriesByType("resource")`) already
 * records every such load for the lifetime of the page, independent of any listener, so this
 * reads it directly as a one-shot, best-effort recovery pass -- mirroring the existing
 * window.dataLayer snapshot fallback this same gap already has (see dataLayer.ts's
 * captureDataLayer) for the one evidence type that previously had no equivalent. Only
 * recovers a GET request (no body is available via this API, matching the existing
 * GET-only caveat the live listener already has for postDataParams) and never a
 * `navigator.sendBeacon()` POST, which this browser API does not expose either way -- a
 * strict improvement over the previous all-or-nothing reliance on listener-attach timing,
 * never a weakening of what the live listener already captures.
 */
async function readGa4ResourceTimingUrls(page: Page): Promise<string[]> {
  return page
    .evaluate((collectPath) => {
      try {
        return performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => {
            try {
              return new URL(name).pathname.endsWith(collectPath);
            } catch {
              return false;
            }
          });
      } catch {
        return [];
      }
    }, GA4_COLLECT_PATH)
    .catch(() => []);
}

export async function captureGa4FromResourceTiming(
  page: Page,
  stepIndex: number,
  context: Ga4NetworkCaptureContext = {},
): Promise<Ga4NetworkEventCapture[]> {
  const urls = await readGa4ResourceTimingUrls(page);
  const timestamp = new Date().toISOString();
  const entries: Ga4NetworkEventCapture[] = [];
  for (const rawUrl of urls) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      continue;
    }
    const params: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) {
      params[key] = value;
    }
    const measurementId = firstDefined([params], MEASUREMENT_ID_PARAM);
    const consentState = extractConsentState([params]);
    entries.push({
      stepIndex,
      requestUrl: rawUrl,
      timestamp,
      method: "GET",
      ...(Object.keys(params).length > 0 ? { params } : {}),
      ...(measurementId ? { measurementId } : {}),
      ...(consentState ? { consentState } : {}),
      source: context.forcedSource ?? "main_frame",
      ...(context.contextId ? { contextId: context.contextId } : {}),
    });
  }
  return entries;
}

/**
 * Merges a captureGa4FromResourceTiming snapshot into captures.ga4_network_events,
 * skipping any requestUrl the live listener already captured (exact-match dedupe -- each
 * GA4 hit's own query string, including its event name, is part of its URL, so two
 * genuinely distinct hits never collide here). Bounded the same way the live listener
 * bounds its own appends.
 */
export function mergeGa4ResourceTimingSnapshot(captures: Captures, snapshot: Ga4NetworkEventCapture[]): void {
  const alreadyCaptured = new Set((captures.ga4_network_events ?? []).map((entry) => entry.requestUrl));
  for (const entry of snapshot) {
    if (alreadyCaptured.has(entry.requestUrl)) {
      continue;
    }
    captures.ga4_network_events = appendBounded(captures.ga4_network_events ?? [], entry, MAX_GA4_NETWORK_EVENTS);
    alreadyCaptured.add(entry.requestUrl);
  }
}
