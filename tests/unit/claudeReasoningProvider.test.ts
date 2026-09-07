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

// ---------------------------------------------------------------------------------------
// FIX (CONFIRMED ISSUE 2, run_a9eb40df-0191-44af-9ce9-acdcab7e8bb5): a real run's error
// outcome reported nothing more actionable than the generic "provider_error" -- see
// anthropicReasoningModelClient.test.ts for the underlying sanitizeError fix (it now
// classifies the two failure shapes the Anthropic SDK's own response-parsing helper can
// throw: raw output that isn't valid JSON, and JSON that fails the decision schema). These
// tests confirm end-to-end, at the ReasoningProvider boundary, that a specific category
// reaches both the structured decision log and the human-readable fallback rationale
// safely -- never the API key, never a raw model response, never a full prompt -- based
// only on failure shapes already represented by the ReasoningModelClient abstraction
// (ReasoningModelError + its category), with no dependency on the real Anthropic SDK.
// ---------------------------------------------------------------------------------------

test("FIX (issue 2): a malformed/invalid decision response (JSON parse failure) is recorded and reported as response_parse_failed, never the generic provider_error", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_parse_failed"), errorStep("response_parse_failed")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.match(decision.rationale, /response_parse_failed/);
  assert.doesNotMatch(decision.rationale, /provider_error/);
  assert.ok(log.some((e) => e.reason === "response_parse_failed"));
});

test("FIX (issue 2): a malformed/invalid decision response (schema validation failure) is recorded and reported as response_schema_invalid, never the generic provider_error", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), errorStep("response_schema_invalid")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.match(decision.rationale, /response_schema_invalid/);
  assert.doesNotMatch(decision.rationale, /provider_error/);
  assert.ok(log.some((e) => e.reason === "response_schema_invalid"));
});

test("FIX (issue 2): a provider timeout is recorded and reported as timeout, never the generic provider_error", async () => {
  const client = new FakeReasoningModelClient([errorStep("timeout"), errorStep("timeout")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.match(decision.rationale, /timeout/);
  assert.doesNotMatch(decision.rationale, /provider_error/);
  assert.ok(log.some((e) => e.reason === "timeout"));
});

test("FIX (issue 2): an empty/unparseable response (no thrown error, but no parsed output either) is still recorded as malformed_output, never the generic provider_error -- confirms this pre-existing path is already actionable", async () => {
  const client = new FakeReasoningModelClient([resultStep<ClaudeDecisionPayload>(null), resultStep<ClaudeDecisionPayload>(null)]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.match(decision.rationale, /malformed_output/);
  assert.doesNotMatch(decision.rationale, /provider_error/);
  assert.ok(log.some((e) => e.reason === "malformed_output"));
});

test("sanitisation: none of the new provider-error diagnostics ever leak the API key, and the fallback rationale never carries a raw error message", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), errorStep("response_schema_invalid")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  const serializedLog = JSON.stringify(log);
  assert.ok(!serializedLog.includes(TEST_CONFIG.apiKey));
  assert.ok(!decision.rationale.includes(TEST_CONFIG.apiKey));
  // The rationale is the short, fixed template string plus the sanitised category only --
  // never a raw SDK message, never prompt content.
  assert.equal(
    decision.rationale,
    "Claude reasoning provider could not produce a valid decision (response_schema_invalid); stopping safely.",
  );
});

// ---------------------------------------------------------------------------------------
// FIX (run_57ca85c3-df96-4dcc-be6f-c3be55a202f1): PR #36 correctly classified a
// response_schema_invalid/response_parse_failed failure but never changed anything before
// the retry, which just resent the identical prompt and predictably failed the same way
// again -- the run fell straight to stop_blocked. decide() now issues exactly one bounded
// corrective retry for these two categories specifically: the same observation-derived
// user prompt (never rescanned/re-selected), a system prompt amended to state the previous
// response was invalid and restate only the allowed-action vocabulary, and never the raw
// invalid response or any secret. Every other failure category is untouched -- still
// governed only by the pre-existing, generic maxRetries policy.
// ---------------------------------------------------------------------------------------

function correctivePayload(): ClaudeDecisionPayload {
  return {
    action: "click",
    targetElementId: "el-0",
    reason: "Corrected: Continue is the visible path toward the objective.",
    confidence: 0.9,
  };
}

test("FIX (corrective retry): an invalid-schema first response followed by a valid corrective response is accepted", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), resultStep(correctivePayload())]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.equal(client.requests.length, 2, "expected exactly one corrective retry (2 calls total)");
  assert.equal(log[log.length - 1]?.outcome, "accepted");
  assert.equal(log[log.length - 1]?.correctiveRetry, true, "the accepted attempt must be flagged as the corrective retry");
  assert.equal(log[0]?.reason, "response_schema_invalid");
});

