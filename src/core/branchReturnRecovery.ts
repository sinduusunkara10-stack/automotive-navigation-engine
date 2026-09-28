import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures, Observation } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { buildObservation } from "../observation/observationBuilder.js";
import { computeDecisionPointFingerprint } from "./routeMemory.js";
import { waitForAdaptiveSettle } from "./robustNavigation.js";
import { gatherSemanticPageSignals, scoreSemanticPageMatch, type SemanticSignalName } from "./semanticPageMatch.js";
import { tokenize } from "../discovery/relevance.js";
import { executeScroll } from "../actions/scroll.js";
import { executeNavigate } from "../actions/navigate.js";
import type { DecisionPointCheckpoint } from "./decisionPointCheckpoint.js";

/**
 * Production incident (2nd occurrence after PR #68), run_fae0519a-ef71-46b9-a053-4ca82bb30000:
 * a go_back reporting goBackOutcome "navigation_committed_restoration_unverified" (PR #68's own
 * new outcome state) still ended the run in decision_point_restore_failed with
 * reObservationAttempted/fallbackNavigationAttempted both false. PR #68's own PR body claimed
 * this outcome was wired into core/loop.ts's re-observation pipeline; in fact the branch-return
 * -hop code path only ran a bare waitForAdaptiveSettle and then fell through, relying entirely
 * on the *next* runStep call's top-of-function check -- an exact-string fingerprint comparison
 * (url + sorted role::accessibleName list, see routeMemory.ts) with no semantic fallback and no
 * bounded candidate re-discovery. A restored page that differs from the original decision point
 * by even one query parameter or one incidentally-added/removed control (a slow-hydrating page,
 * a session-scoped query string) can never satisfy that exact check, so the branch's own bounded
 * return-hop budget silently exhausted against a page that was, in every semantically meaningful
 * sense, already restored.
 *
 * This module supplies the two missing pieces, reusing only existing primitives (never a new
 * waiting/readiness/memory framework -- see CLAUDE.md): a bounded live re-observation +
 * semantic-match verification (reobserveForBranchReturn), and a last-resort checkpoint
 * reconstruction fallback (attemptCheckpointReconstruction) using PR #68's own
 * DecisionPointCheckpoint, explicitly deferred by PR #68's own PR body ("future work").
 */

const MIN_SEMANTIC_RESTORATION_SCORE = 0.35;
const MAX_BOUNDED_SCROLL_DISCOVERY_ATTEMPTS = 3;

// Deliberately excludes "interactiveElements": persistent, site-wide, non-navigational
// controls (a large "background" set of filler/utility links present identically across
// many/most pages of a site) dominate an interactive-element token-overlap comparison
// regardless of which page is actually live, producing false-positive restoration matches
// on genuinely different pages that merely share the same surrounding chrome/filler
// controls. Headings and title are far better page-identity discriminators for this
// specific "did browser history actually land back on the origin decision point" check --
// see the investigation behind this fix (production incident
// run_fae0519a-ef71-46b9-a053-4ca82bb30000, 2nd occurrence) and semanticPageMatch.ts's own
// analogous NAVIGATION_CHROME_SELECTOR exclusion for the same class of problem.
const RESTORATION_SEMANTIC_SIGNALS: readonly SemanticSignalName[] = ["title", "headings"];

// A checkpoint whose anchor text tokenizes to very few distinct words (e.g. a task with no
// semantic-page-match milestones at all, whose checkpoint anchor collapses to just the
// origin page's own title) is too thin to discriminate reliably: a short title is often a
// literal substring of an unrelated page's own longer title (shared site name/section
// prefix), which token-overlap coverage scores as a perfect match regardless of whether the
// destination is actually the same page. Below this floor, semantic matching is skipped
// entirely and only the exact fingerprint check (already tried above) counts as verified --
// never a new readiness/memory mechanism, just a lower bound on how little evidence is
// trusted.
const MIN_ANCHOR_TOKEN_COUNT = 4;

export type BranchReturnVerificationBasis = "fingerprint" | "semantic_match" | "none";

export interface BranchReturnReObservationResult {
  verified: boolean;
  matchBasis: BranchReturnVerificationBasis;
  observation: Observation;
  scrollAttemptsUsed: number;
  semanticScore?: number;
}

