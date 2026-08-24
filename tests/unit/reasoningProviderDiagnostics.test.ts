import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { FakeReasoningModelClient, errorStep, resultStep } from "./fakes/fakeReasoningModelClient.js";
import { buildTestReasoningContext } from "./helpers/reasoningContext.js";

// Covers task requirement #11: automated tests proving diagnostics.reasoningProvider
// aggregation is correct, safe, and derived from the existing ClaudeReasoningProvider
// decision log (never a second usage-tracking mechanism). Only fake/injected reasoning
// clients are used here -- no ANTHROPIC_API_KEY, no real Anthropic API request.

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

function buildProvider(client: FakeReasoningModelClient): ClaudeReasoningProvider {
  return new ClaudeReasoningProvider({ config: TEST_CONFIG, modelClient: client });
}

function acceptedPayload(overrides: Partial<ClaudeDecisionPayload> = {}): ClaudeDecisionPayload {
  return {
    action: "click",
    targetElementId: "el-0",
    reason: "Continue is the only visible path toward the objective.",
    confidence: 0.87,
    ...overrides,
  };
}

test("one accepted fake Claude decision produces callCount 1 and zero retries", async () => {
  const client = new FakeReasoningModelClient([resultStep(acceptedPayload(), { usage: { inputTokens: 120, outputTokens: 30 } })]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext());
  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.version, "1.0.0");
  assert.equal(diagnostics.provider, "claude");
  assert.equal(diagnostics.model, TEST_CONFIG.model);
  assert.equal(diagnostics.callCount, 1);
  assert.equal(diagnostics.acceptedDecisionCount, 1);
  assert.equal(diagnostics.rejectedDecisionCount, 0);
  assert.equal(diagnostics.fallbackDecisionCount, 0);
  assert.equal(diagnostics.retryCount, 0);
  assert.equal(diagnostics.totalInputTokens, 120);
  assert.equal(diagnostics.totalOutputTokens, 30);
});

test("multiple fake decisions across a run are aggregated correctly", async () => {
  const client = new FakeReasoningModelClient([
    resultStep(acceptedPayload(), { usage: { inputTokens: 100, outputTokens: 20 } }),
    resultStep(acceptedPayload(), { usage: { inputTokens: 150, outputTokens: 25 } }),
    resultStep(acceptedPayload(), { usage: { inputTokens: 200, outputTokens: 40 } }),
  ]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext({ limits: { maxSteps: 10, maxBacktracks: 2, stepsUsed: 0, backtracksUsed: 0 } }));
  await provider.decide(buildTestReasoningContext({ limits: { maxSteps: 10, maxBacktracks: 2, stepsUsed: 1, backtracksUsed: 0 } }));
  await provider.decide(buildTestReasoningContext({ limits: { maxSteps: 10, maxBacktracks: 2, stepsUsed: 2, backtracksUsed: 0 } }));

  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.callCount, 3);
  assert.equal(diagnostics.acceptedDecisionCount, 3);
  assert.equal(diagnostics.totalInputTokens, 100 + 150 + 200);
  assert.equal(diagnostics.totalOutputTokens, 20 + 25 + 40);
  assert.equal(diagnostics.decisions?.length, 3);
  assert.deepEqual(
    diagnostics.decisions?.map((d) => d.stepIndex),
    [0, 1, 2],
  );
});

test("retries are counted correctly (one retry across two attempts of the same decision)", async () => {
  const invalidPayload = acceptedPayload({ targetElementId: "el-not-real" });
  const validPayload = acceptedPayload();
  const client = new FakeReasoningModelClient([resultStep(invalidPayload), resultStep(validPayload)]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext());
  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.callCount, 2, "both attempts of the same decision are real provider calls");
  assert.equal(diagnostics.retryCount, 1, "exactly one attempt beyond the first counts as a retry");
  assert.equal(diagnostics.acceptedDecisionCount, 1);
  assert.equal(diagnostics.rejectedDecisionCount, 1);
});

test("latency is summed across every attempt, including the eventual fallback", async () => {
  const payload = acceptedPayload({ targetElementId: "el-not-real" });
  const client = new FakeReasoningModelClient([
    resultStep(payload, { usage: { inputTokens: 10, outputTokens: 5 } }),
    resultStep(payload, { usage: { inputTokens: 10, outputTokens: 5 } }),
  ]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext());
  const diagnostics = provider.getUsageDiagnostics();

  const expectedLatency = diagnostics.decisions?.reduce((sum, d) => sum + d.latencyMs, 0) ?? -1;
  assert.equal(diagnostics.totalLatencyMs, expectedLatency);
  assert.ok(diagnostics.totalLatencyMs >= 0);
});