test("FIX (corrective retry): a malformed-JSON first response followed by a valid corrective response is accepted", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_parse_failed"), resultStep(correctivePayload())]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.equal(client.requests.length, 2);
  assert.equal(log[log.length - 1]?.outcome, "accepted");
  assert.equal(log[log.length - 1]?.correctiveRetry, true);
  assert.equal(log[0]?.reason, "response_parse_failed");
});

test("FIX (corrective retry): two invalid responses (original + failed correction) stop safely at stop_blocked, never chaining into a further generic retry", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), errorStep("response_schema_invalid")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(client.requests.length, 2, "expected exactly 2 calls total: the original failure plus its one corrective retry, nothing more");
  assert.equal(log.filter((e) => e.outcome === "error").length, 2);
  assert.equal(log.filter((e) => e.correctiveRetry === true).length, 1, "expected exactly one attempt flagged as the corrective retry");
  assert.equal(log[log.length - 1]?.outcome, "fallback");
});

test("FIX (corrective retry): an HTTP/provider failure (rate limit) receives no new schema-correction retry -- only the existing generic maxRetries policy applies", async () => {
  const client = new FakeReasoningModelClient([errorStep("rate_limited"), errorStep("rate_limited")]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  // Unchanged from the pre-existing generic policy: 1 + maxRetries(1) = 2 calls, exactly
  // as before this fix -- never an additional corrective attempt on top.
  assert.equal(client.requests.length, 2);
  assert.equal(log.filter((e) => e.correctiveRetry === true).length, 0, "a transport/HTTP failure category must never be flagged as a corrective retry");
});

test("FIX (corrective retry): authentication and timeout failures also receive no schema-correction retry", async () => {
  for (const category of ["authentication_failed", "timeout", "connection_error", "bad_request"]) {
    const client = new FakeReasoningModelClient([errorStep(category), errorStep(category)]);
    const { provider, log } = buildProvider(client);

    await provider.decide(buildTestReasoningContext());

    assert.equal(client.requests.length, 2, `expected no extra call for category "${category}"`);
    assert.equal(log.filter((e) => e.correctiveRetry === true).length, 0, `expected no corrective retry for category "${category}"`);
  }
});

test("FIX (corrective retry): the corrective retry reuses the exact same observation-derived user prompt and element selection -- never rescanned or re-selected", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), resultStep(correctivePayload())]);
  const { provider, log } = buildProvider(client);

  await provider.decide(buildTestReasoningContext());

  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0]?.userPrompt, client.requests[1]?.userPrompt, "the corrective retry's user prompt must be byte-identical to the original attempt's");
  assert.deepEqual(log[0]?.elementSelection, log[1]?.elementSelection, "the corrective retry must carry the exact same element-selection diagnostic as the original attempt");
});

