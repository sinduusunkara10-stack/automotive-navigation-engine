import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveVerifiedFormSubmission } from "../../src/core/verifiedSubmission.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import { ClaudeSemanticCriterionVerifier, type SemanticVerificationInput } from "../../src/reasoning/semanticCriterionVerifier.js";
import type { ActionResult, PostSubmitObservationWire } from "../../src/types/task-response.js";
import { FakeReasoningModelClient, resultStep } from "./fakes/fakeReasoningModelClient.js";

// Shaped on the live 2026-10-30 fill_form result: 6/6 required fields, readiness passed, one Submit,
// an on-screen confirmation at 1537 ms, the form gone, and no business request the observer could
// attribute (the lead POST went to a cross-site form service and was excluded as third-party).

type Overrides = {
  result?: Partial<ActionResult>;
  post?: Record<string, unknown>;
  observation?: Partial<PostSubmitObservationWire>;
  discovery?: Record<string, unknown>;
};

function liveShapedResult(overrides: Overrides = {}): ActionResult {
  const observation = {
    terminalState: "succeeded",
    successSignals: ["confirmation_message"],
    formStillPresentAtEnd: false,
    businessRequestDetected: false,
    confirmationDetectedAtMs: 1537,
    ...overrides.observation,
  };
  return {
    success: true,
    formFillOutcome: "submitted",
    formSuccessDetection: "on_screen_message",
    formDiscoveryDiagnostics: { requiredFieldsDetected: 6, requiredFieldsFilled: 6, unmappedRequiredFieldIds: [], ...overrides.discovery },
    formPostSubmitDiagnostics: {
      submissionOutcome: "succeeded",
      preSubmitReadinessPassed: true,
      submitAttempted: true,
      submitAttemptSummary: { totalSubmitAttempts: 1 },
      postSubmitObservation: observation,
      ...overrides.post,
    },
    ...overrides.result,
  } as unknown as ActionResult;
}

test("the live run's fill_form result is a verified submission, without inventing a business request", () => {
  const verified = deriveVerifiedFormSubmission(liveShapedResult(), 0);
  assert.deepEqual(verified, {
    stepIndex: 0,
    requiredFieldsDetected: 6,
    requiredFieldsFilled: 6,
    preSubmitReadinessPassed: true,
    submitAttempts: 1,
    confirmationSignals: ["confirmation_message"],
    formStillPresentAfterSubmit: false,
    businessRequestObserved: false,
    analyticsCorroboration: false,
  });
});

test("a URL change after Submit counts as observed completion evidence", () => {
  const verified = deriveVerifiedFormSubmission(
    liveShapedResult({ result: { formSuccessDetection: "url_change" }, observation: { successSignals: ["url_change"] } }),
    2,
  );
  assert.deepEqual(verified?.confirmationSignals, ["url_change"]);
});

test("analytics only corroborates: a virtual-page success event alone is never a verified submission", () => {
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ observation: { successSignals: ["virtual_page_success_event"] } }), 0), undefined);
  const both = deriveVerifiedFormSubmission(liveShapedResult({ observation: { successSignals: ["virtual_page_success_event", "confirmation_message"] } }), 0);
  assert.deepEqual(both?.confirmationSignals, ["confirmation_message"]);
  assert.equal(both?.analyticsCorroboration, true);
});

test("a Submit click alone, a click action, or a non-fill_form result is never a verified submission", () => {
  assert.equal(deriveVerifiedFormSubmission({ success: true, verifiedSuccessType: "dialog_appeared" } as unknown as ActionResult, 1), undefined);
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ observation: { successSignals: [] } }), 0), undefined);
});

test("validation failure, ambiguous or unconfirmed outcomes are never verified submissions", () => {
  for (const submissionOutcome of ["validation_failed", "unconfirmed", "cancelled_unknown_cause", "cancelled_before_request", "server_rejected"]) {
    assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ post: { submissionOutcome } }), 0), undefined, submissionOutcome);
  }
  assert.equal(
    deriveVerifiedFormSubmission(liveShapedResult({ result: { success: false, formFillOutcome: "form_validation_failed" } }), 0),
    undefined,
  );
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ observation: { terminalState: "unknown_outcome" } }), 0), undefined);
});

test("incomplete filling or failed readiness is never a verified submission", () => {
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ discovery: { requiredFieldsFilled: 5 } }), 0), undefined);
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ discovery: { unmappedRequiredFieldIds: ["7"] } }), 0), undefined);
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ discovery: { requiredFieldsDetected: 0, requiredFieldsFilled: 0 } }), 0), undefined);
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ post: { preSubmitReadinessPassed: false } }), 0), undefined);
  assert.equal(deriveVerifiedFormSubmission(liveShapedResult({ post: { postSubmitObservation: null } }), 0), undefined);
});

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "test-model",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 0,
  minConfidence: 0.5,
};

function input(overrides: Partial<SemanticVerificationInput> = {}): SemanticVerificationInput {
  return {
    objective: "1. load the above starturl\n2. fill out the details of the form\n3. submit the form\n4. stop and return",
    criterionDescription: "submit the form",
    pageEvidence: { title: "Demande d'essai", headings: [], interactiveText: ["menu"] },
    ...overrides,
  };
}

test("the verifier forwards the verified submission as structured evidence, states its rules, and keys its cache on it", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "only a menu" }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "verifiedFormSubmission confirmation_message" }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });
  const verified = deriveVerifiedFormSubmission(liveShapedResult(), 0);
  assert.ok(verified);

  const without = await verifier.verify(input());
  assert.equal(without.satisfied, false);
  assert.equal(JSON.parse(client.requests[0]?.userPrompt ?? "{}").verifiedFormSubmission, undefined);

  const withSubmission = await verifier.verify(input({ verifiedFormSubmission: verified }));
  assert.equal(withSubmission.satisfied, true, "a different cache key: the earlier refusal is not replayed");
  assert.equal(client.requests.length, 2);
  assert.deepEqual(JSON.parse(client.requests[1]?.userPrompt ?? "{}").verifiedFormSubmission, verified);

  const system = client.requests[1]?.system ?? "";
  assert.match(system, /verifiedFormSubmission/);
  assert.match(system, /Analytics and tracking events are never part of it/);
  assert.match(system, /never satisfies any other criterion/);
});
