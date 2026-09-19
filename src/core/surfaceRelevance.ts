import type { Page } from "playwright";
import { tokenize } from "../discovery/relevance.js";
import {
  ALL_SEMANTIC_SIGNALS,
  gatherSemanticPageSignals,
  scoreSemanticPageMatch,
  type SemanticPageSignals,
} from "./semanticPageMatch.js";
import { DEFAULT_SETTLE_CEILING_MS, MAX_SETTLE_CEILING_MS, waitForAdaptiveSettle } from "./robustNavigation.js";

/**
 * Surface-relevance assessment (surface-relevance corrective work, PR 3 -- see CLAUDE.md and
 * docs/architecture.md "Surface adoption"): before a just-opened popup/tab is allowed to
 * become the engine's active surface, it must be evaluated for relevance to the current
 * objective, not adopted purely because a click happened to open it. Reuses the same generic
 * token-overlap scoring src/discovery/relevance.ts and src/core/semanticPageMatch.ts already
 * apply elsewhere in this engine (preflight domain discovery, semantic_page_match success
 * criteria) -- nothing here is automotive/brand/vendor-specific.
 *
 * Thresholds below are initial, unvalidated calibration values (Option A from the approved
 * design doc), not production-validated -- every caller that records a decision made using
 * them must say so in diagnostics, never describe them as proven correct. See PR 6/7 for the
 * mandatory real-site validation this still needs.
 */
export const RELEVANCE_ADOPT_THRESHOLD = 0.35;
export const RELEVANCE_REJECT_THRESHOLD = 0.08;

// Conservative bar matching this codebase's existing semantic-verification/consent-ambiguity
// convention (see MIN_AMBIGUITY_RESOLUTION_CONFIDENCE, safety/consentClassifier.ts) -- a
// low-confidence model-assist resolution must never be trusted to adopt a surface.
const MIN_RELEVANCE_AMBIGUITY_CONFIDENCE = 0.7;

export type RelevanceTier = "adopt" | "reject" | "ambiguous";

async function hasUsableDocument(page: Page): Promise<boolean> {
  // Same shape as core/robustNavigation.ts's assessNavigationRecovery -- "not yet loaded" is
  // deliberately distinct from "irrelevant" (see the not-yet-usable-document branch below),
  // so a still-blank candidate is never mistaken for a low-relevance rejection.
  try {
    const title = (await page.title()).trim();
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? "");
    const interactiveCount = await page.evaluate(
      () => document.querySelectorAll('a, button, [role="button"], [role="link"]').length,
    );
    return title.length > 0 || bodyText.length > 0 || interactiveCount > 0;
  } catch {
    return false;
  }
}

export interface SurfaceRelevanceAmbiguityContext {
  objectiveText: string;
  title: string;
  headings: string[];
  interactiveText: string[];
  deterministicScore: number;
}

export interface SurfaceRelevanceAmbiguityResolution {
  relevant: boolean;
  rationale: string;
  confidence: number;
}

/**
 * Optional, generic model-assist hook for the genuinely ambiguous middle band only --
 * structurally the same bounded, independently-verified-before-trust shape as
 * safety/consentClassifier.ts's ConsentAmbiguityResolver. Never a standalone judge: see
 * resolveAmbiguousSurfaceRelevance below for the verification every resolution is put
 * through, and assessSurfaceRelevance for the deterministic gates on either side of it. This
 * directly satisfies "do not use Claude reasoning as the only guard without deterministic
 * safety checks."
 */
export interface SurfaceRelevanceAmbiguityResolver {
  resolve(context: SurfaceRelevanceAmbiguityContext): Promise<SurfaceRelevanceAmbiguityResolution>;
}

/**
 * Exported (unlike a purely internal helper) so its independent-verification behaviour can be
 * unit-tested directly, without a real Playwright Page -- mirrors
 * safety/consentClassifier.ts's own resolveAmbiguousConsentSurface being exported for the
 * same reason. See tests/unit/surfaceRelevance.test.ts.
 */
export async function resolveAmbiguousSurfaceRelevance(
  context: SurfaceRelevanceAmbiguityContext,
  resolver: SurfaceRelevanceAmbiguityResolver,
): Promise<{ relevant: boolean; rationale: string } | undefined> {
  let resolution: SurfaceRelevanceAmbiguityResolution;
  try {
    resolution = await resolver.resolve(context);
  } catch {
    return undefined;
  }

  if (resolution.confidence < MIN_RELEVANCE_AMBIGUITY_CONFIDENCE || resolution.rationale.trim().length === 0) {
    return undefined;
  }

  // Independent verification: the resolution must cite something actually present on the
  // observed surface -- never trusted blindly, mirroring resolveAmbiguousConsentSurface's own
  // elementId-membership check (consentClassifier.ts). Relevance has no single candidate id
  // to check membership against, so the closest generic analogue is used instead: at least
  // one non-trivial token from the rationale must also appear in the deterministic evidence
  // the resolver was actually given.
  const evidenceTokens = new Set(
    tokenize([context.title, ...context.headings, ...context.interactiveText].join(" ")),
  );
  const rationaleTokens = tokenize(resolution.rationale);
  const citesEvidence = rationaleTokens.some((token) => evidenceTokens.has(token));
  if (!citesEvidence) {
    return undefined;
  }

  return { relevant: resolution.relevant, rationale: resolution.rationale };
}

