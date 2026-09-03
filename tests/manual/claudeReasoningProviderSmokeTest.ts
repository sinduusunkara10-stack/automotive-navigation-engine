/**
 * Manual smoke test for ClaudeReasoningProvider — NOT part of `npm test` / `npm run
 * check`, and never run automatically. Run explicitly with:
 *
 *   REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run smoke:claude
 *
 * This is the only place in the repo that makes a real, billed call to the Claude API.
 * It only runs when both REASONING_PROVIDER=claude and ANTHROPIC_API_KEY are set; it
 * only ever navigates the local fictional HTML fixture under tests/fixtures/ (never a
 * real website, n8n, Google Sheets, or BigQuery); and it caps the task at maxSteps: 1
 * so it makes exactly one Claude API call — the minimum needed to prove the real
 * integration (prompt -> structured decision -> validated SelectedAction) end to end.
 *
 * This proves ONE Claude decision works safely; it does not attempt the full multi-page
 * fictional journey. Pass/fail is judged against ClaudeReasoningProvider's decision log
 * (exactly one accepted, schema-valid, in-vocabulary decision with no retry and no leaked
 * secret — see evaluateSmokeTestAcceptance in ./smokeTestAcceptance.ts), not against the
 * engine's final run status: with maxSteps: 1, the engine is expected to end the run with
 * status "max_steps_reached" right after that one accepted decision, and that is not a
 * failure of this smoke test.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { createReasoningProvider } from "../../src/reasoning/providerFactory.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { evaluateSmokeTestAcceptance } from "./smokeTestAcceptance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

async function main(): Promise<void> {
  if (process.env.REASONING_PROVIDER !== "claude") {
    console.log(
      'Skipping: this smoke test only runs when REASONING_PROVIDER=claude. ' +
        "(Run: REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run smoke:claude)",
    );
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log("Skipping: ANTHROPIC_API_KEY is not set. This test never runs without a real key present.");
    return;
  }

  console.log(
    "This will make exactly one real, billed call to the Claude API " +
      `(model: ${process.env.CLAUDE_MODEL ?? "claude-sonnet-5 (default)"}), against the local ` +
      "fictional fixture only. No real website, n8n, Google Sheets, or BigQuery is involved.",
  );

  const reasoning = createReasoningProvider();
  if (!(reasoning instanceof ClaudeReasoningProvider)) {
    throw new Error("Expected createReasoningProvider() to return a ClaudeReasoningProvider here.");
  }

  const { baseUrl, close: closeFixtures } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.5.0",
      taskId: "claude-provider-smoke-test",
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
      captureModules: [],
      // maxSteps: 1 bounds this run to exactly one reasoning.decide() call (see
      // src/core/loop.ts — the limits guard runs before decide() on each step), which
      // is the minimum number of real model calls needed to prove the integration.
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.5.0",
    };

    const result = await runTask({ page, task, reasoning });

    console.log("\n--- Claude reasoning provider smoke test result ---");
    console.log("status:", result.status);
    console.log("steps:", result.steps.length);
    const firstStep = result.steps[0];
    if (firstStep) {
      console.log("decision:", firstStep.decision);
      console.log("selectedAction:", JSON.stringify(firstStep.selectedAction));
    }
    const decisionLog = reasoning.getDecisionLog();
    console.log("decision log:", JSON.stringify(decisionLog, null, 2));
    console.log("final engine status:", result.status, `(finishReason: ${result.diagnostics.finishReason})`);
    console.log("----------------------------------------------------\n");

    const acceptance = evaluateSmokeTestAcceptance({
      decisionLog,
      steps: result.steps,
      allowedActions: task.safety.allowedActions,
      secretValue: process.env.ANTHROPIC_API_KEY,
    });
    if (!acceptance.ok) {
      throw new Error(`Smoke test acceptance failed: ${acceptance.reason}`);
    }
    console.log(`OK: ${acceptance.reason}.`);
    console.log(
      `(Final engine status "${result.status}" after the one accepted decision is expected under ` +
        "maxSteps: 1 and is not itself a failure of this one-decision smoke test.)",
    );
  } finally {
    await page.close();
    await browser.close();
    await closeFixtures();
  }
}

main().catch((error) => {
  console.error("Claude reasoning provider smoke test failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
