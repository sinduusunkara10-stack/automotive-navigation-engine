import type { Page, Request } from "playwright";

import { isGa4CollectUrl, readGa4EventNames } from "../capture-modules/ga4NetworkEvents.js";
import type { PostTerminalAnalyticsProbeDiagnostics, PostTerminalAnalyticsProbeHit } from "../types/task-response.js";

/**
 * Diagnostics-only: after a successful run's terminal decision and after the normal capture
 * listeners are detached, listens passively for GA4 collect requests on every page of the run's
 * browser context for a fixed time. It never navigates, clicks or touches `captures`; a late hit
 * is recorded only in the returned diagnostics, so it never reaches captures or reporting rows.
 */
export async function runPostTerminalAnalyticsProbe(params: {
  activePage: Page;
  terminalDecisionAt: string;
  durationMs: number;
}): Promise<PostTerminalAnalyticsProbeDiagnostics> {
  const { activePage, terminalDecisionAt, durationMs } = params;
  const terminalDecisionMs = Date.parse(terminalDecisionAt);
  const context = activePage.context();
  const lateHits: PostTerminalAnalyticsProbeHit[] = [];

  const onRequest = (request: Request) => {
    if (!isGa4CollectUrl(request.url())) {
      return;
    }
    const now = Date.now();
    let requestHost = "";
    let requestPath = "";
    try {
      const url = new URL(request.url());
      requestHost = url.host;
      requestPath = url.pathname;
    } catch {
      /* isGa4CollectUrl already parsed it */
    }
    let requestPage: Page | null = null;
    try {
      requestPage = request.frame().page();
    } catch {
      requestPage = null;
    }
    const pageIndex = requestPage ? context.pages().indexOf(requestPage) : -1;
    lateHits.push({
      timestamp: new Date(now).toISOString(),
      msAfterTerminalDecision: now - terminalDecisionMs,
      eventNames: readGa4EventNames(request),
      requestHost,
      requestPath,
      method: request.method(),
      ...(pageIndex >= 0 ? { pageIndex } : {}),
      ...(requestPage ? { isActivePage: requestPage === activePage } : {}),
    });
  };

  const startedMs = Date.now();
  context.on("request", onRequest);
  try {
    // A plain timer, not page.waitForTimeout: the page may close while the probe waits.
    await new Promise((resolve) => setTimeout(resolve, durationMs));
  } finally {
    context.off("request", onRequest);
  }
  const endedMs = Date.now();

  return {
    enabled: true,
    configuredDurationMs: durationMs,
    terminalDecisionAt,
    probeStartedAt: new Date(startedMs).toISOString(),
    probeEndedAt: new Date(endedMs).toISOString(),
    probeDurationMs: endedMs - startedMs,
    lateHitCount: lateHits.length,
    lateHits,
  };
}