test("FIX (corrective retry): the corrective system prompt states the previous response was invalid and restates only the allowed actions -- never the raw invalid response or a secret", async () => {
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), resultStep(correctivePayload())]);
  const { provider } = buildProvider(client);
  const context = buildTestReasoningContext({ allowedActions: ["click", "stop_blocked"] });

  await provider.decide(context);

  const originalSystem = client.requests[0]?.system ?? "";
  const correctiveSystem = client.requests[1]?.system ?? "";

  assert.notEqual(correctiveSystem, originalSystem, "the corrective retry's system prompt must differ from the original");
  assert.ok(correctiveSystem.startsWith(originalSystem), "the corrective system prompt must be the original prompt plus an addendum, never a replacement");
  assert.match(correctiveSystem, /previous response could not be used/i);
  assert.match(correctiveSystem, /\["click","stop_blocked"\]/, "expected the corrective addendum to restate the exact allowed-action vocabulary");

  // Never the API key, never anything resembling a raw provider error/response payload.
  assert.ok(!correctiveSystem.includes(TEST_CONFIG.apiKey));
  assert.ok(!correctiveSystem.toLowerCase().includes("response_schema_invalid"));
  assert.ok(!correctiveSystem.toLowerCase().includes("stack"));
});

test("FIX (corrective retry): retryCount and provider call counts are accurate for both the recovered and the exhausted case", async () => {
  const recoveredClient = new FakeReasoningModelClient([errorStep("response_schema_invalid"), resultStep(correctivePayload())]);
  const { provider: recoveredProvider } = buildProvider(recoveredClient);
  await recoveredProvider.decide(buildTestReasoningContext());
  const recoveredDiagnostics = recoveredProvider.getUsageDiagnostics();
  assert.equal(recoveredDiagnostics.callCount, 2);
  assert.equal(recoveredDiagnostics.retryCount, 1, "the one corrective retry must count toward the existing retryCount");
  assert.equal(recoveredDiagnostics.acceptedDecisionCount, 1);
  assert.equal(recoveredDiagnostics.fallbackDecisionCount, 0);

  const exhaustedClient = new FakeReasoningModelClient([errorStep("response_schema_invalid"), errorStep("response_schema_invalid")]);
  const { provider: exhaustedProvider } = buildProvider(exhaustedClient);
  await exhaustedProvider.decide(buildTestReasoningContext());
  const exhaustedDiagnostics = exhaustedProvider.getUsageDiagnostics();
  assert.equal(exhaustedDiagnostics.callCount, 2);
  assert.equal(exhaustedDiagnostics.retryCount, 1);
  assert.equal(exhaustedDiagnostics.rejectedDecisionCount, 2, "both the original error and the failed corrective retry count as rejected/error attempts");
  assert.equal(exhaustedDiagnostics.fallbackDecisionCount, 1);
});

// ---------------------------------------------------------------------------------------
// FIX (run_e78d8d76-b487-4ece-8e0b-a0e2fbd48b1b, PART 2): a structurally valid decision
// rejected only for confidence below the run's minimum now gets the same kind of one-shot
// bounded corrective retry as a schema/parse failure -- sharing the exact same
// correctiveRetryUsed budget (item 11 of the fix), never a second, independent allowance.
// ---------------------------------------------------------------------------------------

function lowConfidencePayload(confidence: number): ClaudeDecisionPayload {
  return {
    action: "click",
    targetElementId: "el-0",
    reason: "Not very sure about this one.",
    confidence,
  };
}

