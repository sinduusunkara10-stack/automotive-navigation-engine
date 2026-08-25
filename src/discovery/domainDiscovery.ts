import type { Page } from "playwright";
import { analyzeHost, isSameRegistrableDomain } from "./registrableDomain.js";
import { assessUrlSafety, type HostRejectionReason } from "./hostSafety.js";
import { rankByObjectiveRelevance } from "./relevance.js";
import { gatherPageSignals, type CandidateAnchor, type PageSignals } from "./pageSignals.js";
import type { RobustGotoOutcome } from "../core/robustNavigation.js";
import { navigateInitialPage } from "../core/initialNavigation.js";

export type TrustReason =
  | "caller_supplied"
  | "exact_start_host"
  | "redirect_landing_host"
  | "same_registrable_domain_subdomain";

export type CandidateEvidenceType =
  | "redirect_landing_host"
  | "canonical_url"
  | "visible_anchor"
  | "nav_anchor"
  | "objective_candidate_anchor";

export interface TrustedDomainEntry {
  hostname: string;
  reason: TrustReason;
  evidenceType?: CandidateEvidenceType;
  sourceUrl?: string;
}

export interface ExternalCandidateEntry {
  hostname: string;
  registrableDomain: string | null;
  evidenceType: CandidateEvidenceType;
  sourceUrl: string;
  reason: string;
}

export interface RejectedCandidateEntry {
  url: string;
  evidenceType: CandidateEvidenceType | "redirect_hop";
  reason: HostRejectionReason;
}

export interface DomainDiscoveryResult {
  startHostname: string;
  startRegistrableDomain: string | null;
  finalUrl: string;
  redirectChain: string[];
  canonicalUrl?: string;
  trustedDomains: TrustedDomainEntry[];
  externalCandidates: ExternalCandidateEntry[];
  rejectedCandidates: RejectedCandidateEntry[];
  /** Newly auto-discovered hostnames only -- excludes caller-supplied allowedDomains entries. */
  proposedAllowedDomains: string[];
  /**
   * Set when the navigation itself (the redirect landing host, or an intermediate hop) is
   * unsafe -- e.g. a real-world start host redirecting to a loopback/link-local address.
   * When present, the engine must treat this run as blocked rather than proceed.
   */
  blockedReason?: string;
}

const DEFAULT_MAX_OBJECTIVE_CANDIDATES = 10;

export interface DomainDiscoveryInput {
  startUrl: string;
  finalUrl: string;
  redirectChain: string[];
  canonicalUrl?: string;
  anchors: CandidateAnchor[];
  objective: string;
  journeyType?: string;
  callerAllowedDomains?: string[];
  maxObjectiveCandidates?: number;
}

/**
 * Pure decision logic: given the signals preflight gathered (redirect chain, canonical URL,
 * candidate anchors) plus the caller's objective/journeyType text, decides which hostnames
 * are trusted, which are surfaced as external candidates requiring explicit caller opt-in,
 * and which are rejected outright. No Playwright/browser dependency, so this is fully
 * unit-testable -- see runDomainDiscovery below for the browser-driving wrapper.
 *
 * Conservative validation policy (requirement: "a candidate external registrable domain must
 * not be trusted merely because it appears in a link"):
 *   - Automatically trusted: the exact start hostname (the caller's own explicit choice);
 *     the final redirect-landing hostname (a direct, server-controlled consequence of
 *     navigating to the caller-approved startUrl, not page content); and any hostname --
 *     found via redirect landing, canonical URL, or any anchor -- that shares a PSL
 *     registrable domain with the start host or the landing host (a same-organization
 *     subdomain, e.g. discovering "configurator.example.com" from "www.example.com").
 *   - Never auto-trusted: a hostname on a *different* registrable domain, however it was
 *     discovered (canonical tag, nav link, or a link whose text matches the objective). Page
 *     content -- including a page's own canonical tag -- is not proof the site owner intends
 *     the engine to navigate there; it is recorded as an externalCandidate with its evidence
 *     so a caller/operator can review and explicitly add it to allowedDomains.
 *   - Always rejected as a candidate, regardless of source: non-http/https protocols,
 *     localhost, loopback addresses, link-local addresses (see hostSafety.ts). The one
 *     exemption is the start hostname itself, which may legitimately be a local/dev target
 *     the caller chose on purpose.
 */
