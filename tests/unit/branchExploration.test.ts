import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessBranchProgress,
  classifyClosureFromSafetyFlags,
  computeEffectiveBranchDepth,
  isAmbiguousMultiCandidateDecisionPoint,
  DEFAULT_MAX_BRANCH_DEPTH,
} from "../../src/core/branchExploration.js";
import type { Observation } from "../../src/types/task-response.js";

/**
 * Goal-Directed Bounded Branch Exploration: pure, deterministic unit coverage for the
 * decision logic in src/core/branchExploration.ts, independent of the full engine loop
 * (see tests/integration/branchExploration.test.ts for end-to-end coverage). No
 * brand/site-specific wording anywhere in this file, per CLAUDE.md's non-negotiable design
 * rule -- every fixture element/label below is a generic, synthetic placeholder.
 */

test("computeEffectiveBranchDepth: caps at the requested default when the run budget is generous", () => {
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 50,
    backtracksRemaining: 20,
    elapsedMs: 0,
  });
  assert.equal(depth, DEFAULT_MAX_BRANCH_DEPTH);
});

test("computeEffectiveBranchDepth: reduces depth when steps remaining are tight", () => {
  // totalStepsNeeded(d) = 2d + 2 <= stepsRemaining -> d <= (stepsRemaining - 2) / 2
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 6, // (6-2)/2 = 2
    backtracksRemaining: 20,
    elapsedMs: 0,
  });
  assert.equal(depth, 2);
});

test("computeEffectiveBranchDepth: reduces depth when backtracks remaining are tight", () => {
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 50,
    backtracksRemaining: 2, // backtrackBound = 2 - 1 = 1
    elapsedMs: 0,
  });
  assert.equal(depth, 1);
});

test("computeEffectiveBranchDepth: returns 0 (never negative) when the budget cannot support any branch depth at all", () => {
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 1,
    backtracksRemaining: 0,
    elapsedMs: 0,
  });
  assert.equal(depth, 0);
});

test("computeEffectiveBranchDepth: returns 0 once at least 90% of maxDurationSeconds has already elapsed", () => {
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 50,
    backtracksRemaining: 20,
    maxDurationSeconds: 100,
    elapsedMs: 91_000,
  });
  assert.equal(depth, 0);
});

test("computeEffectiveBranchDepth: unaffected by maxDurationSeconds well below the 90% threshold", () => {
  const depth = computeEffectiveBranchDepth({
    requestedMaxDepth: DEFAULT_MAX_BRANCH_DEPTH,
    stepsRemaining: 50,
    backtracksRemaining: 20,
    maxDurationSeconds: 100,
    elapsedMs: 10_000,
  });
  assert.equal(depth, DEFAULT_MAX_BRANCH_DEPTH);
});

function observation(elements: Array<{ role: string; accessibleName: string }>): Observation {
  return {
    url: "http://example.test/page",
    title: "Page",
    interactiveElements: elements.map((el, index) => ({
      id: `el-${index}`,
      role: el.role,
      accessibleName: el.accessibleName,
      visible: true,
    })),
  };
}

test("isAmbiguousMultiCandidateDecisionPoint: true when 2+ candidates all score zero relevance against the objective", () => {
  const obs = observation([
    { role: "link", accessibleName: "See more" },
    { role: "link", accessibleName: "Learn about this" },
  ]);
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, true);
});

test("isAmbiguousMultiCandidateDecisionPoint: false when one candidate already lexically matches the objective", () => {
  const obs = observation([
    { role: "link", accessibleName: "See more" },
    { role: "link", accessibleName: "Reach the target page" },
  ]);
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, false);
});

test("isAmbiguousMultiCandidateDecisionPoint: true when one candidate has a weak, non-dominant UNIQUE top score -- a single incidental word match must not silence exploration of a zero-scoring alternative", () => {
  const obs = observation([
    { role: "link", accessibleName: "See more" },
    { role: "link", accessibleName: "Continue reading this page" },
  ]);
  // "Continue reading this page" shares only "page" out of 3 of its own tokens with the
  // objective -- a weak (1/3), unique-top, but non-dominant score (below
  // MIN_DOMINANT_RELEVANCE_SCORE). Being the unique top scorer is not enough on its own to
  // be trusted; the match itself must also be strong.
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, true);
});

test("isAmbiguousMultiCandidateDecisionPoint: false when two candidates TIE, but the tie is at a DOMINANT score -- two genuinely strong matches are left to existing selection behaviour", () => {
  const obs = observation([
    { role: "link", accessibleName: "Continue" },
    { role: "link", accessibleName: "Objective control" },
  ]);
  // Regression case (see tests/integration/journeyReplanning.test.ts's domain-blocked
  // replanning scenario): both candidates fully match their own (short) label against the
  // objective and tie at the maximum score, 1.0 -- a *tie*, but not remotely an absence of
  // signal. Branch mode must not engage here; the existing, already-validated
  // direct-selection/ranking behaviour is trusted for a dominant match, tied or not.
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Continue, then activate the objective control.",
  });
  assert.equal(result, false);
});