export interface SurfaceRelevanceAssessment {
  relevant: boolean;
  tier: RelevanceTier;
  score: number;
  adoptThreshold: number;
  rejectThreshold: number;
  /** True once a bounded resettle-and-rescore pass ran (not-yet-usable-document, or a genuinely ambiguous first score). */
  resettled: boolean;
  resolvedViaModelAssist: boolean;
  /** True only when the ambiguous band was reached, no confident resolution (deterministic or model-assisted) was ever produced, and the surface was fail-closed rather than adopted. */
  uncertain: boolean;
  signals: { title: string; headings: string[]; interactiveText: string[] };
}

/**
 * The orchestrating entry point capture-modules/popupCapture.ts calls, once per not-yet-
 * adopted candidate, before core/surfaceAdoption.ts's own domain/budget gate is ever
 * consulted. Three-tier design (approved design doc §4):
 *   1. High relevance AND a usable document: relevant.
 *   2. Low relevance AND a usable document: not relevant.
 *   3. Everything else (a genuinely ambiguous score, or no usable document yet): one bounded
 *      resettle-and-rescore pass, then -- if still ambiguous -- one bounded, independently-
 *      verified model-assist call when a resolver was supplied. Still unresolved after that:
 *      fail closed (not relevant), flagged `uncertain: true` for diagnostics -- consistent
 *      with every other safety default in this codebase (e.g. require_allowed_domain being
 *      the domain-policy default) rather than a silent guess either way.
 */
export async function assessSurfaceRelevance(params: {
  page: Page;
  objectiveText: string;
  settleCeilingMs?: number;
  ambiguityResolver?: SurfaceRelevanceAmbiguityResolver;
}): Promise<SurfaceRelevanceAssessment> {
  const { page, objectiveText, settleCeilingMs, ambiguityResolver } = params;

  const evaluateOnce = async (): Promise<{ signals: SemanticPageSignals; score: number; usable: boolean }> => {
    const signals = await gatherSemanticPageSignals(page);
    const usable = await hasUsableDocument(page);
    const score = scoreSemanticPageMatch(objectiveText, signals, ALL_SEMANTIC_SIGNALS).overall;
    return { signals, score, usable };
  };

  let attempt = await evaluateOnce();
  let resettled = false;

  const isAmbiguous = (a: { score: number; usable: boolean }) =>
    !a.usable || (a.score > RELEVANCE_REJECT_THRESHOLD && a.score < RELEVANCE_ADOPT_THRESHOLD);

  if (isAmbiguous(attempt)) {
    resettled = true;
    const ceilingMs = Math.min(settleCeilingMs ?? DEFAULT_SETTLE_CEILING_MS, MAX_SETTLE_CEILING_MS);
    await waitForAdaptiveSettle(page, { ceilingMs });
    attempt = await evaluateOnce();
  }

  if (attempt.usable && attempt.score >= RELEVANCE_ADOPT_THRESHOLD) {
    return {
      relevant: true,
      tier: "adopt",
      score: attempt.score,
      adoptThreshold: RELEVANCE_ADOPT_THRESHOLD,
      rejectThreshold: RELEVANCE_REJECT_THRESHOLD,
      resettled,
      resolvedViaModelAssist: false,
      uncertain: false,
      signals: attempt.signals,
    };
  }

  if (attempt.usable && attempt.score <= RELEVANCE_REJECT_THRESHOLD) {
    return {
      relevant: false,
      tier: "reject",
      score: attempt.score,
      adoptThreshold: RELEVANCE_ADOPT_THRESHOLD,
      rejectThreshold: RELEVANCE_REJECT_THRESHOLD,
      resettled,
      resolvedViaModelAssist: false,
      uncertain: false,
      signals: attempt.signals,
    };
  }

  // Still ambiguous (or still no usable document) after the one bounded resettle: try the
  // optional model-assist resolver exactly once, then fail closed on adoption if it is
  // absent, errors, or its resolution doesn't survive independent verification.
  const resolved = ambiguityResolver
    ? await resolveAmbiguousSurfaceRelevance(
        {
          objectiveText,
          title: attempt.signals.title,
          headings: attempt.signals.headings,
          interactiveText: attempt.signals.interactiveText,
          deterministicScore: attempt.score,
        },
        ambiguityResolver,
      )
    : undefined;

  return {
    relevant: resolved?.relevant ?? false,
    tier: "ambiguous",
    score: attempt.score,
    adoptThreshold: RELEVANCE_ADOPT_THRESHOLD,
    rejectThreshold: RELEVANCE_REJECT_THRESHOLD,
    resettled,
    resolvedViaModelAssist: resolved !== undefined,
    uncertain: resolved === undefined,
    signals: attempt.signals,
  };
}
