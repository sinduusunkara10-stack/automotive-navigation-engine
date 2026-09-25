import { isSameSanitizedDomain } from "./sanitizer.js";
import type { JourneyMemoryTier } from "../../types/journeyMemory.js";

/**
 * Tiered brand/market/domain hierarchy (binding contract §4): domain partitioning is an
 * exact registrable-domain match (hard boundary, via registrableDomain.ts); market/locale
 * is a separate field, compared only for tier classification -- never used to fuzzy-match
 * across domains. Tier1 (strongest) down to Tier4 (last-resort, abstract-only).
 */
export function classifyTier(params: {
  candidateDomain: string;
  currentDomain: string;
  candidateMarket?: string;
  currentMarket?: string;
}): JourneyMemoryTier {
  // isSameSanitizedDomain (registrableDomain.ts) deliberately never matches two bare IPs or
  // "localhost"-family hosts even when textually identical (see its own doc comment) -- the
  // right call for discovery's real-site trust decisions, but wrong here: a synthetic/local
  // fixture (127.0.0.1) or an internal IP-addressed environment is still unambiguously "the
  // same site" when the hostnames are the exact same string. Fall back to that exact-string
  // equality only when the registrable-domain check itself is inconclusive (both sides
  // resolve to no PSL-registrable domain), never as a substitute for it otherwise.
  const sameDomain =
    isSameSanitizedDomain(params.candidateDomain, params.currentDomain) ||
    params.candidateDomain.toLowerCase() === params.currentDomain.toLowerCase();
  const sameMarket =
    params.candidateMarket !== undefined && params.currentMarket !== undefined
      ? params.candidateMarket.toLowerCase() === params.currentMarket.toLowerCase()
      : params.candidateMarket === params.currentMarket;

  if (sameDomain && sameMarket) return "tier1";
  if (sameDomain && !sameMarket) return "tier2";
  if (!sameDomain && sameMarket) return "tier3";
  return "tier4";
}

/** Confidence/influence scales down by tier -- never validated against real-site data, deliberately conservative and env-labelled-as-unvalidated like surfaceRelevance.ts's own thresholds. */
export const TIER_CONFIDENCE_MULTIPLIER: Record<JourneyMemoryTier, number> = {
  tier1: 1,
  tier2: 0.6,
  tier3: 0.35,
  tier4: 0.15,
};

/**
 * True only for the fields a Tier2+ record is ever allowed to carry into planning:
 * structural/semantic guidance, never a raw URL, CTA text, element id, product name, query
 * string, or locale-specific control from a source outside the current domain (binding
 * contract §4). Tier1 alone may carry the full SanitizedPageIdentity/action label verbatim.
 */
export function isStructuralOnlyTier(tier: JourneyMemoryTier): boolean {
  return tier !== "tier1";
}

/** Retrieval order: query Tier1 first, only widen when yield is insufficient and budget remains. */
export const TIER_EXPANSION_ORDER: readonly JourneyMemoryTier[] = ["tier1", "tier2", "tier3", "tier4"];
