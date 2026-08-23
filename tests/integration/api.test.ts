import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";

import { createApiServer } from "../../src/api/server.js";
import { startStaticServer } from "../helpers/staticServer.js";

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

async function startApiServer() {
  const server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function buildValidTask(fixturesBaseUrl: string, taskId: string, captureModules: string[] = ["page_visits"]) {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Reach the fixture's success page by following the visible continue control.",
    startUrl: `${fixturesBaseUrl}/start.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        config: { pattern: `${fixturesBaseUrl}/success.html` },
      },
    ],
    captureModules,
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.0.0",
  };
}

async function pollUntilTerminal(apiBaseUrl: string, runId: string, timeoutMs = 30000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiBaseUrl}/v1/tasks/${runId}`);
    const body = await res.json();
    if (body.status === "completed" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

test("GET /v1/health reports availability without leaking environment details", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.time, "string");
    assert.equal(Object.keys(body).sort().join(","), "service,status,time");
  } finally {
    await api.close();
  }
});

test("POST /v1/tasks accepts a valid task request and GET /v1/tasks/:runId returns a schema-valid completed result", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const api = await startApiServer();
  try {
    const task = buildValidTask(fixtures.baseUrl, "api-poc-success", [
      "page_visits",
      "cta_clicks",
      "journey_path",
      "finish_page_ctas",
    ]);

    const createRes = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    assert.equal(createRes.status, 202);
    const created = await createRes.json();
    assert.equal(created.taskId, "api-poc-success");
    assert.ok(created.runId.startsWith("run_"));
    assert.equal(created.status, "accepted");

    const finalBody = await pollUntilTerminal(api.baseUrl, created.runId);
    assert.equal(finalBody.status, "completed");
    assert.equal(finalBody.result.status, "success");
    assert.equal(finalBody.result.finalUrl, `${fixtures.baseUrl}/success.html`);

    assert.ok(finalBody.result.captures.page_visits?.length > 0);
    assert.ok(finalBody.result.captures.cta_clicks?.length > 0);
    assert.ok(finalBody.result.captures.journey_path?.length > 0);
    assert.ok(finalBody.result.captures.finish_page_ctas?.length > 0);

    await validateAgainstResponseSchema(finalBody.result);
  } finally {
    await api.close();
    await fixtures.close();
  }
});

test("POST /v1/tasks rejects malformed JSON with 400", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ this is not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_json");
  } finally {
    await api.close();
  }
});

test("POST /v1/tasks rejects a task request that fails schema validation with 400", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: "missing-required-fields" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_task_request");
    assert.ok(Array.isArray(body.details) && body.details.length > 0);
  } finally {
    await api.close();
  }
});

test("POST /v1/tasks rejects an unsupported content type with 415", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not json",
    });
    assert.equal(res.status, 415);
  } finally {
    await api.close();
  }
});

test("GET /v1/tasks/:runId returns 404 for an unknown runId", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks/run_does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "not_found");
  } finally {
    await api.close();
  }
});