test("isAmbiguousMultiCandidateDecisionPoint: true when two candidates tie for the highest score, and that tied score is itself weak/non-dominant", () => {
  const obs = observation([
    { role: "link", accessibleName: "Continue further to the page" },
    { role: "link", accessibleName: "Proceed further to the page" },
  ]);
  // Both candidates share exactly one token ("page") out of 3 of their own with the
  // objective and score identically (1/3 each) -- a genuine tie, and a weak one: lexical
  // overlap alone cannot decide between them, and neither match is strong enough to trust.
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, true);
});

test("isAmbiguousMultiCandidateDecisionPoint: false when fewer than two distinct candidates are present", () => {
  const obs = observation([{ role: "link", accessibleName: "See more" }]);
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, false);
});

test("isAmbiguousMultiCandidateDecisionPoint: identical candidates repeated do not count as two distinct choices", () => {
  const obs = observation([
    { role: "link", accessibleName: "See more" },
    { role: "link", accessibleName: "See more" },
  ]);
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, false);
});

test("isAmbiguousMultiCandidateDecisionPoint: excludes hidden/disabled/covered elements from the candidate count", () => {
  const obs: Observation = {
    url: "http://example.test/page",
    title: "Page",
    interactiveElements: [
      { id: "a", role: "link", accessibleName: "See more", visible: true },
      { id: "b", role: "link", accessibleName: "Learn about this", visible: false },
      { id: "c", role: "link", accessibleName: "Explore options", disabled: true, visible: true },
    ],
  };
  const result = isAmbiguousMultiCandidateDecisionPoint({
    observation: obs,
    relevanceText: "Reach the designated target page.",
  });
  assert.equal(result, false);
});

test("assessBranchProgress: continues on ordinary progress within the depth budget", () => {
  const result = assessBranchProgress({
    depth: 1,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(result.shouldContinue, true);
  assert.equal(result.result, "neutral_progress");
  assert.equal(result.consecutiveNoProgress, 0);
});

test("assessBranchProgress: reports goal_progress and continues when a criterion became newly satisfied this step", () => {
  const result = assessBranchProgress({
    depth: 1,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 1,
    hasAnyNewlySatisfiedInBranch: true,
  });
  assert.equal(result.shouldContinue, true);
  assert.equal(result.result, "goal_progress");
});

test("assessBranchProgress: dead_end on revisiting a fingerprint already seen in this branch", () => {
  const result = assessBranchProgress({
    depth: 2,
    maxDepth: 3,
    isRevisitFingerprint: true,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(result.shouldContinue, false);
  assert.equal(result.result, "dead_end");
});

test("assessBranchProgress: dead_end after two consecutive no-progress actions", () => {
  // First no-progress action: consecutiveNoProgress goes 0 -> 1, still continues.
  const first = assessBranchProgress({
    depth: 1,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: false,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(first.shouldContinue, true);
  assert.equal(first.consecutiveNoProgress, 1);

  // Second consecutive no-progress action: now dead_end.
  const second = assessBranchProgress({
    depth: 2,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: false,
    consecutiveNoProgress: first.consecutiveNoProgress,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(second.shouldContinue, false);
  assert.equal(second.result, "dead_end");
});

test("assessBranchProgress: a single no-progress action resets to 0 once progress resumes", () => {
  const result = assessBranchProgress({
    depth: 1,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 1,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(result.consecutiveNoProgress, 0);
  assert.equal(result.shouldContinue, true);
});

test("assessBranchProgress: depth budget exhausted with no evidence gained closes as dead_end", () => {
  const result = assessBranchProgress({
    depth: 3,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: false,
  });
  assert.equal(result.shouldContinue, false);
  assert.equal(result.result, "dead_end");
});

test("assessBranchProgress: depth budget exhausted but with evidence gained closes as plausible_progress, not dead_end", () => {
  const result = assessBranchProgress({
    depth: 3,
    maxDepth: 3,
    isRevisitFingerprint: false,
    lastActionObservedProgress: true,
    consecutiveNoProgress: 0,
    newlySatisfiedCountThisStep: 0,
    hasAnyNewlySatisfiedInBranch: true,
  });
  assert.equal(result.shouldContinue, false);
  assert.equal(result.result, "plausible_progress");
});

test("classifyClosureFromSafetyFlags: loop_detected maps to dead_end", () => {
  assert.equal(classifyClosureFromSafetyFlags(["loop_detected"]), "dead_end");
});

test("classifyClosureFromSafetyFlags: domain_blocked and action_not_allowed map to unsafe", () => {
  assert.equal(classifyClosureFromSafetyFlags(["domain_blocked"]), "unsafe");
  assert.equal(classifyClosureFromSafetyFlags(["action_not_allowed"]), "unsafe");
});

test("classifyClosureFromSafetyFlags: any other flag (e.g. repeated_action) maps to blocked", () => {
  assert.equal(classifyClosureFromSafetyFlags(["repeated_action"]), "blocked");
  assert.equal(classifyClosureFromSafetyFlags([]), "blocked");
});
