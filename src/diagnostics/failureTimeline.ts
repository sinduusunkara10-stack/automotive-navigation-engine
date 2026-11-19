import type { EngineFailureContext, PageStateSnapshot } from "../types/failureDiagnostics.js";

function describeState(s: PageStateSnapshot): string {
  return `surface=${s.activeSurface} page=${s.activePageId}${s.activePageClosed ? "(closed)" : ""} url=${s.activePageUrl} open=[${s.openPages
    .map((p) => p.id)
    .join(",")}]`;
}

/**
 * Concise, time-ordered timeline of one failed run's page lifecycle and dispatched actions,
 * one log line per entry. Pure formatting over already-collected EngineFailureContext data --
 * used only for Render logging when NAV_FAILURE_DIAGNOSTICS_LOG is on; never feeds errorDetails.
 */
export function buildFailureTimeline(params: {
  runId: string;
  taskId: string;
  context: EngineFailureContext | undefined;
  errorMessage: string;
}): string[] {
  const { runId, taskId, context, errorMessage } = params;
  const prefix = `[navigation-engine] [timeline] runId=${runId} taskId=${taskId}`;
  const entries: { at: string; text: string }[] = [];

  for (const event of context?.pageLifecycle ?? []) {
    const parts: string[] = [event.kind];
    if (event.surfaceId) parts.push(`surface=${event.surfaceId}`);
    if (event.pageId) parts.push(`page=${event.pageId}`);
    if (event.openerPageId) parts.push(`opener=${event.openerPageId}`);
    if (event.closedBy) parts.push(`closedBy=${event.closedBy}`);
    if (event.closeReason) parts.push(`reason=${event.closeReason}`);
    if (event.url) parts.push(`url=${event.url}`);
    entries.push({ at: event.at, text: parts.join(" ") });
  }

  for (const record of context?.actionTrace ?? []) {
    const goBack = record.goBack
      ? ` source=${record.goBack.source} dispatchedAs=${record.goBack.dispatchedAs}${
          record.goBack.substitutedFor ? ` substitutedFor=${record.goBack.substitutedFor}` : ""
        }`
      : "";
    const journeyMemory = record.journeyMemory
      ? ` journeyMemory=offered:${record.journeyMemory.guidanceOffered},recoveryCall:${record.journeyMemory.recoveryCallFired}`
      : "";
    const target = record.targetElementId ? ` target=${record.targetElementId}` : "";
    entries.push({
      at: record.before.at,
      text: `action step=${record.stepIndex} ${record.actionType}${target}${goBack}${journeyMemory} before: ${describeState(record.before)}`,
    });
    if (record.after) {
      entries.push({
        at: record.after.at,
        text:
          `action_done step=${record.stepIndex} ${record.actionType} success=${record.after.success}` +
          `${record.after.resultingUrl ? ` resultingUrl=${record.after.resultingUrl}` : ""} after: ${describeState(record.after)}` +
          ` stepPage=${record.after.stepPageId}${record.after.stepPageClosed ? "(closed)" : ""}`,
      });
    }
  }

  entries.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const lines = entries.map((entry) => `${prefix} ${entry.at} ${entry.text}`);
  lines.push(
    `${prefix} failed step=${context?.stepCount ?? "?"} activeSurface=${context?.activeSurface ?? "?"} activePage=${
      context?.activePageId ?? "?"
    }${context?.activePageClosed ? "(closed)" : ""} currentUrl=${context?.currentUrl ?? "?"} error=${errorMessage}`,
  );
  return lines;
}
