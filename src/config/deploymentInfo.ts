// Reads deployment identification info from the environment -- purely informational,
// never used to change engine behaviour. Exposed at GET /v1/health (and in
// TaskResponse.diagnostics.engineVersion's neighbourhood via src/core/engine.ts) so an
// operator investigating a live run can confirm which commit actually served it, without
// needing separate shell/log access to the deployment platform -- the health endpoint's
// bare "version": "1.0.0" API_VERSION alone cannot answer that question.

/**
 * Render (https://render.com) automatically sets RENDER_GIT_COMMIT to the full commit SHA
 * being deployed, for any service backed by a connected git repository. GIT_COMMIT_SHA is
 * a generic fallback for any other deployment platform/CI (or a manual override) that
 * doesn't set Render's own variable. Reads only these two names -- never any other
 * environment value -- and returns undefined (never throws) when neither is set, since
 * this is diagnostic-only and must never affect whether the service starts.
 */
export function readDeployedCommitSha(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.RENDER_GIT_COMMIT || env.GIT_COMMIT_SHA;
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
