import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForwardSegments, buildRecoverySegments } from "../../src/core/journeyMemory/segmentBuilder.js";
import type { StepLog } from "../../src/types/task-response.js";
import type {
  AlternativeCandidateAttemptDiagnostic,
  RecoveryAttemptDiagnostic,
  RouteAttemptDiagnostic,
} from "../../src/types/recovery.js";

function makeStep(overrides: Partial<StepLog> & { stepIndex: number; currentUrl: string }): StepLog {
  return {
    timestamp: new Date().toISOString(),
    observation: {
      url: overrides.currentUrl,
      title: "Page",
      interactiveElements: [],
      notableText: [],
    } as unknown as StepLog["observation"],
    decision: "reason",
    selectedAction: { type: "click", target: "el-1" },
    actionResult: { success: true } as unknown as StepLog["actionResult"],
    progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
    ...overrides,
  };
}

test("buildForwardSegments produces a segment for each observed URL transition, tagged success when a milestone newly satisfied", () => {
  const steps: StepLog[] = [
    makeStep({ stepIndex: 0, currentUrl: "http://example.com/a", progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 } }),
    makeStep({ stepIndex: 1, currentUrl: "http://example.com/b", progress: { satisfiedCriteriaIds: ["reached_b"], estimatedCompletion: 1 } }),
  ];
  const segments = buildForwardSegments({
    steps,
    runId: "run-1",
    registrableDomain: "example.com",
    objective: "reach b",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.outcome, "success");
});

