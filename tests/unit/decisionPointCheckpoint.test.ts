import { test } from "node:test";
import assert from "node:assert/strict";

import { captureDecisionPointCheckpoint, isEquivalentCheckpoint, MAX_DECISION_POINT_CHECKPOINTS } from "../../src/core/decisionPointCheckpoint.js";
import { RunState } from "../../src/core/state.js";
import type { Observation } from "../../src/types/task-response.js";

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: "http://example.com/configurator",
    title: "Configurator Summary",
    interactiveElements: [{ id: "el-1", role: "button", accessibleName: "View Offer", visible: true } as never],
    notableText: ["Configurator Summary", "Choose your trim"],
    ...overrides,
  } as unknown as Observation;
}

test("captureDecisionPointCheckpoint never carries raw query strings/fragments or element ids into its sanitized fields", () => {
  const observation = makeObservation({ url: "http://example.com/configurator?session_id=SECRET#frag" } as never);
  const checkpoint = captureDecisionPointCheckpoint({
    branchId: "branch-1",
    stepIndex: 3,
    observation,
    activeSurfaceIdentity: "main",
    activeMilestoneIds: ["reached_summary"],
    remainingMilestoneConcepts: ["reached_summary"],
    candidatesAlreadyAttempted: [],
    routeDepth: 0,
  });
  // fingerprint reuses routeMemory.ts's own computeDecisionPointFingerprint verbatim (never
  // reinvented here -- see CLAUDE.md), which is keyed partly on the raw URL by design
  // (same as RecoveryAnchor.decisionPointFingerprint/RecoveryAttemptDiagnostic.
  // targetFingerprint elsewhere on this wire); this checkpoint object itself is RAM-only and
  // is never persisted into Journey Memory (only sanitized segments derived from OTHER
  // diagnostics are -- see segmentBuilder.ts), so this is checked separately from every
  // other, genuinely-sanitized field on the checkpoint.
  const { fingerprint: _fingerprint, ...withoutFingerprint } = checkpoint;
  const serialized = JSON.stringify(withoutFingerprint);
  assert.ok(!serialized.includes("SECRET"));
  assert.ok(!serialized.includes("session_id"));
  assert.ok(!serialized.includes("#frag"));
  assert.ok(!serialized.includes("el-1"), "must never persist raw live element ids");
  assert.equal(checkpoint.evidenceSource, "observed");
});

test("RunState.captureCheckpoint dedupes an equivalent checkpoint for the same branch (same fingerprint)", () => {
  const state = new RunState();
  const observation = makeObservation();
  const checkpoint1 = captureDecisionPointCheckpoint({
    branchId: "branch-1",
    stepIndex: 1,
    observation,
    activeSurfaceIdentity: "main",
    activeMilestoneIds: [],
    remainingMilestoneConcepts: [],
    candidatesAlreadyAttempted: [],
    routeDepth: 0,
  });
  const checkpoint2 = captureDecisionPointCheckpoint({
    branchId: "branch-1",
    stepIndex: 2,
    observation,
    activeSurfaceIdentity: "main",
    activeMilestoneIds: [],
    remainingMilestoneConcepts: [],
    candidatesAlreadyAttempted: [],
    routeDepth: 0,
  });
  assert.ok(isEquivalentCheckpoint(checkpoint1, checkpoint2));
  state.captureCheckpoint(checkpoint1);
  state.captureCheckpoint(checkpoint2);
  assert.equal(state.checkpoints.length, 1, "an equivalent checkpoint for the same branch must be deduped, not accumulated");
});

test("RunState.captureCheckpoint is bounded: never grows past MAX_DECISION_POINT_CHECKPOINTS", () => {
  const state = new RunState();
  for (let i = 0; i < MAX_DECISION_POINT_CHECKPOINTS + 10; i += 1) {
    const observation = makeObservation({ url: `http://example.com/step-${i}` });
    state.captureCheckpoint(
      captureDecisionPointCheckpoint({
        branchId: `branch-${i}`,
        stepIndex: i,
        observation,
        activeSurfaceIdentity: "main",
        activeMilestoneIds: [],
        remainingMilestoneConcepts: [],
        candidatesAlreadyAttempted: [],
        routeDepth: 0,
      }),
    );
  }
  assert.equal(state.checkpoints.length, MAX_DECISION_POINT_CHECKPOINTS);
});

test("RunState.archiveActiveBranch discards that branch's checkpoint (in-process RAM only, never carried past branch completion)", () => {
  const state = new RunState();
  const observation = makeObservation();
  state.captureCheckpoint(
    captureDecisionPointCheckpoint({
      branchId: "branch-x",
      stepIndex: 1,
      observation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: [],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    }),
  );
  assert.ok(state.getCheckpointForBranch("branch-x"));
  state.startBranch({
    branchId: "branch-x",
    decisionPointId: "fp",
    candidateId: "c1",
    candidateLabel: "label",
    entryStepIndex: 1,
    depth: 0,
    maxDepth: 3,
    visitedFingerprints: [],
    satisfiedCriteriaIdsAtEntry: [],
    newlySatisfiedCriteriaIds: [],
    consecutiveNoProgress: 0,
    returnHopsAttempted: 0,
    returnHopsBudget: 1,
    entryReason: "ambiguity",
    consentInterruptionsHandled: 0,
    routeStartUrl: observation.url,
    urlsVisited: [observation.url],
    surfacesOpened: [],
    candidateRank: 1,
  });
  state.archiveActiveBranch();
  assert.equal(state.getCheckpointForBranch("branch-x"), undefined, "the checkpoint must be discarded once its branch is archived");
});