function checkpointAnchorText(checkpoint: DecisionPointCheckpoint | undefined): string {
  if (!checkpoint) {
    return "";
  }
  // Deliberately omits checkpoint.candidateMeanings: it is every visible interactive
  // element (including persistent background/filler controls) captured at branch-entry
  // time, and is exactly the noise-dominated field that, paired with the interactiveText
  // signal, produced this fix's motivating false-positive -- see
  // RESTORATION_SEMANTIC_SIGNALS above.
  return [
    checkpoint.remainingMilestoneConcepts.join(" "),
    checkpoint.titleConcepts,
    checkpoint.stableHeadingConcepts.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Synchronous decision-point match against an Observation the caller already has in hand
 * (e.g. this step's own already-built, already-preamble-processed observation) -- never
 * triggers a fresh DOM read of its own, so it is safe to call at any point in loop.ts's
 * per-step flow without re-ordering or bypassing the preamble (drawer/modal formalization,
 * consent handling, panel-evidence gathering, etc.) that normally runs on a fresh
 * observation. Signals are built the same way captureDecisionPointCheckpoint itself derives
 * a checkpoint's own titleConcepts/stableHeadingConcepts/candidateMeanings (observation.title/
 * notableText/interactiveElements), so the comparison is apples to apples.
 */
export function matchesDecisionPoint(
  observation: Observation,
  decisionPointFingerprint: string,
  checkpoint?: DecisionPointCheckpoint,
): { verified: boolean; matchBasis: BranchReturnVerificationBasis } {
  const fingerprint = computeDecisionPointFingerprint(observation);
  if (fingerprint === decisionPointFingerprint) {
    return { verified: true, matchBasis: "fingerprint" };
  }
  const anchorText = checkpointAnchorText(checkpoint);
  if (!anchorText || tokenize(anchorText).length < MIN_ANCHOR_TOKEN_COUNT) {
    return { verified: false, matchBasis: "none" };
  }
  const signals = {
    title: observation.title,
    headings: observation.notableText ?? [],
    interactiveText: observation.interactiveElements.filter((el) => el.visible !== false).map((el) => el.accessibleName),
  };
  const score = scoreSemanticPageMatch(anchorText, signals, RESTORATION_SEMANTIC_SIGNALS);
  return score.overall >= MIN_SEMANTIC_RESTORATION_SCORE
    ? { verified: true, matchBasis: "semantic_match" }
    : { verified: false, matchBasis: "none" };
}

/**
 * Bounded, live re-observation of the current page against a branch's own recorded
 * decision-point fingerprint -- Task 1's fix. Never sends raw HTML, never reuses a stored
 * element id/handle (every observation below is freshly built from the live DOM, so a
 * stale/replaced/hydrating element is always re-observed rather than replayed). A changed URL
 * alone is never treated as verification here -- only an exact fingerprint match or a semantic
 * match against the checkpoint's own unfinished-objective vocabulary counts.
 *
 * Discovery order: the freshest observation first (no scroll), then, only if neither the exact
 * fingerprint nor a semantic match against currently-rendered content clears the bar, a small
 * bounded number of scroll-then-recheck rounds (reusing actions/scroll.ts's own executor and
 * waitForAdaptiveSettle -- never a new scrolling/readiness mechanism). Bounded by
 * MAX_BOUNDED_SCROLL_DISCOVERY_ATTEMPTS regardless of outcome.
 */
export async function reobserveForBranchReturn(params: {
  page: Page;
  withActiveSurface: (observation: Observation) => Observation;
  decisionPointFingerprint: string;
  checkpoint?: DecisionPointCheckpoint;
  settleCeilingMs?: number;
}): Promise<BranchReturnReObservationResult> {
  const { page, withActiveSurface, decisionPointFingerprint, checkpoint, settleCeilingMs } = params;

  let observation = withActiveSurface(await buildObservation(page));
  const fingerprint = computeDecisionPointFingerprint(observation);
  if (fingerprint === decisionPointFingerprint) {
    return { verified: true, matchBasis: "fingerprint", observation, scrollAttemptsUsed: 0 };
  }

  const anchorText = checkpointAnchorText(checkpoint);
  let scrollAttemptsUsed = 0;
  if (anchorText && tokenize(anchorText).length >= MIN_ANCHOR_TOKEN_COUNT) {
    for (let attempt = 0; attempt <= MAX_BOUNDED_SCROLL_DISCOVERY_ATTEMPTS; attempt += 1) {
      const signals = await gatherSemanticPageSignals(page).catch(() => undefined);
      if (signals) {
        const score = scoreSemanticPageMatch(anchorText, signals, RESTORATION_SEMANTIC_SIGNALS);
        if (score.overall >= MIN_SEMANTIC_RESTORATION_SCORE) {
          observation = withActiveSurface(await buildObservation(page));
          return {
            verified: true,
            matchBasis: "semantic_match",
            observation,
            scrollAttemptsUsed: attempt,
            semanticScore: score.overall,
          };
        }
      }
      if (attempt === MAX_BOUNDED_SCROLL_DISCOVERY_ATTEMPTS) {
        break;
      }
      await executeScroll(page, { type: "scroll" }).catch(() => undefined);
      await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });
      scrollAttemptsUsed = attempt + 1;
    }
  }

  observation = withActiveSurface(await buildObservation(page));
  return { verified: false, matchBasis: "none", observation, scrollAttemptsUsed };
}

