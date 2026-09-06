import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Engine-level (not just evaluator-level) coverage that the new semantic_page_match
 * criterion never changes domain trust: even a task carrying a semantic criterion that
 * would happily match the fixture's own page content must still be blocked before that
 * content is ever evaluated, once the caller has pinned allowedDomains to something that
 * excludes startUrl. Preflight domain discovery and its frozen allowlist stay authoritative
 * for every criterion type, including this new one.
 */
test("an unrelated/untrusted domain is blocked before any success criterion -- including semantic_page_match -- is ever evaluated", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.10.0",
      taskId: "semantic-criterion-domain-blocked",
      objective: "Reach the welcome page.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["example-not-this-host.invalid"],
      successCriteria: [
        {
          id: "reached-welcome",
          type: "semantic_page_match",
          description: "The page welcomes the visitor.",
          config: { minScore: 0.01 },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 5, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.9.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 0, "the run must be blocked before any step -- and so before any criterion is evaluated");
    assert.equal(response.diagnostics.finishReason, "domain_blocked");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

/**
 * Positive counterpart: on a trusted domain, semantic_page_match participates in the same
 * navigate/observe/decide/act/check-success loop as any other criterion type and can drive
 * the run to stop_success -- using only startUrl, objective, and page observations, no
 * selector or URL pattern.
 */
test("semantic_page_match drives a full run to stop_success on the trusted start domain", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.10.0",
      taskId: "semantic-criterion-success",
      objective:
        "Reach the final page and stop once the journey is complete and the success state is confirmed.",
      startUrl: `${baseUrl}/semantic-start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "reached-success-state",
          type: "semantic_page_match",
          description: "The journey is complete and the success state has been reached.",
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: {
        allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
      outputSchemaVersion: "1.9.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/semantic-success.html`);
    assert.equal(response.diagnostics.finishReason, "stop_success_action");
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("reached-success-state"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
