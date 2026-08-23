import { test } from "node:test";
import assert from "node:assert/strict";

import { ClaudeReasoningProvider, type ClaudeDecisionLogEntry } from "../../src/reasoning/claudeReasoningProvider.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { FakeReasoningModelClient, errorStep, resultStep } from "./fakes/fakeReasoningModelClient.js";
import { buildTestReasoningContext } from "./helpers/reasoningContext.js";

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

function buildProvider(client: FakeReasoningModelClient) {
  const log: ClaudeDecisionLogEntry[] = [];
  const provider = new ClaudeReasoningProvider({
    config: TEST_CONFIG,
    modelClient: client,
    onDecisionLogged: (entry) => log.push(entry),
  });
  return { provider, log };
}

test("accepts a valid, schema-conformant Claude decision", async () => {
  const payload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-0",
    reason: "Continue is the only visible path toward the objective.",
    confidence: 0.87,
  };
  const client = new FakeReasoningModelClient([resultStep(payload)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.match(decision.rationale, /Continue is the only visible path/);
  assert.equal(client.requests.length, 1);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, "accepted");
  assert.equal(log[0]?.model, TEST_CONFIG.model);
  assert.equal(log[0]?.provider, "claude");
});

test("rejects an out-of-vocabulary/disallowed action and stops safely after exhausting the single retry", async () => {
  const payload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-0",
    reason: "Attempting a disallowed action.",
    confidence: 0.9,
  };
  const context = buildTestReasoningContext({ allowedActions: ["stop_failure", "stop_blocked"] });
  const client = new FakeReasoningModelClient([resultStep(payload), resultStep(payload)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(context);

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(client.requests.length, 2, "expected exactly one retry (2 attempts total)");
  assert.equal(log.filter((e) => e.outcome === "rejected").length, 2);
  assert.equal(log.filter((e) => e.outcome === "rejected" && e.reason === "action_not_allowed").length, 2);
  assert.equal(log[log.length - 1]?.outcome, "fallback");
});

test("rejects a click targeting an unknown targetElementId", async () => {
  const payload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-not-real",
    reason: "Clicking an element that was never observed.",
    confidence: 0.9,
  };
  const client = new FakeReasoningModelClient([resultStep(payload), resultStep(payload)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.ok(log.some((e) => e.reason === "unknown_target_element_id"));
});

test("malformed (unparseable) model output stops safely without retrying past the cap", async () => {
  const client = new FakeReasoningModelClient([resultStep<ClaudeDecisionPayload>(null), resultStep<ClaudeDecisionPayload>(null)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(client.requests.length, 2);
  assert.ok(log.some((e) => e.reason === "malformed_output"));
  assert.equal(log[log.length - 1]?.outcome, "fallback");
});

test("low-confidence output is rejected per the documented minimum-confidence policy", async () => {
  const payload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-0",
    reason: "Not very sure about this one.",
    confidence: 0.1,
  };
  const client = new FakeReasoningModelClient([resultStep(payload), resultStep(payload)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.ok(log.some((e) => e.reason === "low_confidence"));
});

test("a rejected first attempt can succeed on the single allowed retry", async () => {
  const invalidPayload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-not-real",
    reason: "First attempt targets an unknown element.",
    confidence: 0.9,
  };
  const validPayload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-0",
    reason: "Second attempt targets the real Continue control.",
    confidence: 0.9,
  };
  const client = new FakeReasoningModelClient([resultStep(invalidPayload), resultStep(validPayload)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.equal(client.requests.length, 2);
  assert.equal(log[log.length - 1]?.outcome, "accepted");
});

test("a provider/API error is sanitised, recorded, and never leaks the API key or raw error details", async () => {
  const client = new FakeReasoningModelClient([errorStep("rate_limited"), errorStep("rate_limited")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(log.filter((e) => e.outcome === "error").length, 2);
  assert.ok(log.every((e) => e.reason !== TEST_CONFIG.apiKey));
  const serializedLog = JSON.stringify(log);
  assert.ok(!serializedLog.includes(TEST_CONFIG.apiKey));
  assert.ok(!decision.rationale.includes(TEST_CONFIG.apiKey));
  assert.ok(log.some((e) => e.reason === "rate_limited"));
});

test("returns a safe fallback immediately when no actions are allowed, without calling the model", async () => {
  const client = new FakeReasoningModelClient([]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext({ allowedActions: [] }));

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(client.requests.length, 0);
  assert.equal(log.length, 1);
  assert.equal(log[0]?.outcome, "fallback");
});