export function computeDomainDiscovery(input: DomainDiscoveryInput): DomainDiscoveryResult {
  const {
    startUrl,
    finalUrl,
    redirectChain,
    canonicalUrl,
    anchors,
    objective,
    journeyType,
    callerAllowedDomains = [],
    maxObjectiveCandidates = DEFAULT_MAX_OBJECTIVE_CANDIDATES,
  } = input;

  const startHostname = new URL(startUrl).hostname;
  const startRegistrableDomain = analyzeHost(startHostname).registrableDomain;
  const finalHostname = new URL(finalUrl).hostname;

  const trusted = new Map<string, TrustedDomainEntry>();
  const external = new Map<string, ExternalCandidateEntry>();
  const rejected: RejectedCandidateEntry[] = [];
  const homeRegistrableDomains = new Set<string>();
  if (startRegistrableDomain) homeRegistrableDomains.add(startRegistrableDomain);

  trusted.set(startHostname, { hostname: startHostname, reason: "exact_start_host", sourceUrl: startUrl });

  let blockedReason: string | undefined;

  if (finalHostname !== startHostname) {
    const safety = assessUrlSafety(finalUrl);
    if (!safety.safe) {
      blockedReason = `Initial navigation redirected to an unsafe host ("${finalHostname}", ${safety.reason}).`;
      rejected.push({ url: finalUrl, evidenceType: "redirect_landing_host", reason: safety.reason! });
    } else {
      trusted.set(finalHostname, { hostname: finalHostname, reason: "redirect_landing_host", sourceUrl: finalUrl });
      const finalRegistrableDomain = analyzeHost(finalHostname).registrableDomain;
      if (finalRegistrableDomain) homeRegistrableDomains.add(finalRegistrableDomain);
    }
  }

  // Intermediate redirect hops (excluding the start and final URLs, already handled above)
  // are still checked for basic protocol/localhost/loopback/link-local safety, so a chain
  // that briefly bounces through an unsafe host is caught even if the final landing host is
  // fine.
  for (const hopUrl of redirectChain.slice(1, -1)) {
    let hopHostname: string;
    try {
      hopHostname = new URL(hopUrl).hostname;
    } catch {
      continue;
    }
    if (hopHostname === startHostname || hopHostname === finalHostname) continue;
    const safety = assessUrlSafety(hopUrl);
    if (!safety.safe) {
      blockedReason ??= `Redirect chain passed through an unsafe host ("${hopHostname}", ${safety.reason}).`;
      rejected.push({ url: hopUrl, evidenceType: "redirect_hop", reason: safety.reason! });
    }
  }

  function isHomeRegistrableDomain(hostname: string): boolean {
    const registrableDomain = analyzeHost(hostname).registrableDomain;
    return registrableDomain !== null && homeRegistrableDomains.has(registrableDomain);
  }

  function considerCandidate(url: string, evidenceType: CandidateEvidenceType): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      rejected.push({ url, evidenceType, reason: "unparseable_url" });
      return;
    }
    // A candidate pointing back at an already-trusted host (e.g. a "home" link back to the
    // start host, or back to the redirect landing host) is not re-assessed against the full
    // loopback/link-local checks below -- that host was already established as trusted via
    // the exact-start-host or redirect-landing-host path above, which is where the
    // loopback/link-local exemption for the caller's own explicit target lives. Only
    // genuinely new hostnames go through the full, unexempted safety check.
    if (trusted.has(hostname)) return;

    const safety = assessUrlSafety(url);
    if (!safety.safe) {
      rejected.push({ url, evidenceType, reason: safety.reason! });
      return;
    }

    if (isHomeRegistrableDomain(hostname)) {
      trusted.set(hostname, {
        hostname,
        reason: "same_registrable_domain_subdomain",
        evidenceType,
        sourceUrl: url,
      });
      return;
    }

    if (!external.has(hostname)) {
      external.set(hostname, {
        hostname,
        registrableDomain: analyzeHost(hostname).registrableDomain,
        evidenceType,
        sourceUrl: url,
        reason:
          "Different registrable domain than the site being navigated; a link alone does not establish trust. " +
          "Add it explicitly to the task's allowedDomains if the run is meant to cross into it.",
      });
    }
  }

  if (canonicalUrl) {
    considerCandidate(canonicalUrl, "canonical_url");
  }

  const objectiveText = [objective, journeyType].filter(Boolean).join(" ");
  const objectiveMatches = new Set(
    rankByObjectiveRelevance(anchors, objectiveText, (anchor) => anchor.accessibleName, maxObjectiveCandidates).map(
      (anchor) => anchor.url,
    ),
  );

  for (const anchor of anchors) {
    const evidenceType: CandidateEvidenceType = objectiveMatches.has(anchor.url)
      ? "objective_candidate_anchor"
      : anchor.evidenceType;
    considerCandidate(anchor.url, evidenceType);
  }

  // At this point `trusted` holds only auto-discovered entries (exact start host, redirect
  // landing host, same-registrable-domain subdomains) -- caller-supplied entries are merged
  // in below, after this snapshot, so proposedAllowedDomains reflects what discovery itself
  // found rather than echoing back what the caller already declared.
  const proposedAllowedDomains = Array.from(trusted.keys()).sort();

  for (const hostname of callerAllowedDomains) {
    if (!trusted.has(hostname)) {
      trusted.set(hostname, { hostname, reason: "caller_supplied" });
    }
  }

  return {
    startHostname,
    startRegistrableDomain,
    finalUrl,
    redirectChain,
    canonicalUrl,
    trustedDomains: Array.from(trusted.values()),
    externalCandidates: Array.from(external.values()),
    rejectedCandidates: rejected,
    proposedAllowedDomains,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

export interface RunDomainDiscoveryParams {
  page: Page;
  startUrl: string;
  objective: string;
  journeyType?: string;
  callerAllowedDomains?: string[];
  timeoutMs: number;
  maxObjectiveCandidates?: number;
}

export interface RunDomainDiscoveryOutcome {
  navigation: RobustGotoOutcome;
  discovery?: DomainDiscoveryResult;
}

/**
 * The deterministic preflight phase: performs the engine's initial navigation (reusing the
 * same robust-goto mechanics as before), then reads canonical/anchor signals off the landed
 * page and runs computeDomainDiscovery. Runs before the Claude-driven navigate/observe/
 * decide/act loop ever starts -- nothing here calls the reasoning layer.
 */
export async function runDomainDiscovery(params: RunDomainDiscoveryParams): Promise<RunDomainDiscoveryOutcome> {
  const { page, startUrl, objective, journeyType, callerAllowedDomains, timeoutMs, maxObjectiveCandidates } = params;

  const startHostname = new URL(startUrl).hostname;
  const startRegistrableDomain = analyzeHost(startHostname).registrableDomain;
  // Only consulted by robustGoto's own timeout-recovery safety check (assessNavigationRecovery),
  // to decide whether a partially-loaded page is still safely observable -- not the final
  // trust decision, which computeDomainDiscovery derives independently below from the
  // navigation's actual landing URL.
  const recoveryAllowedDomains = Array.from(
    new Set([startHostname, ...(startRegistrableDomain ? [startRegistrableDomain] : []), ...(callerAllowedDomains ?? [])]),
  );

  const navigation = await navigateInitialPage({ page, startUrl, allowedDomains: recoveryAllowedDomains, timeoutMs });

  if (navigation.status === "failed") {
    return { navigation };
  }

  let signals: PageSignals = { anchors: [] };
  try {
    signals = await gatherPageSignals(page);
  } catch {
    // The page may have navigated away or closed between landing and this read; discovery
    // degrades gracefully to redirect-chain-only trust rather than failing the whole run.
  }

  const discovery = computeDomainDiscovery({
    startUrl,
    finalUrl: navigation.url,
    redirectChain: navigation.redirectChain && navigation.redirectChain.length > 0
      ? navigation.redirectChain
      : [startUrl, navigation.url],
    canonicalUrl: signals.canonicalUrl,
    anchors: signals.anchors,
    objective,
    journeyType,
    callerAllowedDomains,
    maxObjectiveCandidates,
  });

  return { navigation, discovery };
}
