import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeSurfaceRelevanceAmbiguityResolver } from "../../src/reasoning/claudeSurfaceRelevanceAmbiguityResolver.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import type { SurfaceRelevanceAmbiguityContext } from "../../src/core/surfaceRelevance.js";
import { FakeReasoningModelClient, errorStep, resultStep } from "./fakes/fakeReasoningModelClient.js";

/**
 * Three-tier surface-adoption corrective work (Tier 3): unit coverage for the real,
 * Claude-backed SurfaceRelevanceAmbiguityResolver -- mirrors
 * tests/unit/semanticCriterionVerifier.test.ts's own fake-model-client pattern. This is what
 * finally makes the ambiguous relevance band resolvable in production instead of always
 * failing closed (src/api/runner.ts never wired a real relevanceAmbiguityResolver before
 * this corrective pass).
 */

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

function buildContext(overrides: Partial<SurfaceRelevanceAmbiguityContext> = {}): SurfaceRelevanceAmbiguityContext {
  return {
    objectiveText: "Complete the vehicle finance application for the configured vehicle model.",
    title: "Vehicle Summary",
    headings: ["Your Vehicle Summary"],
    interactiveText: ["Continue to Finance"],
    deterministicScore: 0.2,
    ...overrides,
  };
}

test("a confident 'adopt' decision resolves as relevant", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({
      decision: "adopt",
      matchedMilestoneIds: ["finance-step"],
      confidence: 0.9,
      reason: "The heading 'Your Vehicle Summary' and control 'Continue to Finance' continue the journey.",
      evidenceUsed: ["Your Vehicle Summary", "Continue to Finance"],
    }),
  ]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: TEST_CONFIG, modelClient: client });

  const resolution = await resolver.resolve(buildContext());

  assert.equal(resolution.relevant, true);
  assert.equal(resolution.confidence, 0.9);
  assert.equal(client.requests.length, 1);
});

test("a confident 'reject' decision resolves as not relevant", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({
      decision: "reject",
      matchedMilestoneIds: [],
      confidence: 0.92,
      reason: "The heading 'Vehicle Summary' is present but no finance-related control is visible.",
      evidenceUsed: ["Vehicle Summary"],
    }),
  ]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: TEST_CONFIG, modelClient: client });

  const resolution = await resolver.resolve(buildContext());

  assert.equal(resolution.relevant, false);
});

test("a low-confidence 'adopt' decision is not trusted (relevant: false), even though the resolution itself is returned", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({
      decision: "adopt",
      matchedMilestoneIds: [],
      confidence: 0.5,
      reason: "Might be related to 'Vehicle Summary'.",
      evidenceUsed: ["Vehicle Summary"],
    }),
  ]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: TEST_CONFIG, modelClient: client });

  const resolution = await resolver.resolve(buildContext());

  assert.equal(resolution.relevant, false, "a low-confidence adopt must never be trusted");
});

test("malformed/empty output across every retry throws (fails safely, never resolves a fabricated verdict)", async () => {
  const client = new FakeReasoningModelClient([resultStep(null), resultStep(null)]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: TEST_CONFIG, modelClient: client });

  await assert.rejects(() => resolver.resolve(buildContext()));
});

test("a provider error throws rather than silently adopting", async () => {
  const client = new FakeReasoningModelClient([errorStep("timeout")]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: { ...TEST_CONFIG, maxRetries: 0 }, modelClient: client });

  await assert.rejects(() => resolver.resolve(buildContext()));
});

test("the prompt never includes cookies/credentials/raw HTML -- only the compact evidence fields", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ decision: "reject", matchedMilestoneIds: [], confidence: 0.9, reason: "No match.", evidenceUsed: [] }),
  ]);
  const resolver = new ClaudeSurfaceRelevanceAmbiguityResolver({ config: TEST_CONFIG, modelClient: client });

  await resolver.resolve(
    buildContext({
      unfinishedMilestones: [{ id: "finance-step", description: "Complete the finance application." }],
      completedMilestones: [{ id: "select-model", description: "Select a vehicle model." }],
      journeyType: "configurator_completion",
      triggeringCtaAccessibleName: "View Offer",
      domainPolicyApproved: true,
    }),
  );

  const sentPayload = JSON.parse(client.requests[0]!.userPrompt);
  assert.equal(sentPayload.domainPolicyApproved, true);
  assert.deepEqual(sentPayload.unfinishedMilestones, [{ id: "finance-step", description: "Complete the finance application." }]);
  for (const forbidden of ["cookie", "password", "token", "<html", "<script"]) {
    assert.ok(!client.requests[0]!.userPrompt.toLowerCase().includes(forbidden), `must never send "${forbidden}"`);
  }
});
