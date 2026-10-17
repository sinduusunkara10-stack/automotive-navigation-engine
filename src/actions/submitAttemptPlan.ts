import type { OptionalConsentOptInGroup } from "../forms/consentGroups.js";
import type { SanitizedNetworkRequestEvidence } from "./dealerLookupNetwork.js";
import type { PostSubmitObservation } from "./submissionObserver.js";

/** Never more than two Submit clicks per fill_form, whichever path asks for the second one. */
export const MAX_SUBMIT_ATTEMPTS = 2;

export type SubmitAttemptOutcome =
  | "succeeded"
  | "submit_blocked_before_click"
  | "validation_failed"
  | "server_rejected"
  | "server_error"
  | "blocked_or_challenged"
  | "business_request_pending"
  | "business_request_accepted_unconfirmed"
  | "business_request_outcome_unknown"
  | "cancelled_before_business_request"
  | "consent_state_not_committed";

export interface SubmitAttemptEvidence {
  succeeded: boolean;
  submitBlockedBeforeClick: boolean;
  confirmationAppeared: boolean;
  observation: PostSubmitObservation | null;
  networkRequests: SanitizedNetworkRequestEvidence[];
  postSubmit: { validationCauseObserved: boolean; postSubmitValidationMessages: string[] };
}

function acceptedStatus(status: number | null | undefined): boolean {
  return status !== null && status !== undefined && status >= 100 && status < 400;
}

/**
 * One attempt's outcome. An attempt counts as never having reached the business-submission stage
 * only when no business request was observed at all; a request that was sent, whatever happened
 * to it, is classified by its own state.
 */
export function classifySubmitAttempt(attempt: SubmitAttemptEvidence, optionalDeclineNotCommitted: boolean): SubmitAttemptOutcome {
  if (attempt.succeeded) return "succeeded";
  if (attempt.submitBlockedBeforeClick || attempt.observation === null) return "submit_blocked_before_click";
  const o = attempt.observation;
  if (o.terminalState === "blocked_or_challenged") return "blocked_or_challenged";
  if (o.terminalState === "server_rejected") return "server_rejected";
  if (o.terminalState === "server_error") return "server_error";
  if (o.terminalState === "validation_failed" || attempt.postSubmit.validationCauseObserved) return "validation_failed";
  if (o.businessRequestDetected) {
    if (o.businessRequest?.outcome === "pending") return "business_request_pending";
    if (acceptedStatus(o.businessRequest?.status)) return "business_request_accepted_unconfirmed";
    return "business_request_outcome_unknown";
  }
  return optionalDeclineNotCommitted ? "consent_state_not_committed" : "cancelled_before_business_request";
}

export interface FallbackEligibilityChecks {
  observedAtLeastMinimum: boolean;
  noConfirmation: boolean;
  noBusinessRequestStarted: boolean;
  noBusinessRequestPending: boolean;
  noBusinessAcceptance: boolean;
  noDelayedSuccessEmerging: boolean;
  noValidationOrRejection: boolean;
  noChallengeDuplicateOrRateLimit: boolean;
  formPresentAndUsable: boolean;
  firstAttemptClassificationEligible: boolean;
  optionalConsentGroupPresent: boolean;
  fallbackFlagEnabled: boolean;
  noPreviousRetry: boolean;
}

const DUPLICATE_OR_RATE_LIMIT_STATUSES = new Set([403, 409, 429]);

/**
 * Every guard for the test-only opt-in second Submit. Each is evaluated on its own so the response
 * shows exactly which one held the retry back; eligibility needs every one of them.
 */
