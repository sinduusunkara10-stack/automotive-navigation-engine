const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type HostRejectionReason =
  | "unsupported_protocol"
  | "unparseable_url"
  | "localhost"
  | "loopback_address"
  | "link_local_address";

export interface HostSafetyResult {
  safe: boolean;
  reason?: HostRejectionReason;
}

export interface AssessUrlSafetyOptions {
  /**
   * Grandfathers a URL's host past the localhost/loopback/link-local checks below (the
   * protocol check still always applies). Used exactly once, for the caller's own explicit
   * startUrl: a caller may deliberately point the engine at a local/dev target (this repo's
   * own fixtures run on 127.0.0.1), and that is the caller's explicit choice to make, not a
   * host discovery surfaced on its own. Every host *discovered* during preflight (a redirect
   * landing on a different host, a canonical URL, a page anchor) is always assessed with this
   * left false -- see domainDiscovery.ts's conservative candidate-validation policy.
   */
  allowLoopbackAndLinkLocal?: boolean;
}

function isLoopbackIPv4(hostname: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isLinkLocalIPv4(hostname: string): boolean {
  return /^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function stripIPv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isLoopbackIPv6(hostname: string): boolean {
  return stripIPv6Brackets(hostname).toLowerCase() === "::1";
}

function isLinkLocalIPv6(hostname: string): boolean {
  return stripIPv6Brackets(hostname).toLowerCase().startsWith("fe80:");
}

/**
 * Deterministic URL/host safety assessment used throughout preflight domain discovery.
 * Rejects (per CLAUDE.md's safety posture and the discovery requirements):
 *   - any protocol other than http/https (mailto:, tel:, javascript:, data:, ftp:, ...)
 *   - "localhost" (and any ".localhost" host)
 *   - loopback addresses (127.0.0.0/8, ::1)
 *   - link-local addresses (169.254.0.0/16, fe80::/10)
 * The localhost/loopback/link-local checks are skipped only when
 * options.allowLoopbackAndLinkLocal is explicitly set -- see that option's doc comment.
 */
export function assessUrlSafety(rawUrl: string, options: AssessUrlSafetyOptions = {}): HostSafetyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { safe: false, reason: "unparseable_url" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { safe: false, reason: "unsupported_protocol" };
  }

  if (options.allowLoopbackAndLinkLocal) {
    return { safe: true };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return { safe: false, reason: "localhost" };
  }
  if (isLoopbackIPv4(hostname) || isLoopbackIPv6(hostname)) {
    return { safe: false, reason: "loopback_address" };
  }
  if (isLinkLocalIPv4(hostname) || isLinkLocalIPv6(hostname)) {
    return { safe: false, reason: "link_local_address" };
  }

  return { safe: true };
}

export function isSafeUrl(rawUrl: string, options: AssessUrlSafetyOptions = {}): boolean {
  return assessUrlSafety(rawUrl, options).safe;
}
