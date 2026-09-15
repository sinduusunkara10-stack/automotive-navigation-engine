import { test } from "node:test";
import assert from "node:assert/strict";

import { isConsentIntentCompliant } from "../../src/safety/consentPolicyGuard.js";
import { validateDecision } from "../../src/safety/index.js";
import type { Safety, Limits, ConsentInteractionPolicy } from "../../src/types/task-request.js";
import type { ConsentControlIntent } from "../../src/types/consentControl.js";
import type { SelectedAction } from "../../src/types/actions.js";

// ---------------------------------------------------------------------------------------
// FIX (this incident): the safety layer's own, provider-agnostic backstop for
// ConsentInteractionPolicy (task-request.ts) -- independent of whatever the reasoning
// provider already checked (see validateClaudeDecision.test.ts for that Claude-specific,
// pre-dispatch layer). Enforced exactly like maxSteps/maxBacktracks/domain-allowlisting:
// a hard ceiling applied regardless of which provider produced the decision, per CLAUDE.md's
// non-negotiable design rule that the safety layer never depends on the reasoning layer
// having already done the right thing.
// ---------------------------------------------------------------------------------------

function baseSafety(overrides: Partial<Safety> = {}): Safety {
  return {
    allowedActions: ["click", "scroll", "wait", "stop_success", "stop_blocked", "stop_failure"],
    ...overrides,
  };
}

const LIMITS: Limits = { maxSteps: 10, maxBacktracks: 2 };

function decide(action: SelectedAction, safety: Safety, consentControlIntent?: ConsentControlIntent) {
  return validateDecision({
    action,
    safety,
    limits: LIMITS,
    allowedDomains: ["example-fictional-oem.test"],
    state: {
      limits: { stepCount: 1, backtrackCount: 0, startedAtMs: Date.now() },
      actionHistory: [],
      visitedUrls: ["https://example-fictional-oem.test/start.html"],
    },
    consentControlIntent,
  });
}

test("isConsentIntentCompliant: not_consent_related and opens_consent_settings are compliant under every policy", () => {
  const policies: ConsentInteractionPolicy[] = ["reject_optional", "accept_optional", "essential_only", "do_not_interact"];
  for (const policy of policies) {
    assert.equal(isConsentIntentCompliant(policy, "not_consent_related"), true, policy);
    assert.equal(isConsentIntentCompliant(policy, "opens_consent_settings"), true, policy);
  }
});

test("isConsentIntentCompliant: accept_optional accepts grants_optional_consent, rejects declines_optional_consent", () => {
  assert.equal(isConsentIntentCompliant("accept_optional", "grants_optional_consent"), true);
  assert.equal(isConsentIntentCompliant("accept_optional", "declines_optional_consent"), false);
});

test("isConsentIntentCompliant: reject_optional and essential_only accept declines_optional_consent, reject grants_optional_consent", () => {
  for (const policy of ["reject_optional", "essential_only"] as const) {
    assert.equal(isConsentIntentCompliant(policy, "declines_optional_consent"), true, policy);
    assert.equal(isConsentIntentCompliant(policy, "grants_optional_consent"), false, policy);
  }
});

test("isConsentIntentCompliant: do_not_interact rejects any consent-related intent", () => {
  assert.equal(isConsentIntentCompliant("do_not_interact", "grants_optional_consent"), false);
  assert.equal(isConsentIntentCompliant("do_not_interact", "declines_optional_consent"), false);
});

test("validateDecision: flags consent_policy_violation when a click grants optional consent under accept_optional's opposite (reject_optional)", () => {
  const result = decide(
    { type: "click", target: "el-1" },
    baseSafety({ consentInteractionPolicy: "reject_optional" }),
    "grants_optional_consent",
  );
  assert.equal(result.allowed, false);
  assert.ok(result.flags.includes("consent_policy_violation"));
});

test("validateDecision: allows a click that declines optional consent under reject_optional", () => {
  const result = decide(
    { type: "click", target: "el-1" },
    baseSafety({ consentInteractionPolicy: "reject_optional" }),
    "declines_optional_consent",
  );
  assert.equal(result.allowed, true);
  assert.deepEqual(result.flags, []);
});

test("validateDecision: flags consent_policy_violation when a click declines optional consent under accept_optional", () => {
  const result = decide(
    { type: "click", target: "el-1" },
    baseSafety({ consentInteractionPolicy: "accept_optional" }),
    "declines_optional_consent",
  );
  assert.equal(result.allowed, false);
  assert.ok(result.flags.includes("consent_policy_violation"));
});

test("validateDecision: a provider that never reports consentControlIntent is treated as not_consent_related, never a silent bypass", () => {
  // do_not_interact rejects every consent-related intent but is compliant for
  // "not_consent_related" -- proving the missing-field default is genuinely safe (it does
  // not accidentally make everything pass) rather than merely convenient.
  const compliant = decide({ type: "click", target: "el-1" }, baseSafety({ consentInteractionPolicy: "do_not_interact" }));
  assert.equal(compliant.allowed, true);

  const stillEnforced = decide(
    { type: "click", target: "el-1" },
    baseSafety({ consentInteractionPolicy: "do_not_interact" }),
    "grants_optional_consent",
  );
  assert.equal(stillEnforced.allowed, false);
});

test("validateDecision: an omitted consentInteractionPolicy follows the documented default (reject_optional)", () => {
  const result = decide({ type: "click", target: "el-1" }, baseSafety(), "grants_optional_consent");
  assert.equal(result.allowed, false);
  assert.ok(result.flags.includes("consent_policy_violation"));
});

test("validateDecision: non-consent actions are never affected by any consentInteractionPolicy", () => {
  for (const policy of ["reject_optional", "accept_optional", "essential_only", "do_not_interact"] as const) {
    const result = decide(
      { type: "scroll" },
      baseSafety({ consentInteractionPolicy: policy }),
      "not_consent_related",
    );
    assert.equal(result.allowed, true, policy);
    assert.deepEqual(result.flags, [], policy);
  }
});

test("validateDecision: allowPaymentOrPurchase/allowPersonalDataEntry/allowFormSubmission are unaffected by consent enforcement", () => {
  const safety = baseSafety({
    consentInteractionPolicy: "reject_optional",
    allowFormSubmission: false,
    allowPaymentOrPurchase: false,
    allowPersonalDataEntry: false,
  });
  const result = decide({ type: "click", target: "el-1" }, safety, "declines_optional_consent");
  assert.equal(result.allowed, true);
  assert.equal(safety.allowFormSubmission, false);
  assert.equal(safety.allowPaymentOrPurchase, false);
  assert.equal(safety.allowPersonalDataEntry, false);
});

test("validateDecision: existing safety checks (action_not_allowed, domain_blocked) remain green alongside the new consent check", () => {
  const notAllowed = decide(
    { type: "navigate", target: "https://example-fictional-oem.test/offers.html" },
    baseSafety({ allowedActions: ["stop_failure"] }),
    "not_consent_related",
  );
  assert.equal(notAllowed.allowed, false);
  assert.ok(notAllowed.flags.includes("action_not_allowed"));

  const domainBlocked = decide(
    { type: "navigate", target: "https://not-allowed.test/x" },
    baseSafety({ allowedActions: ["navigate"] }),
    "not_consent_related",
  );
  assert.equal(domainBlocked.allowed, false);
  assert.ok(domainBlocked.flags.includes("domain_blocked"));
});
