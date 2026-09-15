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
    consentControlIntent: "not_consent_related",
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
// FIX (this incident): consentControlIntent (types/consentControl.ts) is now checked
// deterministically against context.consentInteractionPolicy via
// src/safety/consentPolicyGuard.ts's isConsentIntentCompliant -- see CLAUDE.md and
// tests/unit/claudeReasoningProvider.test.ts for the end-to-end corrective-retry behaviour
// built on top of this rejection.
// ---------------------------------------------------------------------------------------

test("accepts a click whose consentControlIntent is not_consent_related under every policy", () => {
  for (const policy of ["reject_optional", "accept_optional", "essential_only", "do_not_interact"] as const) {
    const context = buildTestReasoningContext({ consentInteractionPolicy: policy });
    const result = validateClaudeDecision(basePayload({ consentControlIntent: "not_consent_related" }), context, MIN_CONFIDENCE);
    assert.equal(result.valid, true, `expected "not_consent_related" to be compliant under policy "${policy}"`);
  }
});

test("rejects a decision that grants optional consent when consentInteractionPolicy is reject_optional or essential_only", () => {
  for (const policy of ["reject_optional", "essential_only"] as const) {
    const context = buildTestReasoningContext({ consentInteractionPolicy: policy });
    const result = validateClaudeDecision(basePayload({ consentControlIntent: "grants_optional_consent" }), context, MIN_CONFIDENCE);
    assert.equal(result.valid, false, `expected a policy violation under "${policy}"`);
    if (!result.valid) {
      assert.equal(result.reason, "consent_policy_violation");
    }
  }
});

test("accepts a decision that declines optional consent when consentInteractionPolicy is reject_optional or essential_only", () => {
  for (const policy of ["reject_optional", "essential_only"] as const) {
    const context = buildTestReasoningContext({ consentInteractionPolicy: policy });
    const result = validateClaudeDecision(basePayload({ consentControlIntent: "declines_optional_consent" }), context, MIN_CONFIDENCE);
    assert.equal(result.valid, true, `expected compliance under "${policy}"`);
  }
});

test("rejects a decision that declines optional consent when consentInteractionPolicy is accept_optional", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "accept_optional" });
  const result = validateClaudeDecision(basePayload({ consentControlIntent: "declines_optional_consent" }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "consent_policy_violation");
  }
});

test("accepts a decision that grants optional consent when consentInteractionPolicy is accept_optional", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "accept_optional" });
  const result = validateClaudeDecision(basePayload({ consentControlIntent: "grants_optional_consent" }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, true);
});

test("rejects any consent-related consentControlIntent when consentInteractionPolicy is do_not_interact", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "do_not_interact" });
  for (const intent of ["grants_optional_consent", "declines_optional_consent"] as const) {
    const result = validateClaudeDecision(basePayload({ consentControlIntent: intent }), context, MIN_CONFIDENCE);
    assert.equal(result.valid, false, `expected "${intent}" to violate do_not_interact`);
    if (!result.valid) {
      assert.equal(result.reason, "consent_policy_violation");
    }
  }
});

test("opens_consent_settings is compliant under every policy (never the deterministic violation this guard enforces)", () => {
  for (const policy of ["reject_optional", "accept_optional", "essential_only", "do_not_interact"] as const) {
    const context = buildTestReasoningContext({ consentInteractionPolicy: policy });
    const result = validateClaudeDecision(basePayload({ consentControlIntent: "opens_consent_settings" }), context, MIN_CONFIDENCE);
    assert.equal(result.valid, true, `expected "opens_consent_settings" to be compliant under policy "${policy}"`);
  }
});

test("missing consentInteractionPolicy on the context follows the documented default (reject_optional): grants_optional_consent is rejected", () => {
  const context = buildTestReasoningContext();
  assert.equal(context.consentInteractionPolicy, "reject_optional");
  const result = validateClaudeDecision(basePayload({ consentControlIntent: "grants_optional_consent" }), context, MIN_CONFIDENCE);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.reason, "consent_policy_violation");
  }
});
