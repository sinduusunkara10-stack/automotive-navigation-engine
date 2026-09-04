import type { Page, Request } from "playwright";
import type { Captures, Ga4NetworkEventCapture } from "../types/task-response.js";
import { appendBounded } from "../core/boundedArray.js";
import { MAX_GA4_NETWORK_EVENTS } from "../config/captureLimits.js";

const GA4_COLLECT_PATH = "/g/collect";

// Bounded wait applied after a click, only when both cta_clicks and ga4_network_events are
// requested, so a GA4 beacon fired asynchronously just after the click (common right before
// or during a navigation) is reliably inside the window correlated with that click -- see
// src/core/loop.ts's action-attributed analytics capture. Deliberately short: this is a
// correlation window, not a wait for full page settling (the engine's own navigation
// handling already covers that separately).
export const GA4_ACTION_WINDOW_MS = 300;

/**
 * GA4-style requests can fire at any point during a page's lifetime (on load, on a
 * click), not only when a `capture` action is dispatched. This module therefore
 * attaches a request listener for the lifetime of the run rather than sampling the
 * page once, so it doesn't miss traffic generated between explicit capture steps.
 */
export function attachGa4NetworkCapture(page: Page, captures: Captures, getStepIndex: () => number): () => void {
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

    const entry: Ga4NetworkEventCapture = {
      stepIndex: getStepIndex(),
      requestUrl: request.url(),
      timestamp: new Date().toISOString(),
      ...(Object.keys(params).length > 0 ? { params } : {}),
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
