# n8n Integration

n8n is the external orchestrator. It owns triggering, forms, human review, Google Sheets,
BigQuery, and reporting. The navigation engine's job is narrow and mechanical: accept a
validated task, run the navigate/observe/decide/act loop, and return a validated result. This
document describes the HTTP contract between the two.

**Current status:** a minimal HTTP server implementing this contract exists (`src/api`, see
`README.md` §"Local HTTP API"), with a Docker image for deployment (see `README.md` §"Docker").
It defaults to the mock reasoning provider against local fixtures/target URLs, and requires a
bearer token on both task endpoints (§5). It still stores runs **in-memory only** — see §8 —
so before pointing a real n8n instance at a deployed instance, confirm that limitation is
acceptable for your workflow (typically: short-lived runs, one engine instance, and n8n polling
promptly enough that a restart between submit and poll is unlikely/acceptable).

## 1. Roles

- **n8n**: builds a `task-request` JSON per run (from a form, a schedule, or a Sheets row),
  calls the engine's HTTP API, receives a `task-response` JSON, and fans the result out to
  Sheets/BigQuery/Slack/etc.
- **Engine**: stateless with respect to orchestration — it does not know about forms, sheets,
  or schedules. It validates the incoming request against `schemas/task-request.schema.json`,
  runs the loop, and returns a response validated against
  `schemas/task-response.schema.json`.

## 2. Request/response contracts

The wire format is exactly the JSON Schemas in `/schemas`:

- Request body: `schemas/task-request.schema.json`, worked examples in `/examples`.
- Response body: `schemas/task-response.schema.json`.

Both sides should validate against these schemas — n8n before sending (fail fast on a
malformed task) and the engine on receipt (never trust the network boundary). `schemaVersion`
and `outputSchemaVersion` in the request let both sides detect a contract mismatch explicitly
rather than failing on unexpected fields later in the run.

## 3. Endpoints (implemented as a local proof of concept)

```
POST /v1/tasks
```
Submits a new task-request. Because a configurator journey can take minutes, this endpoint
responds quickly with a run handle rather than blocking for the full run — the current
implementation starts the run in the background and returns immediately:

```json
{ "taskId": "example-configurator-journey-0001", "runId": "run_...", "status": "accepted" }
```

A body that isn't valid JSON, isn't `Content-Type: application/json`, or fails
`task-request.schema.json` validation is rejected (`400`/`415`) and no run is started.

```
GET /v1/tasks/{runId}
```
Returns `{ "status": "running" }` while the run is in progress, `{ "status": "failed", "error": "..." }`
if the engine could not produce a result at all, or `{ "status": "completed", "result": <task-response> }`
once finished — `result` is the same `task-response` body described below (`status` field per
the response schema: `success`, `blocked`, `failure`, `max_steps_reached`,
`max_backtracks_reached`, `max_duration_reached`). An unknown `runId` returns `404`.

```
GET /v1/health
```
Basic liveness/readiness check for n8n to gate scheduled workflows on, and what the container's
`HEALTHCHECK` calls. Unauthenticated by design. Returns only `{ status, service, version }` — no
environment details, dependency versions, filesystem paths, or secrets.

**Not yet implemented:** a durable/shared task store (runs are in-memory and lost on restart —
see §8 and `README.md`), queues, webhooks, dashboards, cloud-vendor-specific deployment files,
and rate limiting. None of these are wired up in this phase.

### Sync vs. async (resolved for the local proof of concept)

