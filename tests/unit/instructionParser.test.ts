import { test } from "node:test";
import assert from "node:assert/strict";

import { parseOrderedInstructions } from "../../src/reasoning/instructionParser.js";

// The real n8n request shape (see task requirement): a single semantic_page_match
// successCriterion whose description is the caller's complete multiline ordered objective,
// rather than one successCriterion per instruction. These tests exercise the generic parser
// standalone -- see tests/unit/promptBuilder.test.ts and
// tests/integration/singleCriterionOrderedObjective.test.ts for how it feeds
// computeInstructionProgress and a full run end-to-end.

test("parses numbered lines (\"1.\") into ordered segments, trimming markers and whitespace", () => {
  const text = "1. Select the specified item.\n2. Activate the progression action.\n3. Stop and return the resulting URL.";
  assert.deepEqual(parseOrderedInstructions(text), [
    "Select the specified item.",
    "Activate the progression action.",
    "Stop and return the resulting URL.",
  ]);
});

test("parses \"1)\" numbering", () => {
  const text = "1) Select the item.\n2) Continue.\n3) Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("parses \"(1)\" numbering", () => {
  const text = "(1) Select the item.\n(2) Continue.\n(3) Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("parses \"-\" bullet markers", () => {
  const text = "- Select the item.\n- Continue.\n- Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("parses \"*\" bullet markers", () => {
  const text = "* Select the item.\n* Continue.\n* Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("parses \"•\" bullet markers", () => {
  const text = "• Select the item.\n• Continue.\n• Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("parses plain line-separated instructions with no marker at all", () => {
  const text = "Select the item.\nContinue.\nStop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("drops blank lines between instructions", () => {
  const text = "1. Select the item.\n\n\n2. Continue.\n\n3. Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("handles CRLF line endings identically to LF", () => {
  const text = "1. Select the item.\r\n2. Continue.\r\n3. Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("handles a lone trailing CR (old Mac style) identically", () => {
  const text = "1. Select the item.\r2. Continue.\r3. Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});

test("a single prose paragraph with no explicit line structure yields no segments (preserves single-objective behaviour)", () => {
  const text =
    "Navigate to the configurator, proceed through the steps, and stop once the completed configuration summary has been reached.";
  assert.deepEqual(parseOrderedInstructions(text), []);
});

test("a single line -- even one that only leading-trims to itself -- yields no segments", () => {
  assert.deepEqual(parseOrderedInstructions("1. Just one instruction, nothing else."), []);
});

test("never infers steps from prose: sentences within one unstructured paragraph are not split on periods", () => {
  const text = "Select the item. Then continue. Then stop.";
  assert.deepEqual(parseOrderedInstructions(text), []);
});

test("blank/whitespace-only text yields no segments", () => {
  assert.deepEqual(parseOrderedInstructions(""), []);
  assert.deepEqual(parseOrderedInstructions("   \n\n  \n"), []);
});

test("only strips a marker from the very start of a line, never from its interior", () => {
  const text = "1. Pick option 1 or 2.\n2. Pick option 3 - not 4.";
  assert.deepEqual(parseOrderedInstructions(text), ["Pick option 1 or 2.", "Pick option 3 - not 4."]);
});

test("mixed numbering/bullet styles across lines all parse correctly together", () => {
  const text = "1. Select the item.\n- Continue.\n(3) Stop.";
  assert.deepEqual(parseOrderedInstructions(text), ["Select the item.", "Continue.", "Stop."]);
});