export function evaluateFallbackEligibility(input: {
  firstAttempt: SubmitAttemptEvidence;
  firstAttemptOutcome: SubmitAttemptOutcome;
  challengeVisibleNow: boolean;
  formVisibleNow: boolean;
  submitEnabledNow: boolean;
  optionalConsentGroupPresent: boolean;
  fallbackFlagEnabled: boolean;
  submitAttemptsSoFar: number;
  correctiveRetriesAfterSubmit: number;
}): { checks: FallbackEligibilityChecks; eligible: boolean } {
  const { firstAttempt } = input;
  const o = firstAttempt.observation;
  const checks: FallbackEligibilityChecks = {
    observedAtLeastMinimum: o !== null && o.totalObservationMs >= o.minimumObservationMs,
    noConfirmation: !firstAttempt.succeeded && !firstAttempt.confirmationAppeared && (o?.successSignals.length ?? 0) === 0,
    noBusinessRequestStarted: o !== null && !o.businessRequestDetected,
    noBusinessRequestPending: o !== null && o.businessRequest?.outcome !== "pending",
    noBusinessAcceptance: o !== null && !acceptedStatus(o.businessRequest?.status),
    noDelayedSuccessEmerging: o !== null && o.terminalState === "unknown_outcome" && o.finalProgressReasons.length === 0,
    noValidationOrRejection:
      o !== null &&
      !["validation_failed", "server_rejected", "server_error"].includes(o.terminalState) &&
      !firstAttempt.postSubmit.validationCauseObserved &&
      firstAttempt.postSubmit.postSubmitValidationMessages.length === 0,
    noChallengeDuplicateOrRateLimit:
      o !== null &&
      o.terminalState !== "blocked_or_challenged" &&
      !input.challengeVisibleNow &&
      !firstAttempt.networkRequests.some((r) => r.purpose !== "unrelated_tracking" && r.status !== null && DUPLICATE_OR_RATE_LIMIT_STATUSES.has(r.status)),
    formPresentAndUsable: o !== null && o.formStillPresentAtEnd && !o.submitControlDisabledAtEnd && input.formVisibleNow && input.submitEnabledNow,
    firstAttemptClassificationEligible: input.firstAttemptOutcome === "cancelled_before_business_request" || input.firstAttemptOutcome === "consent_state_not_committed",
    optionalConsentGroupPresent: input.optionalConsentGroupPresent,
    fallbackFlagEnabled: input.fallbackFlagEnabled,
    noPreviousRetry: input.submitAttemptsSoFar === 1 && input.correctiveRetriesAfterSubmit === 0 && input.submitAttemptsSoFar < MAX_SUBMIT_ATTEMPTS,
  };
  return { checks, eligible: Object.values(checks).every(Boolean) };
}

export interface SubmitAttemptSummary {
  firstAttemptConsentMode: "decline" | "no_optional_consent_groups";
  /** False when at least one optional decline never read back as selected (consent_decline_not_committed). */
  firstAttemptConsentCommitted: boolean;
  firstAttemptObservationMs: number | null;
  firstAttemptBusinessRequestDetected: boolean;
  firstAttemptOutcome: SubmitAttemptOutcome;
  fallbackFlagEnabled: boolean;
  /** Null when the first attempt succeeded, so no second attempt was ever considered. */
  fallbackEligibilityChecks: FallbackEligibilityChecks | null;
  fallbackEligible: boolean;
  fallbackUsed: boolean;
  fallbackOutcomeTag: "test_only_optional_consent_fallback" | null;
  fallbackDecision: string;
  fallbackConsentGroups: OptionalConsentOptInGroup[];
  secondAttemptConsentMode: "opt_in_test_only" | null;
  secondAttemptObservationMs: number | null;
  secondAttemptBusinessRequestDetected: boolean | null;
  secondAttemptOutcome: SubmitAttemptOutcome | null;
  /** From the attempt that produced the final outcome; ms after that attempt's Submit click. */
  confirmationDetectedAtMs: number | null;
  totalSubmitAttempts: number;
  /** The first attempt's own observation, kept only when a second attempt replaced it as postSubmitObservation. */
  firstAttemptObservation: PostSubmitObservation | null;
}

export function submitNeverAttemptedSummary(fallbackFlagEnabled: boolean, optionalGroupsPresent: boolean, consentCommitted: boolean): SubmitAttemptSummary {
  return {
    firstAttemptConsentMode: optionalGroupsPresent ? "decline" : "no_optional_consent_groups",
    firstAttemptConsentCommitted: consentCommitted,
    firstAttemptObservationMs: null,
    firstAttemptBusinessRequestDetected: false,
    firstAttemptOutcome: "submit_blocked_before_click",
    fallbackFlagEnabled,
    fallbackEligibilityChecks: null,
    fallbackEligible: false,
    fallbackUsed: false,
    fallbackOutcomeTag: null,
    fallbackDecision: "not considered: the pre-submit readiness gate failed, so Submit was never clicked",
    fallbackConsentGroups: [],
    secondAttemptConsentMode: null,
    secondAttemptObservationMs: null,
    secondAttemptBusinessRequestDetected: null,
    secondAttemptOutcome: null,
    confirmationDetectedAtMs: null,
    totalSubmitAttempts: 0,
    firstAttemptObservation: null,
  };
}
