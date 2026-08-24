/**
 * Manual full-journey test for ClaudeReasoningProvider — NOT part of `npm test` / `npm run
 * check`, and never run automatically. Run explicitly with:
 *
 *   REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run fulljourney:claude
 *
 * Unlike tests/manual/claudeReasoningProviderSmokeTest.ts (exactly one decision, proving
 * the integration works at all), this proves the real Claude reasoning provider can drive
 * the engine's *existing* three-page local fictional journey end to end:
 * start.html -> step2.html -> success.html. It only ever navigates that local fixture
 * under tests/fixtures/ (never a real website, n8n, Google Sheets, or BigQuery), reuses
 * the existing engine (src/core/engine.ts) and reasoning provider (createReasoningProvider)
 * rather than reimplementing any navigation logic, and caps the task at maxSteps: 3 (see
 * tests/manual/fullJourneyTask.ts) — the minimum number of decisions needed to complete
 * this journey — so it can make at most three real, billed Claude API calls and never a
 * fourth.
 *
 * Pass/fail is judged by evaluateFullJourneyAcceptance (./fullJourneyAcceptance.ts) against
 * ClaudeReasoningProvider's decision log and the completed TaskResponse, and the response is
 * additionally validated against schemas/task-response.schema.json. Only a safe summary is
 * logged (task requirement #12): no raw prompts, model responses, HTML, environment
 * variables, headers, cookies, request bodies, or credentials ever reach the console.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { createReasoningProvider } from "../../src/reasoning/providerFactory.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";
import { buildFullJourneyTask } from "./fullJourneyTask.js";
import { evaluateFullJourneyAcceptance } from "./fullJourneyAcceptance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

async function main(): Promise<void> {
  if (process.env.REASONING_PROVIDER !== "claude") {
    console.log(
      'Skipping: this test only runs when REASONING_PROVIDER=claude. ' +
        "(Run: REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run fulljourney:claude)",
    );
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("Skipping: ANTHROPIC_API_KEY is not set. This test never runs without a real key present.");
    return;
  }

  console.log(
    "This will make at most three real, billed calls to the Claude API " +
      `(model: ${process.env.CLAUDE_MODEL ?? "claude-sonnet-5 (default)"}), against the local ` +
      "fictional fixture journey only (start.html -> step2.html -> success.html). No real " +
      "website, n8n, Google Sheets, or BigQuery is involved.",
  );

  const reasoning = createReasoningProvider();
  if (!(reasoning instanceof ClaudeReasoningProvider)) {
    throw new Error("Expected createReasoningProvider() to return a ClaudeReasoningProvider here.");
  }

  const { baseUrl, close: closeFixtures } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildFullJourneyTask(baseUrl);
    const result = await runTask({ page, task, reasoning });
    const decisionLog = reasoning.getDecisionLog();
    const diagnostics = result.diagnostics.reasoningProvider;
    const schemaValidation = await validateAgainstTaskResponseSchema(result);

    console.log("\n--- Claude full local-journey test: safe summary ---");
    console.log("status:", result.status);
    console.log("steps:", result.steps.length);
    console.log("provider:", diagnostics?.provider);
    console.log("model:", diagnostics?.model);
    console.log("callCount:", diagnostics?.callCount);
    console.log("acceptedDecisionCount:", diagnostics?.acceptedDecisionCount);
    console.log("rejectedDecisionCount:", diagnostics?.rejectedDecisionCount);
    console.log("fallbackDecisionCount:", diagnostics?.fallbackDecisionCount);
    console.log("totalInputTokens:", diagnostics?.totalInputTokens);
    console.log("totalOutputTokens:", diagnostics?.totalOutputTokens);
    console.log("totalLatencyMs:", diagnostics?.totalLatencyMs);
    console.log("retryCount:", diagnostics?.retryCount);
    console.log("schemaValid:", schemaValidation.valid);
    console.log("-----------------------------------------------------\n");

    if (!schemaValidation.valid) {
      throw new Error(`TaskResponse did not validate against task-response.schema.json: ${schemaValidation.errorsText}`);
    }

    const acceptance = evaluateFullJourneyAcceptance({
      result,
      decisionLog,
      allowedActions: task.safety.allowedActions,
      baseUrl,
      secretValue: process.env.ANTHROPIC_API_KEY,
    });
    if (!acceptance.ok) {
      throw new Error(`Full-journey acceptance failed: ${acceptance.reason}`);
    }
    console.log(`OK: ${acceptance.reason}.`);
  } finally {
    await page.close();
    await browser.close();
    await closeFixtures();
  }
}

main().catch((error) => {
  console.error("Claude full local-journey test failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
