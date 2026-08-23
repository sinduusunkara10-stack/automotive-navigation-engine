import type { Page, Request } from "playwright";
import type { Captures, Ga4NetworkEventCapture } from "../types/task-response.js";

const GA4_COLLECT_PATH = "/g/collect";

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
    captures.ga4_network_events = [...(captures.ga4_network_events ?? []), entry];
  };

  page.on("request", handler);
  return () => page.off("request", handler);
}
