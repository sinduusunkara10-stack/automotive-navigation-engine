/** A successful run waits until this long passes with no new GA4 collect request or live dataLayer push. */
export const TERMINAL_ANALYTICS_DRAIN_QUIET_WINDOW_MS = 1_500;
/** Hard cap after a verified form submission, whose conversion hits are often sent as a late batch. */
export const TERMINAL_ANALYTICS_DRAIN_FORM_HARD_CAP_MS = 8_000;
/** Hard cap after any other successful terminal action. */
export const TERMINAL_ANALYTICS_DRAIN_DEFAULT_HARD_CAP_MS = 3_000;
export const TERMINAL_ANALYTICS_DRAIN_POLL_INTERVAL_MS = 100;

export interface TerminalAnalyticsDrainConfig {
  quietWindowMs: number;
  /** Hard cap when the run ended after a verified form submission. */
  formHardCapMs: number;
  /** Hard cap for every other successful terminal action. */
  defaultHardCapMs: number;
  pollIntervalMs: number;
}

export const DEFAULT_TERMINAL_ANALYTICS_DRAIN_CONFIG: TerminalAnalyticsDrainConfig = {
  quietWindowMs: TERMINAL_ANALYTICS_DRAIN_QUIET_WINDOW_MS,
  formHardCapMs: TERMINAL_ANALYTICS_DRAIN_FORM_HARD_CAP_MS,
  defaultHardCapMs: TERMINAL_ANALYTICS_DRAIN_DEFAULT_HARD_CAP_MS,
  pollIntervalMs: TERMINAL_ANALYTICS_DRAIN_POLL_INTERVAL_MS,
};
