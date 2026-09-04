import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { validateTaskRequest, validateTaskResponse } from "./validation.js";
import { executeTaskAsync } from "./runner.js";
import { createTaskStore } from "./taskStoreFactory.js";
import type { TaskStore } from "./taskStore.js";
import { isAuthorized, readApiAuthConfig, type ApiAuthConfig } from "./auth.js";
import { API_VERSION } from "./version.js";
import { readInitialNavigationTimeoutMs } from "../config/initialNavigationConfig.js";
import { readActionNavigationTimeoutMs } from "../config/actionNavigationConfig.js";
import { readDeployedCommitSha } from "../config/deploymentInfo.js";
import { readTaskStoreTimingConfig } from "../config/taskStoreConfig.js";
import { readMaxConcurrentTasks } from "../config/concurrencyConfig.js";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "./concurrencyLimiter.js";

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

function handleConcurrencyLimitReached(res: ServerResponse): void {
  sendJson(res, 503, {
    error: "concurrency_limit_reached",
    message: "The maximum number of concurrently running tasks has been reached. Try again shortly.",
  });
}

async function handleCreateTask(
  req: IncomingMessage,
  res: ServerResponse,
  store: TaskStore,
  limiter: ConcurrencyLimiter,
  initialNavigationTimeoutMs: number,
  actionNavigationTimeoutMs: number,
  heartbeatIntervalMs: number,
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

  // Checked synchronously against readJsonBody/validateTaskRequest already having
  // resolved above, with no await between the capacity check and the increment -- see
  // concurrencyLimiter.ts. Each accepted run launches its own full Chromium instance
  // (src/api/runner.ts), so this is the point that must reject once the configured
  // ceiling is reached, rather than accepting the request and failing later.
  if (!limiter.tryAcquire()) {
    handleConcurrencyLimitReached(res);
    return;
  }

  const task = validation.value;
  const runId = `run_${randomUUID()}`;
  await store.createRun(runId, task.taskId);

  void executeTaskAsync(runId, task, store, initialNavigationTimeoutMs, actionNavigationTimeoutMs, heartbeatIntervalMs).finally(
    () => limiter.release(),
  );

  sendJson(res, 202, { taskId: task.taskId, runId, status: "accepted" });
}

async function handleGetTask(res: ServerResponse, store: TaskStore, runId: string): Promise<void> {
  const record = await store.getRun(runId);
  if (!record) {
    sendJson(res, 404, { error: "not_found", message: `No run found for runId "${runId}".` });
    return;
  }

  if (record.status === "running") {
    sendJson(res, 200, { runId: record.runId, taskId: record.taskId, status: "running" });
    return;
  }

  if (record.status === "stale") {
    // A clear terminal-ish status rather than a 404 or an indefinitely "running" answer:
    // the run's owning process is gone (or the run itself hung) -- see staleDetection.ts.
    // Not a schema-governed field (this wrapper status is outside result), so recognizing
    // it is a caller (e.g. n8n) concern, not a wire-contract version bump.
    sendJson(res, 200, {
      runId: record.runId,
      taskId: record.taskId,
      status: "stale",
      staleReason: record.staleReason ?? "run_stale",
    });
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
  store: TaskStore,
  limiter: ConcurrencyLimiter,
  initialNavigationTimeoutMs: number,
  actionNavigationTimeoutMs: number,
  heartbeatIntervalMs: number,
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
    await handleCreateTask(req, res, store, limiter, initialNavigationTimeoutMs, actionNavigationTimeoutMs, heartbeatIntervalMs);
    return;
  }

  const runMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
  if (req.method === "GET" && runMatch) {
    if (!isAuthorized(req.headers.authorization, authConfig)) {
      handleUnauthorized(res);
      return;
    }
    await handleGetTask(res, store, decodeURIComponent(runMatch[1] ?? ""));
    return;
  }

  sendJson(res, 404, { error: "not_found", message: "Unknown route." });
}

export async function createApiServer(env: NodeJS.ProcessEnv = process.env): Promise<Server> {
  // Read (and, outside test mode, enforce) the bearer token once at server creation —
  // a missing token fails startup clearly rather than the process quietly serving an
  // API that can never authenticate anyone.
  const authConfig = readApiAuthConfig(env);
  // Same fail-fast-at-startup posture for INITIAL_NAVIGATION_TIMEOUT_MS /
  // ACTION_NAVIGATION_TIMEOUT_MS / task-store timing / concurrency: an invalid value
  // aborts server creation clearly rather than surfacing as an opaque per-run failure.
  const initialNavigationTimeoutMs = readInitialNavigationTimeoutMs(env);
  const actionNavigationTimeoutMs = readActionNavigationTimeoutMs(env);
  const timing = readTaskStoreTimingConfig(env);
  const maxConcurrentTasks = readMaxConcurrentTasks(env);
  // Fails fast if TASK_STORE=redis but Redis is unreachable -- see taskStoreFactory.ts.
  const store = await createTaskStore(env);
  const limiter = createConcurrencyLimiter(maxConcurrentTasks);

  return createServer((req, res) => {
    void handleRequest(
      req,
      res,
      authConfig,
      store,
      limiter,
      initialNavigationTimeoutMs,
      actionNavigationTimeoutMs,
      timing.heartbeatIntervalMs,
    ).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal_error", message: "An unexpected error occurred." });
      } else {
        res.end();
      }
    });
  });
}
