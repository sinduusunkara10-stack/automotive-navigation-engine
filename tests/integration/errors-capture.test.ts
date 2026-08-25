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

const SENSITIVE_PATTERN = /cookie|authorization|password|secret|api[_-]?key|bearer\s|passwd/i;

test("errors capture module records page JS errors, console errors, failed network requests, and a failed action", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.2.0",
      taskId: "errors-capture-diagnostics",
      objective: "Attempt to reach an unreachable success state on a fixture that emits fictional failures.",
      startUrl: `${baseUrl}/errors-start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/errors-unreachable.html` },
        },
      ],
      captureModules: ["errors"],
      limits: { maxSteps: 3, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.2.0",
    };

    const response = await runTask({ page, task });

    // The click's only target is intercepted by an overlay, so the click action itself
    // fails and the run stops after a single step.
    assert.equal(response.status, "failure");
    assert.equal(response.steps.length, 1);

    const errors = response.captures.errors ?? [];
    assert.ok(errors.length > 0, "expected diagnostics to be captured");

    const jsError = errors.find((e) => e.category === "page_js_error");
    assert.ok(jsError, "expected a page_js_error diagnostic");
    assert.equal(jsError?.severity, "error");
    assert.equal(jsError?.recoverable, true);
    assert.equal(jsError?.stoppedRun, false);
    assert.equal(jsError?.pageUrl, `${baseUrl}/errors-start.html`);
    assert.ok(jsError?.message.includes("fictionalUndefinedFn"), "expected the fictional function name in the message");

    const consoleError = errors.find((e) => e.category === "console_error");
    assert.ok(consoleError, "expected a console_error diagnostic");
    assert.equal(consoleError?.severity, "warning");
    assert.equal(consoleError?.recoverable, true);
    assert.equal(consoleError?.stoppedRun, false);
    assert.ok(consoleError?.message.includes("Fictional console error"));

    const networkFailure = errors.find(
      (e) => e.category === "network_request_failed" && e.message.includes("fictional-missing-endpoint.json"),
    );
    assert.ok(networkFailure, "expected a network_request_failed diagnostic for the fictional missing endpoint");
    assert.equal(networkFailure?.severity, "warning");
    assert.equal(networkFailure?.recoverable, true);
    assert.equal(networkFailure?.stoppedRun, false);
    assert.ok(networkFailure?.message.includes("404"));

    const actionFailure = errors.find((e) => e.category === "action_timeout" || e.category === "action_execution_failure");
    assert.ok(actionFailure, "expected a failed-action diagnostic for the intercepted click");
    assert.equal(actionFailure?.severity, "critical");
    assert.equal(actionFailure?.recoverable, false);
    assert.equal(actionFailure?.stoppedRun, true);
    assert.equal(actionFailure?.actionType, "click");
    assert.ok(actionFailure?.targetElementId, "expected the click's target element id to be recorded");
    assert.equal(actionFailure?.stepIndex, 0);

    // Recoverable and run-stopping diagnostics must be distinguishable within the same
    // capture: the browser-observed diagnostics above did not stop the run, the action
    // failure did.
    assert.ok(errors.some((e) => e.recoverable === true && e.stoppedRun === false));
    assert.ok(errors.some((e) => e.recoverable === false && e.stoppedRun === true));

    // No cookies, auth headers, request bodies, credentials, tokens, or raw stack traces.
    for (const entry of errors) {
      assert.ok(!("stack" in entry), "diagnostic entries must never carry a raw stack trace");
      assert.doesNotMatch(entry.message, SENSITIVE_PATTERN, `unexpected sensitive content in: ${entry.message}`);
    }

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("errors capture module records a limit_stop diagnostic when maxSteps is reached", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.2.0",
      taskId: "errors-capture-limit-stop",
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
      captureModules: ["errors"],
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
      outputSchemaVersion: "1.2.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "max_steps_reached");

    const errors = response.captures.errors ?? [];
    const limitStop = errors.find((e) => e.category === "limit_stop");
    assert.ok(limitStop, "expected a limit_stop diagnostic");
    assert.equal(limitStop?.severity, "critical");
    assert.equal(limitStop?.recoverable, false);
    assert.equal(limitStop?.stoppedRun, true);
    assert.equal(typeof limitStop?.stepIndex, "number");

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("errors capture module records nothing when not requested, even on a page that emits fictional failures", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.2.0",
      taskId: "errors-capture-not-requested",
      objective: "Attempt to reach an unreachable success state on a fixture that emits fictional failures.",
      startUrl: `${baseUrl}/errors-start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/errors-unreachable.html` },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 3, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.2.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "failure");
    assert.equal(response.captures.errors, undefined);

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