test("rejected and fallback outcomes are counted correctly, including provider errors folded into rejected", async () => {
  const client = new FakeReasoningModelClient([errorStep("rate_limited"), errorStep("rate_limited")]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext());
  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.callCount, 2);
  assert.equal(diagnostics.rejectedDecisionCount, 2, "provider/API errors are discarded attempts, folded into rejected");
  assert.equal(diagnostics.fallbackDecisionCount, 1, "no valid decision was produced, so the run falls back exactly once");
  assert.equal(diagnostics.acceptedDecisionCount, 0);
  assert.ok(diagnostics.decisions?.some((d) => d.outcome === "error"), "per-decision detail still distinguishes error from rejected");
});

test("a fallback with no allowed actions makes zero real calls", async () => {
  const client = new FakeReasoningModelClient([]);
  const provider = buildProvider(client);

  await provider.decide(buildTestReasoningContext({ allowedActions: [] }));
  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.callCount, 0);
  assert.equal(diagnostics.fallbackDecisionCount, 1);
  assert.equal(diagnostics.totalInputTokens, 0);
  assert.equal(diagnostics.totalOutputTokens, 0);
});

test("mock provider reports zero Claude API usage and clearly identifies itself as mock", async () => {
  const provider = new MockReasoningProvider();
  await provider.decide(buildTestReasoningContext());
  await provider.decide(buildTestReasoningContext());

  const diagnostics = provider.getUsageDiagnostics();

  assert.equal(diagnostics.provider, "mock");
  assert.equal(diagnostics.model, undefined);
  assert.equal(diagnostics.callCount, 0);
  assert.equal(diagnostics.acceptedDecisionCount, 0);
  assert.equal(diagnostics.rejectedDecisionCount, 0);
  assert.equal(diagnostics.fallbackDecisionCount, 0);
  assert.equal(diagnostics.totalInputTokens, 0);
  assert.equal(diagnostics.totalOutputTokens, 0);
  assert.equal(diagnostics.totalLatencyMs, 0);
  assert.equal(diagnostics.retryCount, 0);
});

test("diagnostics contain no prompts, raw responses, observations, page HTML, secrets, headers, or credentials", async () => {
  const context = buildTestReasoningContext();
  const client = new FakeReasoningModelClient([
    resultStep(acceptedPayload(), { usage: { inputTokens: 111, outputTokens: 22 } }),
  ]);
  const provider = buildProvider(client);

  await provider.decide(context);
  const diagnostics = provider.getUsageDiagnostics();
  const serialized = JSON.stringify(diagnostics);

  // Nothing from the prompt/observation the fake client actually received should leak
  // into the diagnostics summary -- only aggregate/per-decision numbers and outcome codes.
  assert.ok(!serialized.includes(context.objective));
  assert.ok(!serialized.includes(context.observation.url));
  assert.ok(!serialized.includes(context.observation.notableText?.[0] ?? "__unused__"));
  assert.ok(!serialized.includes("<html"));
  assert.ok(!serialized.includes(TEST_CONFIG.apiKey));
  assert.ok(!serialized.toLowerCase().includes("authorization"));
  assert.ok(!serialized.toLowerCase().includes("cookie"));

  // The diagnostics object only ever carries the documented, safe key set.
  const topLevelKeys = Object.keys(diagnostics).sort();
  assert.deepEqual(topLevelKeys, [
    "acceptedDecisionCount",
    "callCount",
    "decisions",
    "fallbackDecisionCount",
    "model",
    "provider",
    "rejectedDecisionCount",
    "retryCount",
    "totalInputTokens",
    "totalLatencyMs",
    "totalOutputTokens",
    "version",
  ]);
  const decisionKeys = new Set(diagnostics.decisions?.flatMap((d) => Object.keys(d)) ?? []);
  for (const key of decisionKeys) {
    assert.ok(
      ["stepIndex", "attempt", "outcome", "confidence", "inputTokens", "outputTokens", "latencyMs"].includes(key),
      `unexpected key "${key}" in a per-decision summary`,
    );
  }
});
