import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { FakeReasoningModelClient, resultStep } from "../unit/fakes/fakeReasoningModelClient.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";
import { buildFullJourneyTask } from "../manual/fullJourneyTask.js";
import { evaluateFullJourneyAcceptance } from "../manual/fullJourneyAcceptance.js";

// Deterministic, network-free proof (task requirement #14) that a real ClaudeReasoningProvider
// -- talking to a fake, in-memory model client instead of the real Anthropic API -- can drive
// the engine through the existing full local fictional journey (start.html -> step2.html ->
// success.html) in exactly three decisions, and that the resulting TaskResponse satisfies every
// full-journey acceptance criterion from task requirement #6. No ANTHROPIC_API_KEY is read and
// no network call is made; this exercises the same buildFullJourneyTask/evaluateFullJourneyAcceptance
// helpers the real, billed manual script (tests/manual/claudeFullLocalJourneyTest.ts) uses, so the
// two never drift apart.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const START_CLICK: ClaudeDecisionPayload = {
  action: "click",
  targetElementId: "el-0",
  reason: "Continue is the only visible path toward the objective.",
  confidence: 0.92,
};
const STEP2_CLICK: ClaudeDecisionPayload = {
  action: "click",
  targetElementId: "el-1",
  reason: "The second Continue control advances toward the success page.",
  confidence: 0.9,
};
const STOP_SUCCESS: ClaudeDecisionPayload = {
  action: "stop_success",
  reason: "The success page has been reached and its criteria are satisfied.",
  confidence: 0.95,
};

test("ClaudeReasoningProvider (fake model client) completes the full local journey in 3 decisions", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const client = new FakeReasoningModelClient([
      resultStep(START_CLICK, { usage: { inputTokens: 520, outputTokens: 42 } }),
      resultStep(STEP2_CLICK, { usage: { inputTokens: 540, outputTokens: 45 } }),
      resultStep(STOP_SUCCESS, { usage: { inputTokens: 480, outputTokens: 30 } }),
    ]);
    const reasoning = new ClaudeReasoningProvider({
      config: {
        apiKey: "test-fake-key-never-a-real-credential",
        model: "claude-sonnet-5",
        maxOutputTokens: 512,
        timeoutMs: 5000,
        maxRetries: 0,
        minConfidence: 0.5,
      },
      modelClient: client,
    });

    const task = buildFullJourneyTask(baseUrl);
    const result = await runTask({ page, task, reasoning });
    const decisionLog = reasoning.getDecisionLog();

    assert.equal(client.requests.length, 3, "expected exactly 3 real provider calls, never a 4th");
    assert.equal(result.status, "success");
    assert.equal(result.finalUrl, `${baseUrl}/success.html`);

    const schemaValidation = await validateAgainstTaskResponseSchema(result);
    assert.ok(schemaValidation.valid, schemaValidation.errorsText);

    const acceptance = evaluateFullJourneyAcceptance({
      result,
      decisionLog,
      allowedActions: task.safety.allowedActions,
      baseUrl,
    });
    assert.equal(acceptance.ok, true, acceptance.reason);

    const diagnostics = result.diagnostics.reasoningProvider;
    assert.equal(diagnostics?.provider, "claude");
    assert.equal(diagnostics?.callCount, 3);
    assert.equal(diagnostics?.acceptedDecisionCount, 3);
    assert.equal(diagnostics?.rejectedDecisionCount, 0);
    assert.equal(diagnostics?.fallbackDecisionCount, 0);
    assert.equal(diagnostics?.retryCount, 0);
    assert.equal(diagnostics?.totalInputTokens, 520 + 540 + 480);
    assert.equal(diagnostics?.totalOutputTokens, 42 + 45 + 30);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a journey that cannot complete within 3 decisions fails safely without a 4th call", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // Claude repeatedly (mis)selects stop_blocked instead of advancing -- the run must
    // stop after exactly 3 calls (maxSteps: 3) rather than ever asking a 4th time.
    const stallPayload: ClaudeDecisionPayload = {
      action: "stop_blocked",
      reason: "Uncertain how to proceed.",
      confidence: 0.6,
    };
    const client = new FakeReasoningModelClient([
      resultStep(stallPayload, { usage: { inputTokens: 100, outputTokens: 10 } }),
    ]);
    const reasoning = new ClaudeReasoningProvider({
      config: {
        apiKey: "test-fake-key-never-a-real-credential",
        model: "claude-sonnet-5",
        maxOutputTokens: 512,
        timeoutMs: 5000,
        maxRetries: 0,
        minConfidence: 0.5,
      },
      modelClient: client,
    });

    const task = buildFullJourneyTask(baseUrl);
    const result = await runTask({ page, task, reasoning });

    assert.equal(client.requests.length, 1, "the run must stop at the first stop_blocked, never retrying past it");
    assert.notEqual(result.status, "success");

    const acceptance = evaluateFullJourneyAcceptance({
      result,
      decisionLog: reasoning.getDecisionLog(),
      allowedActions: task.safety.allowedActions,
      baseUrl,
    });
    assert.equal(acceptance.ok, false, "acceptance must fail safely when the journey does not reach success");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
