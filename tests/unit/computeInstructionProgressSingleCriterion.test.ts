import { test } from "node:test";
import assert from "node:assert/strict";

import { computeInstructionProgress } from "../../src/reasoning/promptBuilder.js";
import type { SuccessCriterion } from "../../src/types/task-request.js";

// The real n8n request shape: exactly one semantic_page_match successCriterion whose
// description is the caller's complete multiline ordered objective, not one criterion per
// instruction. These tests prove computeInstructionProgress expands that single criterion
// into ordered synthetic sub-positions and partitions them exactly like a multi-criterion
// successCriteria list already did before this change (see the existing multi-criterion
// tests in tests/integration/orderedInstructionExecution.test.ts, unaffected by this).

const MULTILINE_DESCRIPTION =
  "1. Select the specified item.\n2. Activate the progression action.\n3. Select the specified terminal action.\n4. Stop and return the resulting URL.";

function singleCriterion(overrides: Partial<SuccessCriterion> = {}): SuccessCriterion[] {
  return [
    {
      id: "objective-destination-reached",
      type: "semantic_page_match",
      description: MULTILINE_DESCRIPTION,
      config: { minScore: 0.4 },
      required: true,
      ...overrides,
    },
  ];
}

test("a single criterion's multiline description expands into one synthetic position per parsed line", () => {
  const progress = computeInstructionProgress(singleCriterion(), []);
  const allPositions = [...progress.completed, ...(progress.earliestUnfinished ? [progress.earliestUnfinished] : []), ...progress.pending];
  assert.equal(allPositions.length, 4);
  assert.deepEqual(
    allPositions.map((p) => p.ids[0]),
    [
      "objective-destination-reached#0",
      "objective-destination-reached#1",
      "objective-destination-reached#2",
      "objective-destination-reached#3",
    ],
  );
});

test("with no internal progress yet, the earliest unfinished instruction is segment 0 and the terminal is the final \"stop\" segment", () => {
  const progress = computeInstructionProgress(singleCriterion(), []);
  assert.equal(progress.completed.length, 0);
  assert.equal(progress.earliestUnfinished?.descriptions[0], "Select the specified item.");
  assert.equal(progress.terminal?.descriptions[0], "Stop and return the resulting URL.");
  assert.equal(progress.pending.length, 3);
});

test("internalInstructionProgress advances the earliest-unfinished pointer without touching later or completed segments", () => {
  const progress = computeInstructionProgress(singleCriterion(), [], { "objective-destination-reached": 2 });
  assert.equal(progress.completed.length, 2);
  assert.deepEqual(
    progress.completed.map((p) => p.descriptions[0]),
    ["Select the specified item.", "Activate the progression action."],
  );
  assert.equal(progress.earliestUnfinished?.descriptions[0], "Select the specified terminal action.");
  assert.equal(progress.pending.length, 1);
  assert.equal(progress.pending[0]?.descriptions[0], "Stop and return the resulting URL.");
});

test("internal progress can never mark the final (\"stop\") segment complete on its own -- it caps one below the total segment count", () => {
  // Even if some caller/heuristic bug tried to report every segment done via the internal
  // ratchet, the real successCriteria evaluation (satisfiedCriteriaIds) remains the only way
  // the terminal segment itself is ever marked complete.
  const progress = computeInstructionProgress(singleCriterion(), [], { "objective-destination-reached": 4 });
  assert.equal(progress.completed.length, 3);
  assert.equal(progress.earliestUnfinished?.descriptions[0], "Stop and return the resulting URL.");
});

test("once the real criterion is satisfied (satisfiedCriteriaIds), every parsed segment -- including the terminal one -- is reported completed", () => {
  const progress = computeInstructionProgress(singleCriterion(), ["objective-destination-reached"], {
    "objective-destination-reached": 1,
  });
  assert.equal(progress.completed.length, 4);
  assert.equal(progress.earliestUnfinished, undefined);
  assert.equal(progress.pending.length, 0);
});

test("a criterion whose description does not parse into multiple lines is completely unaffected (preserves existing single-objective behaviour)", () => {
  const criteria: SuccessCriterion[] = [
    {
      id: "objective-destination-reached",
      type: "semantic_page_match",
      description: "Reach the completed configuration summary and stop.",
      required: true,
    },
  ];
  const progress = computeInstructionProgress(criteria, [], { "objective-destination-reached": 3 });
  assert.equal(progress.completed.length, 0);
  assert.equal(progress.earliestUnfinished?.ids[0], "objective-destination-reached");
  assert.equal(progress.earliestUnfinished?.descriptions[0], "Reach the completed configuration summary and stop.");
});

test("a grouped criterion's multiline description is never expanded (groups stay OR-alternatives, unaffected)", () => {
  const criteria: SuccessCriterion[] = [
    {
      id: "alt-a",
      type: "semantic_page_match",
      description: "1. Line one.\n2. Line two.",
      group: "either",
      required: true,
    },
    { id: "alt-b", type: "element_present", description: "Alt B.", group: "either", required: true },
  ];
  const progress = computeInstructionProgress(criteria, []);
  assert.equal(progress.earliestUnfinished?.ids.length, 2);
  assert.deepEqual(progress.earliestUnfinished?.ids, ["alt-a", "alt-b"]);
});

test("an optional (required: false) multiline criterion never participates in instruction ordering", () => {
  const progress = computeInstructionProgress(singleCriterion({ required: false }), []);
  assert.equal(progress.completed.length, 0);
  assert.equal(progress.earliestUnfinished, undefined);
  assert.equal(progress.terminal, undefined);
});
