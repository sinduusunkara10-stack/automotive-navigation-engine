import { parse as parseHost } from "tldts";

export interface HostRegistrability {
  hostname: string;
  registrableDomain: string | null;
  isIp: boolean;
}

/**
 * Registrable-domain (eTLD+1) lookup, backed by tldts's maintained Public Suffix List data
 * -- never derived by splitting/regexing the last two hostname labels, which breaks on
 * multi-label public suffixes (e.g. "example.co.uk", "example.github.io"). Returns
 * registrableDomain: null for hosts with no PSL-registrable domain at all (bare IPs,
 * "localhost", or a hostname that is itself only a public suffix) -- those never
 * participate in same-registrable-domain subdomain trust, only exact-hostname matching.
 */
export function analyzeHost(hostname: string): HostRegistrability {
  const parsed = parseHost(hostname);
  return {
    hostname,
    registrableDomain: parsed.domain ?? null,
    isIp: parsed.isIp === true,
  };
}

/**
 * True only when both hosts resolve to the same non-null PSL registrable domain. Two IPs,
 * two bare public suffixes, or two "localhost"-family hosts are never considered a match
 * here, even if the hostnames are textually identical -- exact-hostname trust is handled
 * separately by the discovery orchestrator, deliberately not folded into this check.
 */
export function isSameRegistrableDomain(hostA: string, hostB: string): boolean {
  const domainA = analyzeHost(hostA).registrableDomain;
  const domainB = analyzeHost(hostB).registrableDomain;
  return domainA !== null && domainB !== null && domainA === domainB;
}
