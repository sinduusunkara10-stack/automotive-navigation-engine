/**
 * Popup fingerprinting and retry protection (surface-adoption corrective work, see
 * CLAUDE.md's non-negotiable design rule -- this module is fully generic, no brand/site/
 * language-specific logic anywhere in it). Identifies "is this the same candidate surface as
 * one I already scored" across repeated encounters within one run -- e.g. the engine
 * backtracks, then the reasoning layer selects the same CTA again, reopening what is
 * structurally the same popup. Deliberately coarse and cheap (computed before any relevance
 * scoring runs, from data already on hand): normalized hostname, a truncated path shape with
 * no query string, and the triggering click's own stable Route-Memory-style identity (see
 * core/routeMemory.ts's buildClickIdentityKey) -- the same click reopening the same
 * host+path is already a strong, generic "this is the same popup" signal, without ever
 * reading personal data, session tokens, or unrestricted query parameters.
 */

const MAX_PATH_SEGMENTS = 3;
const MAX_SEGMENT_LENGTH = 40;

/** Strips query string/fragment and caps depth/length -- never includes a query parameter (which may carry session ids, personal data, or other sensitive values). */
function sanitizedPathShape(pathname: string): string {
  const segments = pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .slice(0, MAX_PATH_SEGMENTS)
    .map((segment) => segment.slice(0, MAX_SEGMENT_LENGTH));
  return segments.join("/");
}

export function computeCandidateSurfaceFingerprint(params: {
  candidateUrl: string | undefined;
  /** The triggering click's own stable identity (core/routeMemory.ts's buildClickIdentityKey output), when known. */
  triggeringActionFingerprint: string | undefined;
}): string | undefined {
  const { candidateUrl, triggeringActionFingerprint } = params;
  if (!candidateUrl) {
    return undefined;
  }
  let hostname: string;
  let pathShape: string;
  try {
    const url = new URL(candidateUrl);
    hostname = url.hostname.toLowerCase();
    pathShape = sanitizedPathShape(url.pathname);
  } catch {
    return undefined;
  }
  return JSON.stringify({
    hostname,
    pathShape,
    surfaceType: "popup",
    ...(triggeringActionFingerprint ? { triggeringActionFingerprint } : {}),
  });
}
