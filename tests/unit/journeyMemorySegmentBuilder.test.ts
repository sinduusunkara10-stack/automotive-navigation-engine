import { test } from "node:test";
import assert from "node:assert/strict";

import { buildForwardSegments, buildRecoverySegments } from "../../src/core/journeyMemory/segmentBuilder.js";
import type { StepLog } from "../../src/types/task-response.js";
import type { RecoveryAttemptDiagnostic } from "../../src/types/recovery.js";

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
