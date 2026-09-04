import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateFullJourneyAcceptance } from "../manual/fullJourneyAcceptance.js";
import type { ClaudeDecisionLogEntry } from "../../src/reasoning/claudeReasoningProvider.js";
import type { StepLog, TaskResponse } from "../../src/types/task-response.js";
import type { ActionType } from "../../src/types/actions.js";

// Pure, network-free tests for the full-journey acceptance logic (task requirement #14):
// they cover the documented pass case (three accepted decisions completing
// start.html -> step2.html -> success.html) and every documented failure mode, without
// ever touching the real Claude API, Playwright, or the local fixture server.

const BASE_URL = "http://127.0.0.1:12345";
const ALLOWED_ACTIONS: ActionType[] = ["click", "stop_success", "stop_blocked", "stop_failure"];

function decisionEntry(overrides: Partial<ClaudeDecisionLogEntry> = {}): ClaudeDecisionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    provider: "claude",
    model: "claude-sonnet-5",
    attempt: 0,
    outcome: "accepted",
    confidence: 0.9,
    latencyMs: 800,
    usage: { inputTokens: 500, outputTokens: 40 },
    ...overrides,
  };
}

function step(overrides: Partial<StepLog> = {}): StepLog {
  return {
    stepIndex: 0,
    timestamp: new Date().toISOString(),
    currentUrl: `${BASE_URL}/start.html`,
    observation: {
      url: `${BASE_URL}/start.html`,
      title: "Start",
      interactiveElements: [{ id: "el-0", role: "a", accessibleName: "Continue", visible: true }],
    },
    decision: "Continue is the only visible path toward the objective.",
    selectedAction: { type: "click", target: "el-0" },
    actionResult: { success: true, resultingUrl: `${BASE_URL}/step2.html` },
    progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
    ...overrides,
  };
}

function successSteps(): StepLog[] {
  return [
    step({
      stepIndex: 0,
      currentUrl: `${BASE_URL}/start.html`,
      selectedAction: { type: "click", target: "el-0" },
      actionResult: { success: true, resultingUrl: `${BASE_URL}/step2.html` },
    }),
    step({
      stepIndex: 1,
      currentUrl: `${BASE_URL}/step2.html`,
      observation: {
        url: `${BASE_URL}/step2.html`,
        title: "Step Two",
        interactiveElements: [
          { id: "el-0", role: "button", accessibleName: "Learn more about this step", visible: true },
          { id: "el-1", role: "a", accessibleName: "Continue", visible: true },
        ],
      },
      selectedAction: { type: "click", target: "el-1" },
      actionResult: { success: true, resultingUrl: `${BASE_URL}/success.html` },
      progress: { satisfiedCriteriaIds: [], estimatedCompletion: 0 },
    }),
    step({
      stepIndex: 2,
      currentUrl: `${BASE_URL}/success.html`,
      observation: {
        url: `${BASE_URL}/success.html`,
        title: "Success",
        interactiveElements: [],
      },
      selectedAction: { type: "stop_success" },
      actionResult: { success: true },
      progress: { satisfiedCriteriaIds: ["reached_success_page"], estimatedCompletion: 1 },
    }),
  ];
}

function successResult(overrides: Partial<TaskResponse> = {}): TaskResponse {
  return {
    schemaVersion: "1.6.0",
    taskId: "claude-full-local-journey",
    status: "success",
    startUrl: `${BASE_URL}/start.html`,
    finalUrl: `${BASE_URL}/success.html`,
    steps: successSteps(),
    captures: {},
    engineAssessment: { objectiveAchieved: true, confidence: 1, summary: "Reached success." },
    diagnostics: {
      stepCount: 3,
      backtrackCount: 0,
      totalDurationMs: 2500,
      finishReason: "stop_success_action",
      reasoningProvider: {
        version: "1.1.0",
        provider: "claude",
        model: "claude-sonnet-5",
        callCount: 3,
        acceptedDecisionCount: 3,
        rejectedDecisionCount: 0,
        fallbackDecisionCount: 0,
        totalInputTokens: 1500,
        totalOutputTokens: 120,
        totalLatencyMs: 2400,
        retryCount: 0,
      },
    },
    ...overrides,
  };
}

