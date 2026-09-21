import type { SurfaceAdoptionDomainPolicy } from "../types/task-request.js";
import { checkNavigationAllowed } from "../safety/domainGuard.js";

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): the non-task-relaxable-upward default for Safety.maxAdoptedSurfacesPerRun when
 * a task omits it -- small and fixed, matching MAX_ALTERNATIVE_CANDIDATES_PER_ANCHOR's own
 * "generous enough for the common case, never unbounded" shape.
 */
export const DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN = 5;

/**
 * "relevance_rejected" (surface-relevance corrective work, PR 3) is produced by
 * capture-modules/popupCapture.ts's own relevance gate (src/core/surfaceRelevance.ts),
 * before this function is ever called -- decideSurfaceAdoption itself never assesses
 * relevance and never returns this reason. Internal-only for now, same treatment as
 * "adoption_disabled" today: not yet exposed on the wire (ActionResult.adoptionRejectedReason,
 * SurfaceAdoptionAttemptDiagnostic.reason), which is a genuine schema/contract change
 * deliberately deferred to PR 6 per CLAUDE.md's contract-versioning rule.
 */
export type AdoptionRejectionReason =
  | "adoption_disabled"
  | "domain_rejected"
  | "budget_exhausted"
  | "relevance_rejected";

export interface AdoptionDecision {
  adopt: boolean;
  reason?: AdoptionRejectionReason;
  /**
   * Present only when adopt is true under surfaceAdoptionDomainPolicy
   * "extend_trust_from_landing" and the popup's own hostname was not already covered by
   * `allowedDomains` -- the caller (core/loop.ts) uses this to record a per-surface
   * domain-trust extension (see RunState.extendAllowedDomainForCurrentSurface) so the
   * adopted surface's own subsequent navigation is held to it too, not just this one
   * landing URL.
   */
  extendedAllowedDomain?: string;
}

/**
 * Pure, side-effect-free adoption-decision logic for a popup/new-tab a click just opened --
 * see actions/click.ts and capture-modules/popupCapture.ts for where this is actually called
 * from, and core/loop.ts for how the resulting decision is turned into a real
 * RunState.pushSurface. Never itself touches a Page, a capture, or RunState -- every input
 * is a plain value, so this can be (and is, see tests/unit/surfaceAdoption.test.ts) exercised
 * in full without a browser.
 *
 * Order of checks is deliberate: a task that never opted in is rejected before anything else
 * is even inspected (adoption_disabled), then the fixed per-run budget (budget_exhausted,
 * checked before the -- potentially unparseable -- popup URL, since an exhausted budget is
 * true regardless of what the popup even is), then the domain policy itself (domain_rejected).
 */
export function decideSurfaceAdoption(params: {
  allowSurfaceAdoption: boolean | undefined;
  domainPolicy: SurfaceAdoptionDomainPolicy | undefined;
  popupUrl: string | undefined;
  allowedDomains: string[];
  adoptedSurfaceCount: number;
  maxAdoptedSurfacesPerRun: number | undefined;
}): AdoptionDecision {
  const { allowSurfaceAdoption, popupUrl, allowedDomains, adoptedSurfaceCount } = params;

  if (!allowSurfaceAdoption) {
    return { adopt: false, reason: "adoption_disabled" };
  }

  const budget = params.maxAdoptedSurfacesPerRun ?? DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN;
  if (adoptedSurfaceCount >= budget) {
    return { adopt: false, reason: "budget_exhausted" };
  }

  const domainPolicy = params.domainPolicy ?? "require_allowed_domain";
  let popupHostname: string | undefined;
  try {
    popupHostname = popupUrl ? new URL(popupUrl).hostname : undefined;
  } catch {
    popupHostname = undefined;
  }

  if (!popupHostname) {
    // No verifiable landing URL at all (e.g. the popup never reached a real document before
    // this decision had to be made) -- never adopted under either policy, since there is
    // nothing to check the domain policy against.
    return { adopt: false, reason: "domain_rejected" };
  }

  const alreadyAllowed = checkNavigationAllowed(popupUrl as string, allowedDomains);
  if (alreadyAllowed) {
    return { adopt: true };
  }

  if (domainPolicy === "extend_trust_from_landing") {
    return { adopt: true, extendedAllowedDomain: popupHostname };
  }

  return { adopt: false, reason: "domain_rejected" };
}
