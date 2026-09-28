import type { JourneyMemoryFlags } from "../../config/journeyMemoryConfig.js";

/**
 * Production diagnostics visibility fix (see CLAUDE.md, production incident
 * run_b3743f06-1667-443e-b9fa-e804aa5caecf): a safe, server-side-only startup log recording
 * only the resolved boolean flag state -- never a secret, a Redis URL, or anything
 * request-derived. Called once per process/flag-read, never per run, so it is cheap and
 * never gated behind a per-run condition. Lets an operator confirm from deployment logs
 * alone which build/config is actually running, independent of any one run's own response.
 */
export function logJourneyMemoryStartup(flags: JourneyMemoryFlags): void {
  // eslint-disable-next-line no-console -- deliberate: no shared logger exists in this repo
  // yet (see journeyMemoryConfig.ts's own convention), and this is an intentional,
  // safe-by-construction operational log line.
  console.log(
    `[journeyMemory] flags resolved: enabled=${flags.enabled} readEnabled=${flags.readEnabled} writeEnabled=${flags.writeEnabled}`,
  );
}

export interface JourneyMemoryRunCompletionLog {
  runId: string;
  taskId: string;
  storageAvailable: boolean;
  lookupAttempted: boolean;
  candidatesConsidered: number;
  candidatesAccepted: number;
  candidatesRejected: number;
  forwardSegmentsBuilt: number;
  recoverySegmentsBuilt: number;
  segmentsWriteAttempted: number;
  segmentsWritten: number;
  writeFailureReason?: string;
  diagnosticsAttached: boolean;
}

/**
 * Production diagnostics visibility fix: a run-completion log emitted server-side,
 * independent of what the HTTP response actually carries -- so "this deployment ran
 * different code than expected" (nothing logged, or flags resolved unexpectedly) is
 * distinguishable from "the response's diagnostics.journeyMemory field was dropped somewhere
 * downstream" (this log line exists and looks correct, but the caller's response doesn't
 * carry it) without needing to reproduce the run. Never includes REDIS_URL, credentials,
 * raw Redis records, cookies, tokens, PII, or any page content -- only run/task ids and
 * bounded counts, mirroring exactly what diagnostics.journeyMemory itself reports on the
 * wire (see src/core/engine.ts's own construction of that object).
 */
export function logJourneyMemoryRunCompletion(entry: JourneyMemoryRunCompletionLog): void {
  // eslint-disable-next-line no-console -- deliberate, see logJourneyMemoryStartup above.
  console.log(
    `[journeyMemory] run completed: runId=${entry.runId} taskId=${entry.taskId} ` +
      `storageAvailable=${entry.storageAvailable} lookupAttempted=${entry.lookupAttempted} ` +
      `candidatesConsidered=${entry.candidatesConsidered} candidatesAccepted=${entry.candidatesAccepted} ` +
      `candidatesRejected=${entry.candidatesRejected} forwardSegmentsBuilt=${entry.forwardSegmentsBuilt} ` +
      `recoverySegmentsBuilt=${entry.recoverySegmentsBuilt} segmentsWriteAttempted=${entry.segmentsWriteAttempted} ` +
      `segmentsWritten=${entry.segmentsWritten}` +
      (entry.writeFailureReason ? ` writeFailureReason=${entry.writeFailureReason}` : "") +
      ` diagnosticsAttached=${entry.diagnosticsAttached}`,
  );
}
