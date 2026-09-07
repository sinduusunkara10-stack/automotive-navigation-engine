import { test } from "node:test";
import assert from "node:assert/strict";

import { advanceInternalInstructionProgress } from "../../src/core/instructionProgress.js";
import type { SuccessCriterion } from "../../src/types/task-request.js";
import type { Observation } from "../../src/types/task-response.js";

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: "https://example-fictional-oem.test/page",
    title: "Page",
    interactiveElements: [],
    ...overrides,
  };
}

function criterion(description: string, overrides: Partial<SuccessCriterion> = {}): SuccessCriterion[] {
  return [
    {
      id: "objective-destination-reached",
      type: "semantic_page_match",
      description,
      required: true,
      ...overrides,
    },
  ];
}

const MULTILINE = "1. Select the specified item.\n2. Activate the progression action.\n3. Stop and return the resulting URL.";

test("a successful click with no relevant evidence at all leaves the ratchet unchanged (\"click success alone does not complete an instruction\")", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Unrelated decorative link" },
    postActionObservation: observation({ title: "Page", notableText: [] }),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("a failed action never advances progress, even with matching-looking evidence", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: false, targetAccessibleName: "Select the specified item" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("a successful click whose target accessible name matches the earliest-unfinished instruction's own vocabulary advances exactly that one instruction", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Select item" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), 1);
});

test("only the earliest unfinished instruction can advance -- matching evidence for a later instruction while an earlier one is still pending does not advance anything", () => {
  const progress = new Map<string, number>();
  // Evidence strongly matches instruction 2 ("Activate the progression action"), but
  // instruction 1 ("Select the specified item") has not been completed yet -- the ratchet
  // only ever evaluates the current earliest-unfinished segment (index 0), never a later one.
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Activate progression action" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("ambiguous post-action evidence (page state changed but shares no vocabulary with the earliest-unfinished instruction) does not advance", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: {
      type: "click",
      success: true,
      targetAccessibleName: "Learn more",
      resultingUrl: "https://example-fictional-oem.test/unrelated-marketing-page",
    },
    postActionObservation: observation({ title: "Special offers this month", notableText: ["Limited time only"] }),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("resultingUrl and post-action title/notableText are also valid evidence, not only the click target's own accessible name", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true },
    postActionObservation: observation({ title: "Item selected", notableText: ["Select the specified item"] }),
  });
  assert.equal(progress.get("objective-destination-reached"), 1);
});

test("a navigate action with a matching destination URL also advances progress (click is not the only progressing action type)", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "navigate", success: true, resultingUrl: "https://example-fictional-oem.test/select-item" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), 1);
});

test("scroll/wait actions never advance progress, however successful, since they carry no target-level evidence", () => {
  const progress = new Map<string, number>();
  for (const type of ["scroll", "wait"] as const) {
    advanceInternalInstructionProgress({
      successCriteria: criterion(MULTILINE),
      satisfiedCriteriaIds: new Set(),
      internalInstructionProgress: progress,
      lastAction: { type, success: true, resultingUrl: "https://example-fictional-oem.test/select-item" },
      postActionObservation: observation(),
    });
  }
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("the final (\"stop\") segment is never advanced heuristically, even with perfectly matching evidence -- only the real successCriteria evaluation completes it", () => {
  const progress = new Map<string, number>([["objective-destination-reached", 2]]);
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Stop and return the resulting URL" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), 2, "must not advance past segments.length - 1");
});

test("progress already recorded for an already-satisfied criterion is left untouched (no further heuristic work needed)", () => {
  const progress = new Map<string, number>([["objective-destination-reached", 1]]);
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE),
    satisfiedCriteriaIds: new Set(["objective-destination-reached"]),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Activate progression action" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), 1);
});

test("a criterion whose description does not parse into multiple lines is never touched by the ratchet", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion("Reach the completed configuration summary and stop."),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Reach the completed configuration summary" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("a grouped criterion is never touched by the ratchet, even with a multiline description", () => {
  const progress = new Map<string, number>();
  advanceInternalInstructionProgress({
    successCriteria: criterion(MULTILINE, { group: "either" }),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Select item" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), undefined);
});

test("one action never advances more than one instruction at a time, even if evidence happened to overlap multiple segments' vocabulary", () => {
  const progress = new Map<string, number>();
  const overlapping = "1. Select the item.\n2. Select the terminal action.\n3. Stop.";
  advanceInternalInstructionProgress({
    successCriteria: criterion(overlapping),
    satisfiedCriteriaIds: new Set(),
    internalInstructionProgress: progress,
    lastAction: { type: "click", success: true, targetAccessibleName: "Select the item and the terminal action" },
    postActionObservation: observation(),
  });
  assert.equal(progress.get("objective-destination-reached"), 1, "only the current earliest-unfinished segment may advance");
});
