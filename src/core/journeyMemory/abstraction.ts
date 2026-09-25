import type { JourneyMemorySegment, JourneyMemoryTier, SanitizedPageIdentity } from "../../types/journeyMemory.js";
import { tokenize } from "../../discovery/relevance.js";
import { isStructuralOnlyTier } from "./tiering.js";

/**
 * Issue 2 (Tier 3/4 cross-domain behaviour, binding acceptance-issue contract): the domain
 * hard boundary gates only literal/executable identifiers -- raw URLs, CTA text strings,
 * element ids/selectors, product/model names, locale-specific control text -- which must
 * never cross from a different registrable domain into another domain's guidance, at ANY
 * tier other than Tier1. It must NOT block sanitized, abstract structural guidance from
 * crossing at Tier3/4: generic structural concepts (a page matching semantic pattern X led
 * to a page matching semantic pattern Y, this action-role/meaning category preceded
 * milestone-intent Z, this structural branch shape was unproductive) remain usable.
 *
 * This module is the single choke point that enforces that boundary at the *content-field*
 * level (which fields are allowed into an out-of-domain record) rather than as a blanket
 * retrieval-time reject of the whole tier (tiering.ts/scoring.ts already retrieve and score
 * Tier3/4 candidates -- see scoreJourneyMemoryCandidate) -- literal fields are stripped/
 * replaced with a fixed, generic vocabulary-derived structural label before a candidate ever
 * reaches promptSummary.ts/the reasoning prompt.
 */

/**
 * A closed, hand-picked vocabulary of generic journey-stage/action-intent words -- every
 * one of these is a structural concept that recurs across unrelated sites/brands (checkout,
 * configure, compare, ...), never a brand, model, or product name. Because the output of
 * abstraction is always the intersection of this fixed set with the segment's own tokens,
 * a brand/product word can never appear in abstracted output even if it happened to also be
 * a common English word -- the allowlist is the safety property, not a best-effort filter.
 */
const GENERIC_STRUCTURAL_VOCABULARY: ReadonlySet<string> = new Set([
  "start",
  "home",
  "begin",
  "continue",
  "next",
  "back",
  "menu",
  "list",
  "listing",
  "search",
  "filter",
  "sort",
  "select",
  "choose",
  "option",
  "options",
  "configure",
  "configurator",
  "customize",
  "build",
  "compare",
  "comparison",
  "detail",
  "details",
  "summary",
  "overview",
  "review",
  "confirm",
  "confirmation",
  "submit",
  "form",
  "contact",
  "signup",
  "login",
  "register",
  "account",
  "cart",
  "checkout",
  "offer",
  "offers",
  "price",
  "pricing",
  "quote",
  "book",
  "booking",
  "schedule",
  "appointment",
  "consent",
  "accept",
  "decline",
  "cookie",
  "cookies",
  "close",
  "open",
  "expand",
  "collapse",
  "learn",
  "more",
  "view",
  "download",
  "share",
  "print",
  "help",
  "faq",
  "support",
  "error",
  "success",
  "complete",
  "completed",
  "finish",
  "finished",
  "step",
  "stage",
  "page",
  "tab",
  "panel",
  "modal",
  "dialog",
  "banner",
  "link",
  "button",
]);

/** Intersects free-form tokens with the fixed generic vocabulary -- never a passthrough. */
function abstractTokens(text: string): string[] {
  const tokens = new Set(tokenize(text));
  const kept: string[] = [];
  for (const t of tokens) {
    if (GENERIC_STRUCTURAL_VOCABULARY.has(t)) kept.push(t);
  }
  return kept.sort();
}

/** Bounded, non-reversible structural descriptor of a normalized path's *shape* (segment count + presence of a numeric-id placeholder), never the literal path segments themselves. */
function abstractPathShape(normalizedPath: string): string {
  const segments = normalizedPath.split("/").filter((s) => s.length > 0);
  const hasId = segments.includes("{id}");
  return `depth:${segments.length}${hasId ? ":has-id" : ""}`;
}

/** True for every tier that must never carry a literal identifier -- only Tier1 (the exact same site the current run is on) may. Delegates to tiering.ts's own isStructuralOnlyTier so there is exactly one definition of the tier boundary. */
export function isCrossDomainTier(tier: JourneyMemoryTier): boolean {
  return isStructuralOnlyTier(tier);
}

/**
 * Strips a SanitizedPageIdentity down to structural-only content: registrableDomain is kept
 * (it is provenance metadata used for tier classification/diagnostics, never surfaced to the
 * reasoning prompt as guidance text -- see promptSummary.ts, which never reads it),
 * normalizedPath is replaced by its abstract shape, semanticSignature is reduced to the
 * generic-vocabulary intersection, and extractedFields (locale-specific control text risk)
 * is dropped entirely.
 */
export function abstractPageIdentity(page: SanitizedPageIdentity): SanitizedPageIdentity {
  return {
    registrableDomain: page.registrableDomain,
    normalizedPath: abstractPathShape(page.normalizedPath),
    semanticSignature: abstractTokens(page.semanticSignature).join(" "),
  };
}

/** "role::accessibleName" (or "actionType::target") -> "role" alone, or "actionType::genericTerms" when the label carries generic-vocabulary words worth keeping as an action-meaning category. */
export function abstractActionLabel(semanticLabel: string): string {
  const sepIndex = semanticLabel.indexOf("::");
  if (sepIndex < 0) return abstractTokens(semanticLabel).join(" ") || semanticLabel.split(/\s+/)[0] || "action";
  const role = semanticLabel.slice(0, sepIndex);
  const rest = semanticLabel.slice(sepIndex + 2);
  const generic = abstractTokens(rest);
  return generic.length > 0 ? `${role}::${generic.join(" ")}` : role;
}

/** Milestone/failure intent text can be arbitrary task-author free text (e.g. an objective) -- abstract it the same way, falling back to a fixed generic bucket rather than ever passing raw text through. */
export function abstractIntentText(text: string): string {
  const generic = abstractTokens(text);
  return generic.length > 0 ? generic.join(" ") : "milestone_intent";
}

/**
 * Produces the cross-domain-safe projection of a segment used for scoring/guidance once its
 * tier has been classified as anything other than Tier1. Never mutates the input (the
 * original, full-fidelity segment remains what's stored/reused for a future same-domain
 * run) and never used at write time -- only at read time, per-candidate, once
 * classifyTier(...) has already run (see scoring.ts).
 */
export function abstractSegmentForCrossDomain(segment: JourneyMemorySegment): JourneyMemorySegment {
  if (segment.kind === "forward") {
    return {
      ...segment,
      sourcePage: abstractPageIdentity(segment.sourcePage),
      destinationPage: abstractPageIdentity(segment.destinationPage),
      action: { actionType: segment.action.actionType, semanticLabel: abstractActionLabel(segment.action.semanticLabel) },
      verifiedMilestoneIntent: abstractIntentText(segment.verifiedMilestoneIntent),
    };
  }
  return {
    ...segment,
    sourcePage: abstractPageIdentity(segment.sourcePage),
    failedCandidate: {
      actionType: segment.failedCandidate.actionType,
      semanticLabel: abstractActionLabel(segment.failedCandidate.semanticLabel),
    },
    failureType: abstractIntentText(segment.failureType),
    ...(segment.lastVerifiedMilestoneIntent !== undefined
      ? { lastVerifiedMilestoneIntent: abstractIntentText(segment.lastVerifiedMilestoneIntent) }
      : {}),
  };
}
