import { test } from "node:test";
import assert from "node:assert/strict";

import { validateClaudeDecision } from "../../src/reasoning/validateClaudeDecision.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { buildTestReasoningContext } from "./helpers/reasoningContext.js";

const MIN_CONFIDENCE = 0.5;

function basePayload(overrides: Partial<ClaudeDecisionPayload> = {}): ClaudeDecisionPayload {
  return {
    action: "click",
    targetElementId: "el-0",
    reason: "The visible Continue control moves toward the objective.",
    confidence: 0.9,
    ...overrides,
  };
}

test("accepts a valid click decision targeting a known element", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload(), context, MIN_CONFIDENCE);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.action, { type: "click", target: "el-0" });
    assert.equal(result.confidence, 0.9);
  }
});

test("rejects an action outside this run's allowedActions", () => {
  const context = buildTestReasoningContext({ allowedActions: ["stop_failure"] });
  const result = validateClaudeDecision(basePayload({ action: "click" }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "action_not_allowed");
  }
});

test("rejects a click with no targetElementId", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload({ targetElementId: undefined }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "missing_target_element_id");
  }
});

test("rejects a click targeting an element id that was never observed", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload({ targetElementId: "el-does-not-exist" }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "unknown_target_element_id");
  }
});

test("rejects a confidence below the configured minimum", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload({ confidence: 0.1 }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "low_confidence");
  }
});

test("rejects navigate to a host outside allowedDomains", () => {
  const context = buildTestReasoningContext({ allowedActions: ["navigate", "stop_failure"] });
  const result = validateClaudeDecision(
    basePayload({ action: "navigate", targetElementId: undefined, navigateUrl: "https://not-allowed.test/x" }),
    context,
    MIN_CONFIDENCE,
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "navigate_not_allowed");
  }
});

test("accepts navigate to a host within allowedDomains", () => {
  const context = buildTestReasoningContext({ allowedActions: ["navigate", "stop_failure"] });
  const result = validateClaudeDecision(
    basePayload({
      action: "navigate",
      targetElementId: undefined,
      navigateUrl: "https://example-fictional-oem.test/offers.html",
    }),
    context,
    MIN_CONFIDENCE,
  );
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.action, { type: "navigate", target: "https://example-fictional-oem.test/offers.html" });
  }
});

test("accepts stop_success with no target required", () => {
  const context = buildTestReasoningContext({ allowedActions: ["stop_success"] });
  const result = validateClaudeDecision(
    basePayload({ action: "stop_success", targetElementId: undefined }),
    context,
    MIN_CONFIDENCE,
  );
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.deepEqual(result.action, { type: "stop_success" });
  }
});

// ---------------------------------------------------------------------------------------
// FIX (ordered-instruction execution / low-confidence corrective retry, PART 2): confidence
// is now checked *last*, after action/target/navigate validity -- so "low_confidence" as a
// rejection reason means the decision was genuinely structurally valid and only its stated
// confidence fell short, which claudeReasoningProvider.ts's bounded corrective retry relies
// on before re-asking for a corrected choice.
// ---------------------------------------------------------------------------------------

test("FIX: an unknown target element id is reported over low confidence when both problems are present -- low_confidence must never mask a genuine structural problem", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload({ targetElementId: "el-does-not-exist", confidence: 0.05 }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "unknown_target_element_id");
  }
});

test("FIX: a disallowed action is reported over low confidence when both problems are present", () => {
  const context = buildTestReasoningContext({ allowedActions: ["stop_failure"] });
  const result = validateClaudeDecision(basePayload({ action: "click", confidence: 0.05 }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "action_not_allowed");
  }
});

test("FIX: a disallowed navigate host is reported over low confidence when both problems are present", () => {
  const context = buildTestReasoningContext({ allowedActions: ["navigate", "stop_failure"] });
  const result = validateClaudeDecision(
    basePayload({ action: "navigate", targetElementId: undefined, navigateUrl: "https://not-allowed.test/x", confidence: 0.05 }),
    context,
    MIN_CONFIDENCE,
  );
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "navigate_not_allowed");
  }
});

test("FIX: low_confidence is reported only once every other structural check has already passed", () => {
  const context = buildTestReasoningContext();
  const result = validateClaudeDecision(basePayload({ confidence: 0.05 }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "low_confidence");
  }
});
