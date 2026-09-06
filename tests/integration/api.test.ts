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

// A fixed test-only bearer token — never a real credential. Set before any test creates
// an API server so every createApiServer() call in this file authenticates against it.
const TEST_API_TOKEN = "test-only-navigation-engine-token-do-not-use-in-prod";
process.env.NAVIGATION_ENGINE_API_TOKEN = TEST_API_TOKEN;
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_API_TOKEN}` };

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

async function startApiServer(env?: NodeJS.ProcessEnv) {
  const server = await createApiServer(env);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function buildValidTask(fixturesBaseUrl: string, taskId: string, captureModules: string[] = ["page_visits"]) {
  return {
    schemaVersion: "1.10.0",
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
    outputSchemaVersion: "1.9.0",
  };
}

async function pollUntilTerminal(apiBaseUrl: string, runId: string, timeoutMs = 30000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${apiBaseUrl}/v1/tasks/${runId}`, { headers: AUTH_HEADERS });
    const body = await res.json();
    if (body.status === "completed" || body.status === "failed") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${timeoutMs}ms`);
}

test("GET /v1/health reports availability without authentication and without leaking environment details", async () => {
  const previousRender = process.env.RENDER_GIT_COMMIT;
  const previousGeneric = process.env.GIT_COMMIT_SHA;
  delete process.env.RENDER_GIT_COMMIT;
  delete process.env.GIT_COMMIT_SHA;
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.service, "navigation-engine");
    assert.equal(typeof body.version, "string");
    // No RENDER_GIT_COMMIT/GIT_COMMIT_SHA set in this test -- the optional `commit` field
    // must be entirely absent, not present-as-undefined/null, and no other environment
    // detail leaks in either.
    assert.equal(Object.keys(body).sort().join(","), "service,status,version");
  } finally {
    await api.close();
    if (previousRender !== undefined) process.env.RENDER_GIT_COMMIT = previousRender;
    if (previousGeneric !== undefined) process.env.GIT_COMMIT_SHA = previousGeneric;
  }
});

test("GET /v1/health exposes the deployed commit SHA when the deployment platform provides RENDER_GIT_COMMIT", async () => {
  const previousRender = process.env.RENDER_GIT_COMMIT;
  const previousGeneric = process.env.GIT_COMMIT_SHA;
  delete process.env.GIT_COMMIT_SHA;
  process.env.RENDER_GIT_COMMIT = "abc123deadbeef0000000000000000000000001";
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/health`);
    const body = await res.json();
    assert.equal(body.commit, "abc123deadbeef0000000000000000000000001");
  } finally {
    await api.close();
    if (previousRender === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = previousRender;
    if (previousGeneric !== undefined) process.env.GIT_COMMIT_SHA = previousGeneric;
  }
});

test("GET /v1/health falls back to the generic GIT_COMMIT_SHA when RENDER_GIT_COMMIT is not set (non-Render deployments)", async () => {
  const previousRender = process.env.RENDER_GIT_COMMIT;
  const previousGeneric = process.env.GIT_COMMIT_SHA;
  delete process.env.RENDER_GIT_COMMIT;
  process.env.GIT_COMMIT_SHA = "fedcba9876543210000000000000000000000002";
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/health`);
    const body = await res.json();
    assert.equal(body.commit, "fedcba9876543210000000000000000000000002");
  } finally {
    await api.close();
    if (previousRender !== undefined) process.env.RENDER_GIT_COMMIT = previousRender;
    if (previousGeneric === undefined) delete process.env.GIT_COMMIT_SHA;
    else process.env.GIT_COMMIT_SHA = previousGeneric;
  }
});

test("POST /v1/tasks rejects a request with no Authorization header with 401", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const api = await startApiServer();
  try {
    const task = buildValidTask(fixtures.baseUrl, "api-poc-no-auth");
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(task),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
    const rawBody = JSON.stringify(body);
    assert.ok(!rawBody.includes(TEST_API_TOKEN));
  } finally {
    await api.close();
    await fixtures.close();
  }
});

test("POST /v1/tasks rejects a request with an invalid bearer token with 401", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const api = await startApiServer();
  try {
    const task = buildValidTask(fixtures.baseUrl, "api-poc-bad-auth");
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer not-the-right-token" },
      body: JSON.stringify(task),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
  } finally {
    await api.close();
    await fixtures.close();
  }
});

test("POST /v1/tasks rejects a malformed Authorization header (missing Bearer scheme) with 401", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const api = await startApiServer();
  try {
    const task = buildValidTask(fixtures.baseUrl, "api-poc-malformed-auth");
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: TEST_API_TOKEN },
      body: JSON.stringify(task),
    });
    assert.equal(res.status, 401);
  } finally {
    await api.close();
    await fixtures.close();
  }
});

test("GET /v1/tasks/:runId requires authentication", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks/run_does-not-exist`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error, "unauthorized");
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
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
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

    // Task requirement #9: the completed task result includes the reasoning-provider
    // usage diagnostics. The API defaults to REASONING_PROVIDER unset, i.e. the mock
    // provider, so usage must be clearly zero and never mistaken for real Claude usage.
    const reasoningDiagnostics = finalBody.result.diagnostics.reasoningProvider;
    assert.ok(reasoningDiagnostics, "expected diagnostics.reasoningProvider on the completed result");
    assert.equal(reasoningDiagnostics.provider, "mock");
    assert.equal(reasoningDiagnostics.callCount, 0);
    assert.equal(reasoningDiagnostics.totalInputTokens, 0);
    assert.equal(reasoningDiagnostics.totalOutputTokens, 0);

    await validateAgainstResponseSchema(finalBody.result);

    // Credentials must never leak into a response body, on success or otherwise.
    assert.ok(!JSON.stringify(created).includes(TEST_API_TOKEN));
    assert.ok(!JSON.stringify(finalBody).includes(TEST_API_TOKEN));
  } finally {
    await api.close();
    await fixtures.close();
  }
});

test("POST /v1/tasks rejects malformed JSON with 400 once authenticated", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: "{ this is not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_json");
  } finally {
    await api.close();
  }
});

test("POST /v1/tasks rejects a task request that fails schema validation with 400 once authenticated", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
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

test("POST /v1/tasks rejects an unsupported content type with 415 once authenticated", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...AUTH_HEADERS },
      body: "not json",
    });
    assert.equal(res.status, 415);
  } finally {
    await api.close();
  }
});

test("GET /v1/tasks/:runId returns 404 for an unknown runId once authenticated", async () => {
  const api = await startApiServer();
  try {
    const res = await fetch(`${api.baseUrl}/v1/tasks/run_does-not-exist`, { headers: AUTH_HEADERS });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.error, "not_found");
  } finally {
    await api.close();
  }
});
