import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { validateTaskRequest, validateTaskResponse } from "./validation.js";
import { executeTaskAsync } from "./runner.js";
import * as taskStore from "./taskStore.js";
import { isAuthorized, readApiAuthConfig, type ApiAuthConfig } from "./auth.js";
import { API_VERSION } from "./version.js";
import { readInitialNavigationTimeoutMs } from "../config/initialNavigationConfig.js";
import { readActionNavigationTimeoutMs } from "../config/actionNavigationConfig.js";
import { readDeployedCommitSha } from "../config/deploymentInfo.js";

const MAX_BODY_BYTES = 256 * 1024;

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (!contentType) return false;
  return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

type BodyResult = { ok: true; body: unknown } | { ok: false; status: number; error: string; message: string };

async function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    totalBytes += buf.length;
    if (totalBytes > MAX_BODY_BYTES) {
      return {
        ok: false,
        status: 413,
        error: "payload_too_large",
        message: `Request body exceeds the ${MAX_BODY_BYTES}-byte limit.`,
      };
    }
    chunks.push(buf);
  }

  if (totalBytes === 0) {
    return { ok: false, status: 400, error: "empty_body", message: "Request body must not be empty." };
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, status: 400, error: "invalid_json", message: "Request body is not valid JSON." };
  }
}

function handleHealth(res: ServerResponse): void {
  // Deliberately minimal: status, service name, API version, and (when the deployment
  // platform provides it) the deployed commit SHA -- never any other environment
  // variable, dependency version, filesystem path, secret, or configuration value. The
  // commit SHA is not a secret (it is already public in the repository's own git
  // history); it exists purely so an operator investigating a live run can confirm which
  // commit is actually serving traffic without separate shell/log access.
  const commit = readDeployedCommitSha();
  sendJson(res, 200, {
    status: "ok",
    service: "navigation-engine",
    version: API_VERSION,
    ...(commit ? { commit } : {}),
  });
}

function handleUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    error: "unauthorized",
    message: "A valid Authorization: Bearer <token> header is required.",
  });
}

async function handleCreateTask(
  req: IncomingMessage,
  res: ServerResponse,
  initialNavigationTimeoutMs: number,
  actionNavigationTimeoutMs: number,
): Promise<void> {
  if (!hasJsonContentType(req)) {
    sendJson(res, 415, {
      error: "unsupported_media_type",
      message: "Content-Type must be application/json.",
    });
    return;
  }

  const bodyResult = await readJsonBody(req);
  if (!bodyResult.ok) {
    sendJson(res, bodyResult.status, { error: bodyResult.error, message: bodyResult.message });
    return;
  }

  const validation = validateTaskRequest(bodyResult.body);
  if (!validation.valid || !validation.value) {
    sendJson(res, 400, {
      error: "invalid_task_request",
      message: "Task request failed schema validation.",
      details: validation.errors,
    });
    return;
  }

  const task = validation.value;
  const runId = `run_${randomUUID()}`;
  taskStore.createRun(runId, task.taskId);

  void executeTaskAsync(runId, task, initialNavigationTimeoutMs, actionNavigationTimeoutMs);

  sendJson(res, 202, { taskId: task.taskId, runId, status: "accepted" });
}

function handleGetTask(res: ServerResponse, runId: string): void {
  const record = taskStore.getRun(runId);
  if (!record) {
    sendJson(res, 404, { error: "not_found", message: `No run found for runId "${runId}".` });
    return;
  }

  if (record.status === "running") {
    sendJson(res, 200, { runId: record.runId, taskId: record.taskId, status: "running" });
    return;
  }

  if (record.status === "failed") {
    sendJson(res, 200, {
      runId: record.runId,
      taskId: record.taskId,
      status: "failed",
      error: record.error ?? "Task execution failed.",
    });
    return;
  }

  const responseValidation = validateTaskResponse(record.result);
  if (!responseValidation.valid) {
    sendJson(res, 500, {
      error: "internal_error",
      message: "The completed result did not match the expected response schema.",
    });
    return;
  }

  sendJson(res, 200, {
    runId: record.runId,
    taskId: record.taskId,
    status: "completed",
    result: responseValidation.value,
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authConfig: ApiAuthConfig,
  initialNavigationTimeoutMs: number,
  actionNavigationTimeoutMs: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://internal.invalid");

  if (req.method === "GET" && url.pathname === "/v1/health") {
    handleHealth(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/tasks") {
    if (!isAuthorized(req.headers.authorization, authConfig)) {
      handleUnauthorized(res);
      return;
    }
    await handleCreateTask(req, res, initialNavigationTimeoutMs, actionNavigationTimeoutMs);
    return;
  }

  const runMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && runMatch) {
    if (!isAuthorized(req.headers.authorization, authConfig)) {
      handleUnauthorized(res);
      return;
    }
    handleGetTask(res, decodeURIComponent(runMatch[1] ?? ""));
    return;
  }

  sendJson(res, 404, { error: "not_found", message: "Unknown route." });
}

export function createApiServer(env: NodeJS.ProcessEnv = process.env): Server {
  // Read (and, outside test mode, enforce) the bearer token once at server creation —
  // a missing token fails startup clearly rather than the process quietly serving an
  // API that can never authenticate anyone.
  const authConfig = readApiAuthConfig(env);
  // Same fail-fast-at-startup posture for INITIAL_NAVIGATION_TIMEOUT_MS /
  // ACTION_NAVIGATION_TIMEOUT_MS: an invalid value aborts server creation clearly rather
  // than surfacing as an opaque per-run failure.
  const initialNavigationTimeoutMs = readInitialNavigationTimeoutMs(env);
  const actionNavigationTimeoutMs = readActionNavigationTimeoutMs(env);
  return createServer((req, res) => {
    void handleRequest(req, res, authConfig, initialNavigationTimeoutMs, actionNavigationTimeoutMs).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: "An unexpected error occurred." });
      } else {
        res.end();
      }
    });
  });
}
