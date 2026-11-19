// NAV_FAILURE_DIAGNOSTICS_LOG controls Render logging only: when on, a failed run also
// writes its time-ordered page/action timeline to the logs. What is collected and returned
// in the task-status endpoint's errorDetails is identical either way.
export function readNavFailureDiagnosticsLog(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.NAV_FAILURE_DIAGNOSTICS_LOG?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
