import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRequire } from "node:module";

import { runTask } from "../../src/core/engine.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Active surface tracking scaffolding (Phase 3 PR 2, see CLAUDE.md and
 * docs/architecture.md §25). Confirms observation.activeSurface is present and reports
 * {kind: "main"} on every stored step -- proving the schema/type/loop.ts wiring end to
 * end -- and that a full multi-step run (which never adopts a surface) still validates
 * cleanly against the updated response schema, i.e. this scaffolding changes nothing
 * observable about a run's actual behaviour.
 */

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
    schemaVersion: "1.24.0",
    taskId: "active-surface-observation",
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
    limits: { maxSteps: 6, maxBacktracks: 0 },
    safety: { allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.25.0",
  };
}

test("every stored step's observation.activeSurface reports {kind: main} across a full multi-step run", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = buildTask(baseUrl);
    const response = await runTask({ page, task, reasoning: new MockReasoningProvider() });

    assert.equal(response.status, "success");
    assert.ok(response.steps.length > 0, "expected at least one recorded step");

    for (const step of response.steps) {
      assert.deepEqual(
        step.observation.activeSurface,
        { kind: "main" },
        `expected step ${step.stepIndex}'s observation.activeSurface to be {kind: "main"}`,
      );
    }

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
