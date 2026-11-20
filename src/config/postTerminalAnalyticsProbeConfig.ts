export const POST_TERMINAL_ANALYTICS_PROBE_DURATION_MS = 8_000;

export interface PostTerminalAnalyticsProbeConfig {
  enabled: boolean;
  durationMs: number;
}

// POST_TERMINAL_ANALYTICS_PROBE_ENABLED is diagnostics-only and off by default: when on, a run that
// ends in success keeps a passive GA4 collect listener open for a fixed time after teardown of the
// normal capture listeners, and reports what it saw only in diagnostics.postTerminalAnalyticsProbe.
export function readPostTerminalAnalyticsProbeConfig(env: NodeJS.ProcessEnv = process.env): PostTerminalAnalyticsProbeConfig {
  const raw = env.POST_TERMINAL_ANALYTICS_PROBE_ENABLED?.trim().toLowerCase();
  return { enabled: raw === "1" || raw === "true", durationMs: POST_TERMINAL_ANALYTICS_PROBE_DURATION_MS };
}