// Generic loopback/private-host transport-scheme heuristic (never a brand/site-specific
// rule): a checkpoint's sanitized registrableDomain never carries a scheme or port (see
// sanitizePageIdentity, journeyMemory/sanitizer.ts), so reconstruction infers one. Every
// real site this engine targets is https; a bare IPv4 literal or "localhost" (the shape a
// local dev/test fixture server uses) is the one case worth defaulting to http instead.
const LOOPBACK_HOST_PATTERN = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)(:\d+)?$/i;

function inferReconstructionScheme(registrableDomain: string): "http" | "https" {
  return LOOPBACK_HOST_PATTERN.test(registrableDomain) ? "http" : "https";
}

export type CheckpointReconstructionOutcome =
  | "not_attempted"
  | "verified"
  | "unverified"
  | "skipped_fingerprint_guard"
  | "skipped_no_checkpoint";

export interface CheckpointReconstructionResult {
  attempted: boolean;
  used: boolean;
  checkpointMatched: boolean;
  outcome: CheckpointReconstructionOutcome;
  finalLiveVerificationOutcome: "restored" | "unverified" | "restore_failed";
  observation?: Observation;
  navigateActionResult?: ActionResult;
}

/**
 * Task 2 -- PR #68's own explicitly-deferred "future work" piece: a last-resort
 * reconstruction, invoked only once bounded live re-observation (above) has already failed to
 * verify restoration via browser history. Navigates via the ordinary `navigate` action's own
 * mechanics (executeNavigate/robustGoto -- never a new navigation path) to the checkpoint's
 * already-sanitized URL only (registrableDomain + normalizedPath -- never a raw/query-bearing
 * URL), then re-observes and re-verifies exactly as reobserveForBranchReturn does for a genuine
 * go_back. The checkpoint itself never verifies anything -- only this live re-observation does.
 * `alreadyAttemptedFingerprints` (RunState-scoped, one per run) guards against ever
 * reconstructing to the same checkpoint fingerprint twice.
 */
export async function attemptCheckpointReconstruction(params: {
  page: Page;
  withActiveSurface: (observation: Observation) => Observation;
  checkpoint: DecisionPointCheckpoint | undefined;
  decisionPointFingerprint: string;
  allowedDomains: string[];
  actionNavigationTimeoutMs: number;
  settleCeilingMs?: number;
  captures: Captures;
  captureModules: CaptureModuleName[];
  stepIndex: number;
  alreadyAttemptedFingerprints: Set<string>;
}): Promise<CheckpointReconstructionResult> {
  const {
    page,
    withActiveSurface,
    checkpoint,
    decisionPointFingerprint,
    allowedDomains,
    actionNavigationTimeoutMs,
    settleCeilingMs,
    captures,
    captureModules,
    stepIndex,
    alreadyAttemptedFingerprints,
  } = params;

  if (!checkpoint) {
    return {
      attempted: false,
      used: false,
      checkpointMatched: false,
      outcome: "skipped_no_checkpoint",
      finalLiveVerificationOutcome: "restore_failed",
    };
  }

  if (alreadyAttemptedFingerprints.has(checkpoint.fingerprint)) {
    return {
      attempted: false,
      used: false,
      checkpointMatched: true,
      outcome: "skipped_fingerprint_guard",
      finalLiveVerificationOutcome: "restore_failed",
    };
  }
  alreadyAttemptedFingerprints.add(checkpoint.fingerprint);

  const targetUrl = `${inferReconstructionScheme(checkpoint.sanitizedUrl.registrableDomain)}://${checkpoint.sanitizedUrl.registrableDomain}${checkpoint.sanitizedUrl.normalizedPath}`;
  const navigateAction: SelectedAction = { type: "navigate", target: targetUrl };
  const navigateActionResult = await executeNavigate({
    page,
    action: navigateAction,
    allowedDomains,
    timeoutMs: actionNavigationTimeoutMs,
    captures,
    stepIndex,
    captureModules,
    settleCeilingMs,
  });

  if (!navigateActionResult.success) {
    return {
      attempted: true,
      used: false,
      checkpointMatched: true,
      outcome: "unverified",
      finalLiveVerificationOutcome: "restore_failed",
      navigateActionResult,
    };
  }

  // Bounded, safe-public-context-only restoration (Task 2 item 7): a single wheel scroll
  // toward the checkpoint's own recorded scrollY, never a loop, never restoring anything
  // beyond this generic, non-sensitive scroll position.
  if (typeof checkpoint.scrollY === "number" && checkpoint.scrollY > 0) {
    await executeScroll(page, { type: "scroll", params: { deltaY: checkpoint.scrollY } }).catch(() => undefined);
    await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });
  }

  const reObservation = await reobserveForBranchReturn({
    page,
    withActiveSurface,
    decisionPointFingerprint,
    checkpoint,
    settleCeilingMs,
  });

  return {
    attempted: true,
    used: true,
    checkpointMatched: true,
    outcome: reObservation.verified ? "verified" : "unverified",
    finalLiveVerificationOutcome: reObservation.verified ? "restored" : "unverified",
    observation: reObservation.observation,
    navigateActionResult,
  };
}
