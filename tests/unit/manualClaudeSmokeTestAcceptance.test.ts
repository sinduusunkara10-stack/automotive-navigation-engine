import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateSmokeTestAcceptance } from "../manual/smokeTestAcceptance.js";
import type { ClaudeDecisionLogEntry } from "../../src/reasoning/claudeReasoningProvider.js";
import type { StepLog } from "../../src/types/task-response.js";
import type { ActionType } from "../../src/types/actions.js";

// Pure, network-free tests for the one-decision manual smoke-test acceptance logic (see
// task requirement #8): they cover the exact regression this fix addresses (one accepted
// decision followed by a forced max_steps stop must PASS) and every documented failure
// mode, without ever touching the real Claude API, Playwright, or the local fixture
// server.

const ALLOWED_ACTIONS: ActionType[] = ["click", "wait", "stop_success", "stop_blocked", "stop_failure"];

const OBSERVATION = {
  url: "http://127.0.0.1:12345/start.html",
  title: "Fictional start page",
  interactiveElements: [{ id: "el-0", role: "a", accessibleName: "Continue", visible: true }],
};

function acceptedEntry(overrides: Partial<ClaudeDecisionLogEntry> = {}): ClaudeDecisionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    provider: "claude",
    model: "claude-sonnet-5",
    attempt: 0,
    outcome: "accepted",
    confidence: 0.7,
    latencyMs: 900,
    usage: { inputTokens: 1065, outputTokens: 51 },
    ...overrides,
  };
}

function decisionStepLog(overrides: Partial<StepLog> = {}): StepLog {
  return {
    stepIndex: 0,
    timestamp: new Date().toISOString(),
    currentUrl: OBSERVATION.url,
    observation: OBSERVATION,
    decision: "Continue is the only visible path toward the objective (Claude confidence 0.70)",
    selectedAction: { type: "click", target: "el-0" },
    actionResult: { success: true },
    progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
    ...overrides,
  };
}

function maxStepsStopLog(overrides: Partial<StepLog> = {}): StepLog {
  return {
    stepIndex: 1,
    timestamp: new Date().toISOString(),
    currentUrl: OBSERVATION.url,
    observation: { ...OBSERVATION, interactiveElements: [] },
    decision: "Hard limit reached before another action could be taken.",
    selectedAction: { type: "stop_failure" },
    actionResult: { success: true },
    progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
    safetyFlags: ["max_steps"],
    ...overrides,
  };
}

test("passes: one accepted decision followed by the forced max_steps stop step", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, true, result.reason);
});

test("passes: one accepted decision with no forced limit step (run ended on its own)", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [decisionStepLog({ selectedAction: { type: "stop_success" } })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, true, result.reason);
});

test("fails: no Claude decision was produced", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [],
    steps: [maxStepsStopLog({ stepIndex: 0 })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no claude decision was produced/i);
});

test("fails: more than one Claude API decision was made", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [
      acceptedEntry({ attempt: 0, outcome: "rejected", reason: "unknown_target_element_id" }),
      acceptedEntry({ attempt: 1, outcome: "accepted" }),
    ],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /more than one claude api decision/i);
});

test("fails: the decision was rejected", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ outcome: "rejected", reason: "low_confidence" })],
    steps: [maxStepsStopLog({ stepIndex: 0 })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /rejected/i);
});

test("fails: the provider fell back to a safe stop instead of deciding", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ attempt: -1, outcome: "fallback", reason: "malformed_output" })],
    steps: [maxStepsStopLog({ stepIndex: 0 })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fell back/i);
});

test("fails: the Claude API call itself failed", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ outcome: "error", reason: "rate_limited" })],
    steps: [maxStepsStopLog({ stepIndex: 0 })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /api call failed/i);
});

test("fails: the provider was not claude", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [{ ...acceptedEntry(), provider: "not-claude" as "claude" }],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /provider was/i);
});

test("fails: a retry occurred (accepted decision was not attempt 0)", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ attempt: 1 })],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /retry occurred/i);
});

test("fails: selected action is not in the controlled vocabulary allowed for this run", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [decisionStepLog({ selectedAction: { type: "navigate", target: "http://127.0.0.1/other.html" } })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /controlled vocabulary/i);
});

test("fails: selected action is not schema-valid (unknown extra field)", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [
      decisionStepLog({
        selectedAction: { type: "click", target: "el-0", unexpectedField: true } as unknown as StepLog["selectedAction"],
      }),
    ],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not schema-valid/i);
});

test("fails: click target element id does not exist in the observation", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [decisionStepLog({ selectedAction: { type: "click", target: "el-not-real" } })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not present in the observation/i);
});

test("fails: a raw Anthropic API key shape appears in the output", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ reason: "leaked sk-ant-api03-thisisatotallyfakeleakedkeyvalue" })],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /raw anthropic api key/i);
});

test("fails: the raw secret value itself appears in the output", () => {
  const secretValue = "totally-secret-test-value-should-never-appear";
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry({ reason: `oops ${secretValue}` })],
    steps: [decisionStepLog(), maxStepsStopLog()],
    allowedActions: ALLOWED_ACTIONS,
    secretValue,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /raw anthropic_api_key secret/i);
});

test("does not fail merely because a max_duration/max_backtracks forced stop step is present", () => {
  const result = evaluateSmokeTestAcceptance({
    decisionLog: [acceptedEntry()],
    steps: [decisionStepLog(), maxStepsStopLog({ safetyFlags: ["max_backtracks"] })],
    allowedActions: ALLOWED_ACTIONS,
  });
  assert.equal(result.ok, true, result.reason);
});
