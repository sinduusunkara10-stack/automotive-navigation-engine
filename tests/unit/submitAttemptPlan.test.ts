import { test } from "node:test";
import assert from "node:assert/strict";

import { classifySubmitAttempt, evaluateFallbackEligibility, type SubmitAttemptEvidence } from "../../src/actions/submitAttemptPlan.js";
import type { PostSubmitObservation } from "../../src/actions/submissionObserver.js";
import { assessSelection } from "../../src/forms/consentGroups.js";

function observation(overrides: Partial<PostSubmitObservation> = {}): PostSubmitObservation {
  return {
    minimumObservationMs: 50_000,
    pollIntervalMs: 500,
    baseWindowMs: 50_000,
    extensionMs: 10_000,
    hardCapMs: 75_000,
    extensionCount: 0,
    extensionReasons: [],
    totalObservationMs: 75_100,
    businessRequestDetected: false,
    businessRequestCount: 0,
    businessRequest: null,
    businessRequestStartedAtMs: null,
    businessRequestFinishedAtMs: null,
    excludedTrackingOrThirdPartyRequestCount: 3,
    confirmationDetectedAtMs: null,
    successSignals: [],
    formStillPresentAtEnd: true,
    finalProgressReasons: [],
    submitControlDisabledAtEnd: false,
    terminalState: "unknown_outcome",
    terminalReason: "",
    ...overrides,
  };
}

function attempt(obs: PostSubmitObservation, overrides: Partial<SubmitAttemptEvidence> = {}): SubmitAttemptEvidence {
  return {
    succeeded: false,
    submitBlockedBeforeClick: false,
    confirmationAppeared: false,
    observation: obs,
    networkRequests: [],
    postSubmit: { validationCauseObserved: false, postSubmitValidationMessages: [] },
    ...overrides,
  };
}

function eligibility(first: SubmitAttemptEvidence, extra: Partial<Parameters<typeof evaluateFallbackEligibility>[0]> = {}) {
  return evaluateFallbackEligibility({
    firstAttempt: first,
    firstAttemptOutcome: classifySubmitAttempt(first, false),
    challengeVisibleNow: false,
    formVisibleNow: true,
    submitEnabledNow: true,
    optionalConsentGroupPresent: true,
    fallbackFlagEnabled: true,
    submitAttemptsSoFar: 1,
    correctiveRetriesAfterSubmit: 0,
    ...extra,
  });
}

const BUSINESS = { method: "POST", endpointPattern: "https://www.example-automotive-oem.com/api/lead", resourceType: "fetch", startedAtMs: 120, classificationReason: "same_site_state_changing_request" };

test("submit plan: a silent first attempt with no business request is eligible only with the flag", () => {
  const first = attempt(observation());
  assert.equal(classifySubmitAttempt(first, false), "cancelled_before_business_request");
  assert.equal(classifySubmitAttempt(first, true), "consent_state_not_committed");
  assert.equal(eligibility(first).eligible, true);
  const off = eligibility(first, { fallbackFlagEnabled: false });
  assert.equal(off.eligible, false);
  assert.equal(off.checks.fallbackFlagEnabled, false);
});

test("submit plan 8: a sent business request with an unknown, pending or accepted outcome is never resubmitted", () => {
  for (const businessRequest of [
    { ...BUSINESS, status: null, outcome: "pending" as const, durationMs: null },
    { ...BUSINESS, status: 200, outcome: "completed" as const, durationMs: 300 },
    { ...BUSINESS, status: null, outcome: "failed" as const, durationMs: 300 },
  ]) {
    const first = attempt(observation({ businessRequestDetected: true, businessRequestCount: 1, businessRequest }));
    const { eligible, checks } = eligibility(first);
    assert.equal(eligible, false, businessRequest.outcome);
    assert.equal(checks.noBusinessRequestStarted, false);
    assert.equal(checks.firstAttemptClassificationEligible, false);
  }
});

test("submit plan 14: once two Submit clicks happened, or a corrective retry ran, no further Submit is allowed", () => {
  const first = attempt(observation());
  assert.equal(eligibility(first, { submitAttemptsSoFar: 2 }).checks.noPreviousRetry, false);
  assert.equal(eligibility(first, { correctiveRetriesAfterSubmit: 1 }).checks.noPreviousRetry, false);
});

test("submit plan 16: a duplicate, rate-limit or anti-bot status, a challenge on the page, or progress still emerging prevents the retry", () => {
  for (const status of [409, 429, 403]) {
    const first = attempt(observation(), {
      networkRequests: [{ method: "GET", endpointPattern: "https://www.example-automotive-oem.com/session", resourceType: "fetch", purpose: "unknown", status, outcome: "completed", startedAtMs: 10, durationMs: 20 } as never],
    });
    assert.equal(eligibility(first).checks.noChallengeDuplicateOrRateLimit, false, String(status));
  }
  assert.equal(eligibility(attempt(observation()), { challengeVisibleNow: true }).eligible, false);
  assert.equal(eligibility(attempt(observation({ terminalState: "blocked_or_challenged" }))).eligible, false);
  assert.equal(eligibility(attempt(observation({ finalProgressReasons: ["loading_indicator_active"] }))).checks.noDelayedSuccessEmerging, false);
  assert.equal(eligibility(attempt(observation({ submitControlDisabledAtEnd: true }))).checks.formPresentAndUsable, false);
  assert.equal(eligibility(attempt(observation({ formStillPresentAtEnd: false }))).checks.formPresentAndUsable, false);
  assert.equal(eligibility(attempt(observation({ totalObservationMs: 20_105 }))).checks.observedAtLeastMinimum, false, "the live run's 20.105 s window is too short");
  assert.equal(eligibility(attempt(observation(), { postSubmit: { validationCauseObserved: true, postSubmitValidationMessages: [] } })).checks.noValidationOrRejection, false);
});

const NO_SIGNALS = {
  nativeChecked: false,
  selectedValueMatches: false,
  groupSelectedOther: false,
  checkedAttribute: false,
  aria: false,
  ariaFalse: false,
  ariaExposed: false,
  selectedClass: false,
  framework: false,
  frameworkExposed: false,
  otherAria: false,
  otherSelectedClass: false,
  otherFramework: false,
  hiddenCount: 0,
  hiddenHash: 0,
};

test("assessSelection: native or component state verifies a decline; another selected option contradicts it; click evidence alone never verifies", () => {
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true, selectedValueMatches: true }, false).result, "verified");
  assert.deepEqual(assessSelection({ ...NO_SIGNALS, aria: true, ariaExposed: true }, false), { result: "verified", methods: ["aria_checked"] });
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true, groupSelectedOther: true }, false).result, "contradicted");
  assert.equal(assessSelection({ ...NO_SIGNALS, selectedClass: true, otherAria: true }, false).result, "contradicted");
  assert.equal(assessSelection(NO_SIGNALS, false).result, "not_committed");
  assert.equal(assessSelection(null, false).result, "not_committed");
});

test("assessSelection strict (test-only accept): native state is required, plus every component state the widget exposes", () => {
  assert.equal(assessSelection({ ...NO_SIGNALS, aria: true, ariaExposed: true }, true).result, "not_committed");
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true, ariaExposed: true }, true).result, "not_committed");
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true, aria: true, ariaExposed: true }, true).result, "verified");
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true, frameworkExposed: true }, true).result, "not_committed");
  assert.equal(assessSelection({ ...NO_SIGNALS, nativeChecked: true }, true).result, "verified");
});
