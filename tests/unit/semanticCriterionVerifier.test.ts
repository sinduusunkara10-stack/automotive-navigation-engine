import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeSemanticCriterionVerifier,
  DEFAULT_SEMANTIC_MIN_CONFIDENCE,
  type SemanticVerificationInput,
} from "../../src/reasoning/semanticCriterionVerifier.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import { FakeReasoningModelClient, errorStep, resultStep } from "./fakes/fakeReasoningModelClient.js";

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

function buildInput(overrides: Partial<SemanticVerificationInput> = {}): SemanticVerificationInput {
  return {
    objective: "Reach the vehicle configurator.",
    criterionDescription: "Vehicle configuration controls are visible.",
    pageEvidence: { title: "Configurateur", headings: ["Configurez votre voiture"], interactiveText: ["Choisir"] },
    ...overrides,
  };
}

test("a satisfied, high-confidence verdict with evidence is accepted", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Configurateur / Choisir." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, true);
  assert.equal(outcome.confidence, 0.9);
  assert.equal(client.requests.length, 1);
  const diagnostics = verifier.getUsageDiagnostics();
  assert.equal(diagnostics.callCount, 1);
  assert.equal(diagnostics.satisfiedCount, 1);
  assert.equal(diagnostics.cacheHitCount, 0);
});

test("a not-satisfied verdict is rejected", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.95, evidence: "No matching evidence on this page." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(verifier.getUsageDiagnostics().rejectedCount, 1);
});

test("a satisfied verdict below the confidence gate is not accepted (never a single unsupported assertion)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: DEFAULT_SEMANTIC_MIN_CONFIDENCE - 0.01, evidence: "Weak match." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
});

test("a satisfied verdict with empty evidence is not accepted, even at high confidence", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.99, evidence: "" })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false, "an unsupported assertion (no cited evidence) must never satisfy the criterion");
});

test("an explicit minConfidence override is honoured", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.6, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client, minConfidence: 0.55 });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, true);
});

test("malformed (null) model output fails closed after retrying once, never satisfied", async () => {
  const client = new FakeReasoningModelClient([resultStep(null), resultStep(null)]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(client.requests.length, 2, "expected exactly one retry (2 attempts total), matching the hard-capped retry policy");
});

test("a provider error fails closed after retrying once, never satisfied", async () => {
  const client = new FakeReasoningModelClient([errorStep("timeout"), errorStep("timeout")]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(client.requests.length, 2);
});

test("identical (objective, criterion, page evidence) is cached: a second verify() call makes no new model call", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const input = buildInput();
  const first = await verifier.verify(input);
  const second = await verifier.verify({ ...input });

  assert.equal(client.requests.length, 1, "the second call must be served from cache, not a new model call");
  assert.deepEqual(second, first);
  const diagnostics = verifier.getUsageDiagnostics();
  assert.equal(diagnostics.callCount, 1);
  assert.equal(diagnostics.cacheHitCount, 1);
});

test("different page evidence for the same objective/criterion is verified independently (no cache collision)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "Unrelated page." }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Matching page." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const first = await verifier.verify(buildInput({ pageEvidence: { title: "Home", headings: [], interactiveText: [] } }));
  const second = await verifier.verify(
    buildInput({ pageEvidence: { title: "Configurateur", headings: ["Configurez"], interactiveText: ["Choisir"] } }),
  );

  assert.equal(first.satisfied, false);
  assert.equal(second.satisfied, true);
  assert.equal(client.requests.length, 2);
});

test("the prompt sent to the model never includes an action, URL, or selector vocabulary -- only objective/criterion/page-evidence text", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsedUser).sort(), ["criterionDescription", "objective", "pageEvidence"]);
});

// ---------------------------------------------------------------------------------------
// Widened evidence (ariaState/progressText on pageEvidence, optional lastActionEvidence):
// every field here is optional and additive -- the tests above (built via buildInput()'s
// defaults, which never set any of these) prove the payload shape is unchanged when they
// are absent. These prove they're included, verbatim, when present, and participate in the
// cache key so no two distinct pieces of evidence are ever conflated.
// ---------------------------------------------------------------------------------------

test("ariaState and progressText, when present on pageEvidence, are included in the prompt sent to the model", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({
      pageEvidence: {
        title: "Recapitulatif",
        headings: ["Configuration terminee"],
        interactiveText: ["Continuer"],
        ariaState: ["Continuer (aria-current=step)"],
        progressText: ["Step 4 of 4"],
      },
    }),
  );

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as { pageEvidence: Record<string, unknown> };
  assert.deepEqual(parsedUser.pageEvidence.ariaState, ["Continuer (aria-current=step)"]);
  assert.deepEqual(parsedUser.pageEvidence.progressIndicatorText, ["Step 4 of 4"]);
});

test("lastActionEvidence, when present, is included in the prompt sent to the model", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({ lastActionEvidence: { ctaText: "Continuer", accessibleName: "Continuer vers le recapitulatif", elementType: "button" } }),
  );

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as Record<string, unknown>;
  assert.deepEqual(parsedUser.lastActionEvidence, {
    ctaText: "Continuer",
    accessibleName: "Continuer vers le recapitulatif",
    elementType: "button",
  });
});

test("two calls with identical objective/criterion/pageEvidence but different lastActionEvidence are cached independently (no collision)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "Wrong control was clicked." }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Completion control was clicked." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const first = await verifier.verify(buildInput({ lastActionEvidence: { ctaText: "Voir les offres" } }));
  const second = await verifier.verify(buildInput({ lastActionEvidence: { ctaText: "Continuer" } }));

  assert.equal(first.satisfied, false);
  assert.equal(second.satisfied, true);
  assert.equal(client.requests.length, 2, "different lastActionEvidence must not be served from the same cache entry");
});