function successDecisionLog(): ClaudeDecisionLogEntry[] {
  return [
    decisionEntry({ stepIndex: 0 }),
    decisionEntry({ stepIndex: 1 }),
    decisionEntry({ stepIndex: 2 }),
  ];
}

test("passes: three accepted decisions complete the full local journey", () => {
  const result = evaluateFullJourneyAcceptance({
    result: successResult(),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, true, result.reason);
});

test("fails: schemaVersion is not 1.2.0", () => {
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ schemaVersion: "1.1.0" as TaskResponse["schemaVersion"] }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /schemaVersion/);
});

test("fails: final engine status is not success", () => {
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ status: "max_steps_reached" }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /final engine status/i);
});

test("fails: the journey never reached step2.html", () => {
  const steps = successSteps();
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ steps: [steps[0]!, steps[2]!] }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /step2\.html/);
});

test("fails: the journey never reached success.html", () => {
  const steps = successSteps();
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ steps: [steps[0]!, steps[1]!] }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /success\.html/);
});

test("fails: selected action is not in the controlled vocabulary allowed for this run", () => {
  const steps = successSteps();
  steps[0] = { ...steps[0]!, selectedAction: { type: "navigate", target: `${BASE_URL}/other.html` } };
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ steps }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /controlled vocabulary/i);
});

test("fails: click target element id does not exist in that step's observation", () => {
  const steps = successSteps();
  steps[0] = { ...steps[0]!, selectedAction: { type: "click", target: "el-not-real" } };
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ steps }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not present in that step's observation/);
});

test("fails: diagnostics.reasoningProvider is missing", () => {
  const result = evaluateFullJourneyAcceptance({
    result: successResult({ diagnostics: { ...successResult().diagnostics, reasoningProvider: undefined } }),
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /diagnostics\.reasoningProvider is missing/);
});

test("fails: provider is not claude", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, provider: "mock" } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /provider/);
});

test("fails: more than 3 real Claude API calls were made", () => {
  const decisionLog = [
    decisionEntry({ stepIndex: 0 }),
    decisionEntry({ stepIndex: 1 }),
    decisionEntry({ stepIndex: 2 }),
    decisionEntry({ stepIndex: 3 }),
  ];
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, callCount: 4, acceptedDecisionCount: 4 } },
    },
    decisionLog,
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /exceeding the maximum of 3/);
});

test("fails: callCount does not equal the actual number of real provider calls", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, callCount: 2 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /callCount/);
});

test("fails: acceptedDecisionCount does not equal callCount", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, acceptedDecisionCount: 2 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /acceptedDecisionCount/);
});

test("fails: rejectedDecisionCount is not zero", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, rejectedDecisionCount: 1 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /rejectedDecisionCount/);
});

test("fails: fallbackDecisionCount is not zero", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, fallbackDecisionCount: 1 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /fallbackDecisionCount/);
});

test("fails: retryCount is not zero", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, retryCount: 1 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /retryCount/);
});

test("fails: totalInputTokens is not greater than zero", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, totalInputTokens: 0 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /totalInputTokens/);
});

test("fails: totalOutputTokens is not greater than zero", () => {
  const base = successResult();
  const result = evaluateFullJourneyAcceptance({
    result: {
      ...base,
      diagnostics: { ...base.diagnostics, reasoningProvider: { ...base.diagnostics.reasoningProvider!, totalOutputTokens: 0 } },
    },
    decisionLog: successDecisionLog(),
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /totalOutputTokens/);
});

test("fails: a raw Anthropic API key shape appears in the output", () => {
  const decisionLog = successDecisionLog();
  decisionLog[2] = decisionEntry({
    stepIndex: 2,
    reason: "leaked sk-ant-api03-thisisatotallyfakeleakedkeyvalue",
  });
  const result = evaluateFullJourneyAcceptance({
    result: successResult(),
    decisionLog,
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /raw anthropic api key/i);
});

test("fails: the raw secret value itself appears in the output", () => {
  const secretValue = "totally-secret-test-value-should-never-appear";
  const decisionLog = successDecisionLog();
  decisionLog[2] = decisionEntry({ stepIndex: 2, reason: `oops ${secretValue}` });
  const result = evaluateFullJourneyAcceptance({
    result: successResult(),
    decisionLog,
    allowedActions: ALLOWED_ACTIONS,
    baseUrl: BASE_URL,
    secretValue,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /raw anthropic_api_key secret/i);
});
