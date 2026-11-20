import type { CaptureModuleName } from "../types/captureModule.js";
import type { Captures, DataLayerCapture, Ga4NetworkEventCapture, TerminalAnalyticsDrainDiagnostics } from "../types/task-response.js";
import type { TerminalAnalyticsDrainConfig } from "../config/terminalAnalyticsDrainConfig.js";

/** The drain only matters when this run captures GA4 collect requests or live dataLayer pushes. */
export function terminalAnalyticsDrainApplies(captureModules: readonly CaptureModuleName[]): boolean {
  return captureModules.includes("ga4_network_events") || captureModules.includes("data_layer_evidence");
}

export function resolveTerminalAnalyticsDrainHardCapMs(config: TerminalAnalyticsDrainConfig, verifiedFormSubmission: boolean): number {
  return verifiedFormSubmission ? config.formHardCapMs : config.defaultHardCapMs;
}

interface CaptureSignature {
  length: number;
  last: unknown;
}

function signatureOf(entries: readonly unknown[] | undefined): CaptureSignature {
  const list = entries ?? [];
  return { length: list.length, last: list[list.length - 1] };
}

// Captures are bounded sliding windows (core/boundedArray.ts), so at the cap the length stops
// changing; a changed last element still means one new entry. Below the cap the length delta is exact.
function newEntriesSince(before: CaptureSignature, after: CaptureSignature): number {
  if (after.length > before.length) return after.length - before.length;
  return after.last !== before.last ? 1 : 0;
}

export interface TerminalAnalyticsDrainResult {
  diagnostics: TerminalAnalyticsDrainDiagnostics;
  /** The captures entries the live listeners added during the drain, by reference -- for analyticsReportingRows attribution only. */
  ga4Events: Ga4NetworkEventCapture[];
  dataLayerPushes: DataLayerCapture[];
}

/**
 * Passive wait after a terminal SUCCESS decision, before the run's capture listeners are detached
 * and the response is built. Navigation is over: this never calls the reasoning layer, clicks,
 * scrolls, navigates or runs a step -- it only watches the live GA4/dataLayer listeners (already
 * attached for the run, on the start page and every adopted surface) keep appending to `captures`.
 * Whatever they append during the drain is therefore ordinary capture evidence and reaches
 * analyticsReportingRows through the normal path. Exits as soon as no new entry has arrived for
 * `quietWindowMs`, or when `hardCapMs` is reached, whichever is first. Timers only: a page that
 * closed itself meanwhile cannot break it.
 */
export async function runTerminalAnalyticsDrain(params: {
  captures: Captures;
  quietWindowMs: number;
  hardCapMs: number;
  pollIntervalMs: number;
  verifiedFormSubmission: boolean;
}): Promise<TerminalAnalyticsDrainResult> {
  const { captures, quietWindowMs, hardCapMs, pollIntervalMs, verifiedFormSubmission } = params;
  const ga4AtStart = new Set(captures.ga4_network_events ?? []);
  const dataLayerAtStart = new Set(captures.data_layer_evidence ?? []);
  const started = Date.now();
  let lastActivity = started;
  let ga4Before = signatureOf(captures.ga4_network_events);
  let dataLayerBefore = signatureOf(captures.data_layer_evidence);
  let ga4HitsObserved = 0;
  let dataLayerPushesObserved = 0;
  let exitReason: TerminalAnalyticsDrainDiagnostics["exitReason"];

  for (;;) {
    const now = Date.now();
    const ga4Now = signatureOf(captures.ga4_network_events);
    const dataLayerNow = signatureOf(captures.data_layer_evidence);
    const ga4New = newEntriesSince(ga4Before, ga4Now);
    const dataLayerNew = newEntriesSince(dataLayerBefore, dataLayerNow);
    if (ga4New > 0 || dataLayerNew > 0) {
      ga4HitsObserved += ga4New;
      dataLayerPushesObserved += dataLayerNew;
      lastActivity = now;
    }
    ga4Before = ga4Now;
    dataLayerBefore = dataLayerNow;

    if (now - lastActivity >= quietWindowMs) {
      exitReason = "quiet_window";
      break;
    }
    if (now - started >= hardCapMs) {
      exitReason = "hard_cap";
      break;
    }
    const untilQuiet = lastActivity + quietWindowMs - now;
    const untilCap = started + hardCapMs - now;
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, Math.min(pollIntervalMs, untilQuiet, untilCap))));
  }

  const ended = Date.now();
  return {
    diagnostics: {
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      quietWindowMs,
      hardCapMs,
      exitReason,
      verifiedFormSubmission,
      ga4HitsObserved,
      dataLayerPushesObserved,
    },
    ga4Events: (captures.ga4_network_events ?? []).filter((entry) => !ga4AtStart.has(entry)),
    dataLayerPushes: (captures.data_layer_evidence ?? []).filter((entry) => !dataLayerAtStart.has(entry)),
  };
}