test("buildForwardSegments never persists raw query strings", () => {
  const steps: StepLog[] = [
    makeStep({ stepIndex: 0, currentUrl: "http://example.com/a?session_id=SECRET" }),
    makeStep({ stepIndex: 1, currentUrl: "http://example.com/b?session_id=SECRET" }),
  ];
  const segments = buildForwardSegments({
    steps,
    runId: "run-1",
    registrableDomain: "example.com",
    objective: "reach b",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.ok(!JSON.stringify(segments).includes("SECRET"));
});

test("a partially successful run (never reaching every milestone) still produces every independently-verified forward segment", () => {
  const steps: StepLog[] = [
    makeStep({ stepIndex: 0, currentUrl: "http://example.com/a" }),
    makeStep({ stepIndex: 1, currentUrl: "http://example.com/b" }),
    makeStep({ stepIndex: 2, currentUrl: "http://example.com/b" }), // no URL change -- no segment
  ];
  const segments = buildForwardSegments({
    steps,
    runId: "run-1",
    registrableDomain: "example.com",
    objective: "reach b",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1);
});

test("buildRecoverySegments captures a decision_point_restore_failed-shaped attempt (hops_exhausted, not restored) as a not_recovered segment", () => {
  const attempts: RecoveryAttemptDiagnostic[] = [
    {
      stepIndex: 0,
      anchorCriterionId: "reached_configurator",
      anchorMilestoneOrder: 1,
      targetFingerprint: "fp-1",
      hopsAttempted: 3,
      hopsBudget: 3,
      restored: false,
      failureReason: "hops_exhausted",
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 0, currentUrl: "http://example.com/summary" })];
  const segments = buildRecoverySegments({
    attempts,
    steps,
    runId: "run-2",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.finalRecoveryOutcome, "not_recovered");
  assert.equal(segments[0]?.failureType, "hops_exhausted");
  assert.equal(segments[0]?.knownExhaustedCandidate, true);
});

test("buildRecoverySegments marks a successfully restored anchor as recovered, movedCloserToObjective true", () => {
  const attempts: RecoveryAttemptDiagnostic[] = [
    {
      stepIndex: 0,
      anchorCriterionId: "reached_configurator",
      anchorMilestoneOrder: 1,
      targetFingerprint: "fp-1",
      hopsAttempted: 1,
      hopsBudget: 3,
      restored: true,
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 0, currentUrl: "http://example.com/configurator" })];
  const segments = buildRecoverySegments({
    attempts,
    steps,
    runId: "run-3",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments[0]?.finalRecoveryOutcome, "recovered");
  assert.equal(segments[0]?.movedCloserToObjective, true);
});

test("buildRecoverySegments: a production-shaped decision_point_restore_failed fixture (branch-return-hop path, routeAttemptDiagnostics only -- no recoveryAttemptDiagnostics entry) still produces a recovery segment", () => {
  // Fix 4 regression fixture: the production incident (run_b3743f06-1667-443e-b9fa-e804aa5caecf)
  // wrote only to routeAttemptDiagnostics/alternativeCandidateDiagnostics, never
  // recoveryAttemptDiagnostics -- reproduced here with attempts: [] to prove the gap is closed.
  const routeAttempts: RouteAttemptDiagnostic[] = [
    {
      anchorFingerprint: "fp-1",
      anchorCriterionId: "reached_configurator_summary",
      candidateId: "cand-1",
      candidateLabel: "View Offer",
      candidateRank: 1,
      routeStartStepIndex: 2,
      routeStartUrl: "http://example.com/configurator",
      stepIndex: 5,
      status: "candidate_exhausted",
      urlsVisited: ["http://example.com/configurator", "http://example.com/offer"],
      surfacesOpened: [],
      milestoneStateBefore: [],
      milestoneStateAtTransition: [],
      consentInterruptionsHandled: 0,
      terminationReason: "go_back_failed",
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 5, currentUrl: "http://example.com/offer" })];
  const segments = buildRecoverySegments({
    attempts: [],
    routeAttempts,
    steps,
    runId: "run-prod-incident",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.segmentSource, "route_attempt");
  assert.equal(segments[0]?.finalRecoveryOutcome, "not_recovered");
  assert.equal(segments[0]?.failureType, "go_back_failed");
});

test("buildRecoverySegments: alternativeCandidateDiagnostics source produces an eligible segment", () => {
  const alternativeCandidateAttempts: AlternativeCandidateAttemptDiagnostic[] = [
    {
      anchorFingerprint: "fp-2",
      anchorCriterionId: "reached_summary",
      candidateId: "cand-2",
      candidateLabel: "Alt Link",
      stepIndex: 3,
      progressResult: "advanced",
      attemptNumber: 1,
      budget: 3,
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 3, currentUrl: "http://example.com/summary" })];
  const segments = buildRecoverySegments({
    attempts: [],
    alternativeCandidateAttempts,
    steps,
    runId: "run-alt",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.segmentSource, "alternative_candidate");
  assert.equal(segments[0]?.finalRecoveryOutcome, "recovered");
});

test("buildRecoverySegments: an equivalent segment reported by two sources (same anchor/step/outcome) is deduped, not doubled", () => {
  const attempts: RecoveryAttemptDiagnostic[] = [
    {
      stepIndex: 4,
      anchorCriterionId: "reached_configurator",
      anchorMilestoneOrder: 1,
      targetFingerprint: "fp-3",
      hopsAttempted: 1,
      hopsBudget: 3,
      restored: true,
    },
  ];
  const routeAttempts: RouteAttemptDiagnostic[] = [
    {
      anchorFingerprint: "fp-3",
      anchorCriterionId: "reached_configurator",
      candidateId: "cand-3",
      candidateLabel: "View Offer",
      candidateRank: 1,
      routeStartStepIndex: 1,
      routeStartUrl: "http://example.com/configurator",
      stepIndex: 4,
      status: "anchor_restored",
      urlsVisited: [],
      surfacesOpened: [],
      milestoneStateBefore: [],
      milestoneStateAtTransition: [],
      consentInterruptionsHandled: 0,
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 4, currentUrl: "http://example.com/configurator" })];
  const segments = buildRecoverySegments({
    attempts,
    routeAttempts,
    steps,
    runId: "run-dedupe",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments.length, 1, "the same anchor/step/outcome from two sources must be deduped to one segment");
  assert.equal(segments[0]?.segmentSource, "recovery_attempt", "first-source-wins: recoveryAttemptDiagnostics was normalized first");
});

test("buildRecoverySegments: an unverified/failed restoration is never reported as a recovered segment (never itself confers verified-success confidence)", () => {
  const routeAttempts: RouteAttemptDiagnostic[] = [
    {
      anchorFingerprint: "fp-4",
      anchorCriterionId: "reached_configurator",
      candidateId: "cand-4",
      candidateLabel: "View Offer",
      candidateRank: 1,
      routeStartStepIndex: 1,
      routeStartUrl: "http://example.com/configurator",
      stepIndex: 6,
      status: "candidate_exhausted",
      urlsVisited: [],
      surfacesOpened: [],
      milestoneStateBefore: [],
      milestoneStateAtTransition: [],
      consentInterruptionsHandled: 0,
      terminationReason: "anchor_restore_failed",
    },
  ];
  const steps: StepLog[] = [makeStep({ stepIndex: 6, currentUrl: "http://example.com/dead-end" })];
  const segments = buildRecoverySegments({
    attempts: [],
    routeAttempts,
    steps,
    runId: "run-unverified",
    registrableDomain: "example.com",
    evidenceTier: "tier1",
    schemaVersion: "1.0.0",
  });
  assert.equal(segments[0]?.finalRecoveryOutcome, "not_recovered");
  assert.ok(segments[0]!.confidence < 0.5, "a failed/unverified restoration must never carry a confident-success-shaped confidence");
});