test("FIX (low-confidence corrective retry): a structurally valid but low-confidence first response followed by a confident corrective response is accepted", async () => {
  const client = new FakeReasoningModelClient([resultStep(lowConfidencePayload(0.1)), resultStep(correctivePayload())]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.equal(client.requests.length, 2, "expected exactly one corrective retry (2 calls total)");
  assert.equal(log[log.length - 1]?.outcome, "accepted");
  assert.equal(log[log.length - 1]?.correctiveRetry, true, "the accepted attempt must be flagged as the corrective retry");
  assert.equal(log[0]?.reason, "low_confidence");
});

test("FIX (low-confidence corrective retry): two low-confidence decisions still stop safely at stop_blocked, using exactly the shared corrective budget", async () => {
  const client = new FakeReasoningModelClient([resultStep(lowConfidencePayload(0.1)), resultStep(lowConfidencePayload(0.2))]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(client.requests.length, 2, "expected exactly 2 calls total: the original low-confidence decision plus its one corrective retry, nothing more");
  assert.equal(log.filter((e) => e.correctiveRetry === true).length, 1);
  assert.equal(log[log.length - 1]?.outcome, "fallback");
});

test("FIX (low-confidence corrective retry): the corrective system prompt states the previous decision was below the confidence threshold and restates the earliest-unfinished/pending/terminal instruction partition -- never the previous raw response or a secret", async () => {
  const client = new FakeReasoningModelClient([resultStep(lowConfidencePayload(0.1)), resultStep(correctivePayload())]);
  const { provider } = buildProvider(client);
  const orderedCriteria = [
    { id: "select-item", type: "element_present" as const, description: "Select the specified item.", config: {}, required: true },
    { id: "primary-progression", type: "element_present" as const, description: "Activate the primary progression action.", config: {}, required: true },
    { id: "terminal-action", type: "url_pattern" as const, description: "Select the specified terminal action.", config: {}, required: true },
  ];
  const context = buildTestReasoningContext({ successCriteria: orderedCriteria, satisfiedCriteriaIds: ["select-item"] });

  await provider.decide(context);

  const originalSystem = client.requests[0]?.system ?? "";
  const correctiveSystem = client.requests[1]?.system ?? "";

  assert.notEqual(correctiveSystem, originalSystem);
  assert.ok(correctiveSystem.startsWith(originalSystem));
  assert.match(correctiveSystem, /rejected only because its stated confidence was below the minimum/i);
  assert.match(correctiveSystem, /Completed instructions so far:.*Select the specified item\./i);
  assert.match(correctiveSystem, /earliest unfinished instruction to act on now:.*Activate the primary progression action\./i);
  assert.match(correctiveSystem, /terminal instruction.*Select the specified terminal action\./i);

  // Never the API key, never the numeric rejected confidence value, never a raw response.
  assert.ok(!correctiveSystem.includes(TEST_CONFIG.apiKey));
  assert.ok(!correctiveSystem.includes("0.1"));
});

test("FIX: schema/parse correction and low-confidence correction share one strict budget -- they never chain into two corrective attempts", async () => {
  // The original attempt fails schema-invalid (triggers the corrective retry); the
  // corrective attempt itself comes back low-confidence -- this must never be treated as a
  // *second*, independent trigger for another corrective attempt.
  const client = new FakeReasoningModelClient([errorStep("response_schema_invalid"), resultStep(lowConfidencePayload(0.1))]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.deepEqual(decision.action, { type: "stop_blocked" });
  assert.equal(
    client.requests.length,
    2,
    "expected exactly 2 calls: the original schema failure plus its one corrective retry -- never a second corrective attempt for the low-confidence outcome",
  );
  assert.equal(log.filter((e) => e.correctiveRetry === true).length, 1);
  assert.equal(log[log.length - 1]?.reason, "low_confidence");
});

test("FIX: the maximum possible provider calls per reasoning step is bounded at (1 + maxRetries) + 1 shared corrective retry, never more", async () => {
  const badTargetPayload: ClaudeDecisionPayload = {
    action: "click",
    targetElementId: "el-not-real",
    reason: "Targeting an element that was never observed.",
    confidence: 0.9,
  };
  // attempt0: a non-corrective-eligible rejection (unknown_target_element_id) -- the normal
  // generic maxRetries loop continues as before this fix, no corrective retry yet.
  // attempt1 (the single generic retry maxRetries=1 allows): low-confidence -- *now* the
  // shared corrective budget triggers for the first time, spending one more call.
  const client = new FakeReasoningModelClient([resultStep(badTargetPayload), resultStep(lowConfidencePayload(0.1)), resultStep(correctivePayload())]);
  const { provider, log } = buildProvider(client);

  const decision = await provider.decide(buildTestReasoningContext());

  assert.equal(client.requests.length, 3, "worst case under this fix: 2 normal attempts (1 + maxRetries=1) plus exactly 1 shared corrective retry = 3 total calls");
  assert.deepEqual(decision.action, { type: "click", target: "el-0" });
  assert.equal(log.filter((e) => e.correctiveRetry === true).length, 1);
});