Submit-and-poll (above) is what's implemented, so n8n's HTTP Request node isn't held open for
the duration of a multi-minute journey. A webhook-callback variant (engine POSTs the finished
`task-response` back to an n8n webhook URL supplied in the request's `metadata`) is a
reasonable alternative and is easy to add later without breaking the schema — it's a delivery
mechanism, not a contract change. Not implemented in this phase.

## 4. Error handling

- **Request fails schema validation**: engine returns `400` with a validation error list; no
  run is started. n8n should treat this as a workflow-config bug, not retry blindly.
- **Run stops via a safety guardrail** (`blocked`) or exhausts a limit (`max_steps_reached`,
  `max_backtracks_reached`, `max_duration_reached`): this is a normal, schema-valid
  `task-response`, not an HTTP error. n8n branches on `status` to decide what to do next (e.g.
  alert a human, log as inconclusive).
- **Engine crashes mid-run** (unhandled error, browser crash): the engine should still attempt
  to return a best-effort `task-response` with `status: "failure"`, a populated
  `diagnostics.finishReason`, and any captures/screenshots gathered up to that point, rather
  than only a bare HTTP `500`. A `500` is reserved for cases where no response body could be
  constructed at all.

## 5. Authentication

`POST /v1/tasks` and `GET /v1/tasks/:runId` require a shared-secret bearer token
(`src/api/auth.ts`), resolving open decision #1 in `docs/v1-scope.md`. Configure it via the
`NAVIGATION_ENGINE_API_TOKEN` environment variable on the engine side, and have the n8n HTTP
Request node send the same value:

```
Authorization: Bearer <NAVIGATION_ENGINE_API_TOKEN>
```

In n8n, store the token as an n8n credential (or environment-backed expression), never as a
literal value pasted into the workflow JSON, and set that credential's header on both the
`POST /v1/tasks` and `GET /v1/tasks/:runId` HTTP Request nodes. `GET /v1/health` needs no
header.

Missing, malformed, or incorrect credentials get `401` — the comparison is constant-time and
the response body/logs never reveal whether a submitted token was close to correct. The engine
process itself refuses to start if `NAVIGATION_ENGINE_API_TOKEN` is unset outside its test
suite, so a misconfigured deployment fails at boot rather than serving a route nothing can
authenticate against.

**No credential of any kind is stored in this repository.** Both n8n and the engine read
`NAVIGATION_ENGINE_API_TOKEN`/`ANTHROPIC_API_KEY` from their own runtime environment — in a
real deployment, **from the hosting platform's own secret manager** (e.g. its
environment/secret store), never from a file baked into the Docker image or committed to
source. See `README.md` §"Docker" for how the token is passed into a container at run time.

## 6. What n8n is expected to own downstream of the engine

- Turning `captures.*` arrays into rows in Google Sheets / BigQuery tables.
- Turning `engineAssessment` (objective achieved, confidence, summary) into pass/fail signals
  for reporting or alerting.
- Retrying a task (the engine does not auto-retry a finished run; re-submission is a new
  `task-request`, typically with the same `taskId` semantics left to n8n's convention).
- Any human-in-the-loop review, e.g. surfacing a `blocked` or `failure` result for manual
  follow-up.
- Long-term storage/retention of screenshots and other artifact references returned in
  `captures` (the engine returns references, not binaries, per `docs/v1-scope.md` assumptions).

## 7. Versioning expectations

`schemaVersion` (request) and the response's `schemaVersion` are independent, exact-match
version strings (e.g. `"1.0.0"`). A breaking change to either contract bumps that version and
should be treated by n8n as a distinct integration to test, not an in-place upgrade. Additive,
backward-compatible fields (e.g. a new optional capture module) can ship under the same major
version once the project adopts semantic versioning conventions for the schemas — not yet
formalized in v1.

**Example (already applied):** adding `diagnostics.reasoningProvider` to the response bumped the
response contract's `schemaVersion` and the request's `outputSchemaVersion` from `"1.0.0"` to
`"1.1.0"` (both are still exact-match `const`s, not a range, so an n8n workflow pinned to
`"1.0.0"` must update the value it sends). The change itself is additive — no existing response
field was removed or renamed, and `diagnostics.reasoningProvider` is itself independently
versioned (see README "Reasoning provider usage diagnostics") so it can evolve again without
necessarily forcing another top-level `schemaVersion` bump.

**Example (already applied, again):** adding preflight domain discovery (see
`docs/architecture.md` "Preflight domain discovery") made the request's `allowedDomains` field
optional and added an optional `journeyType` field, bumping the request contract's own
`schemaVersion` from `"1.0.0"` to `"1.1.0"`. The additive `diagnostics.domainDiscovery`
structure on the response bumped the response contract's `schemaVersion` and the request's
`outputSchemaVersion` from `"1.1.0"` to `"1.2.0"`, the same way as the reasoningProvider example
above. An n8n workflow that already sends an explicit `allowedDomains` list keeps working
unchanged (it is still honored, unioned with whatever preflight discovery itself proposes) —
only the version strings themselves need updating.

## 8. Task store and instance limitations

Runs are held in an in-memory `Map` (`src/api/taskStore.ts`) with **no persistence**:

- **All run state is lost when the process/container restarts.** A run n8n submitted and hasn't
  polled to completion yet disappears on restart; n8n sees `404` on the next poll and should
  treat that as "unknown/lost run", not retry the same `runId`.
- **Run one engine instance.** Because the store isn't shared, a second instance behind a load
  balancer would never see runs created on the first — `POST /v1/tasks` and the later
  `GET /v1/tasks/:runId` poll must land on the same instance.
- **Before scaling to multiple instances**, add a persistent or shared task store (e.g. a
  database or shared cache keyed by `runId`) that every instance reads and writes — this is a
  known, deliberate v1 gap, not an oversight, and out of scope for this phase (see
  `docs/v1-scope.md`).

n8n workflows built against this engine should assume runs are ephemeral: poll promptly after
submission, and design for an occasional lost run (engine restart, deploy) the same way they'd
handle any other transient infrastructure failure.
