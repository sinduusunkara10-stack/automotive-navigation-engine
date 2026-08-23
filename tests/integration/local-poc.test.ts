import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRequire } from "node:module";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");

// ajv and ajv-formats ship CJS builds whose ESM default-import types don't resolve
// cleanly under NodeNext interop; loading them via createRequire sidesteps that.
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

test("navigation engine observes, decides, acts, reaches success, and produces a schema-valid response", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-success",
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
      limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: {
        allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/success.html`);
    assert.ok(response.steps.length >= 2, "expected at least a click step and a stop step");
    assert.equal(response.steps[0]?.selectedAction.type, "click");
    assert.equal(response.steps[0]?.observation.interactiveElements[0]?.accessibleName, "Continue");
    assert.equal(response.steps[0]?.selectedAction.target, response.steps[0]?.observation.interactiveElements[0]?.id);
    assert.ok(response.captures.page_visits && response.captures.page_visits.length > 0);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.equal(response.diagnostics.finishReason, "stop_success_action");

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("safety layer blocks a task whose startUrl falls outside allowedDomains", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-blocked",
      objective: "Attempt to run against a host outside the allow-list.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["example-not-this-host.invalid"],
      successCriteria: [
        { id: "never", type: "url_pattern", description: "Never satisfied.", config: { pattern: "**/never.html" } },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 5, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 0);
    assert.equal(response.diagnostics.finishReason, "domain_blocked");

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("limits guard stops the run once maxSteps is reached without a success state", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-max-steps",
      objective: "Reach an unreachable success state so the step ceiling is exercised.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/unreachable.html` },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "max_steps_reached");
    assert.equal(response.steps.length, 2);
    assert.equal(response.steps[0]?.selectedAction.type, "click");
    assert.ok(response.steps[1]?.safetyFlags?.includes("max_steps"));

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
