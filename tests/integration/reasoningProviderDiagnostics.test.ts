import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRequire } from "node:module";

import { runTask } from "../../src/core/engine.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { FakeReasoningModelClient, resultStep } from "../unit/fakes/fakeReasoningModelClient.js";
import { startStaticServer } from "../helpers/staticServer.js";

// End-to-end coverage (task requirement #11) that diagnostics.reasoningProvider is wired
// all the way from a reasoning provider's decision log into the TaskResponse the engine
// (and, downstream, the HTTP API) actually returns -- using only a fake, injected model
// client. No ANTHROPIC_API_KEY is read and no real Claude API call is made.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

async function validateAgainstResponseSchema(response: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(response);
  assert.ok(valid, ajv.errorsText(validate.errors));
}

function buildTask(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.7.0",
    taskId: "reasoning-diagnostics-claude",
    objective: "Reach the fixture's success page by following the visible continue control.",
    startUrl: `${baseUrl}/start.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        config: { pattern: `${baseUrl}/success.html` },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 5, maxBacktracks: 0 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.6.0",
  };
}

function clickPayload(targetElementId: string): ClaudeDecisionPayload {
  return {
    action: "click",
    targetElementId,
    reason: "Continue is the visible path toward the objective.",
    confidence: 0.9,
  };
}

const STOP_SUCCESS_PAYLOAD: ClaudeDecisionPayload = {
  action: "stop_success",
  reason: "The success page has been reached.",
  confidence: 0.95,
};

test("a full run through a real ClaudeReasoningProvider (fake model client) surfaces accurate diagnostics.reasoningProvider", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const client = new FakeReasoningModelClient([
      resultStep(clickPayload("el-0"), { usage: { inputTokens: 100, outputTokens: 20 } }), // start.html "Continue"
      resultStep(clickPayload("el-1"), { usage: { inputTokens: 110, outputTokens: 22 } }), // step2.html "Continue" (el-0 is "Learn more")
      resultStep(STOP_SUCCESS_PAYLOAD, { usage: { inputTokens: 90, outputTokens: 15 } }), // success.html
    ]);
    const reasoning = new ClaudeReasoningProvider({
      config: {
        apiKey: "test-fake-key-never-a-real-credential",
        model: "claude-sonnet-5",
        maxOutputTokens: 512,
        timeoutMs: 5000,
        maxRetries: 1,
        minConfidence: 0.5,
      },
      modelClient: client,
    });

    const task = buildTask(baseUrl);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.schemaVersion, "1.6.0");

    const diagnostics = response.diagnostics.reasoningProvider;
    assert.ok(diagnostics, "expected diagnostics.reasoningProvider to be present");
    assert.equal(diagnostics?.version, "1.1.0");
    assert.equal(diagnostics?.provider, "claude");
    assert.equal(diagnostics?.model, "claude-sonnet-5");
    assert.equal(diagnostics?.callCount, 3);
    assert.equal(diagnostics?.acceptedDecisionCount, 3);
    assert.equal(diagnostics?.rejectedDecisionCount, 0);
    assert.equal(diagnostics?.fallbackDecisionCount, 0);
    assert.equal(diagnostics?.retryCount, 0);
    assert.equal(diagnostics?.totalInputTokens, 100 + 110 + 90);
    assert.equal(diagnostics?.totalOutputTokens, 20 + 22 + 15);
    assert.deepEqual(
      diagnostics?.decisions?.map((d) => d.stepIndex),
      [0, 1, 2],
    );

    // Raw website evidence stays under captures; reasoning usage stays under diagnostics.
    assert.equal((response as unknown as { captures: Record<string, unknown> }).captures.reasoningProvider, undefined);
    assert.equal(
      (response.engineAssessment as unknown as Record<string, unknown>).reasoningProvider,
      undefined,
    );

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a run through the default MockReasoningProvider reports diagnostics.reasoningProvider as mock with zero usage", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask(baseUrl);
    const response = await runTask({ page, task, reasoning: new MockReasoningProvider() });

    assert.equal(response.status, "success");
    const diagnostics = response.diagnostics.reasoningProvider;
    assert.ok(diagnostics, "expected diagnostics.reasoningProvider to be present even for the mock provider");
    assert.equal(diagnostics?.provider, "mock");
    assert.equal(diagnostics?.callCount, 0);
    assert.equal(diagnostics?.totalInputTokens, 0);
    assert.equal(diagnostics?.totalOutputTokens, 0);

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
