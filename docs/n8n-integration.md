# n8n Integration

n8n is the external orchestrator. It owns triggering, forms, human review, Google Sheets,
BigQuery, and reporting. The navigation engine's job is narrow and mechanical: accept a
validated task, run the navigate/observe/decide/act loop, and return a validated result. This
document describes the HTTP contract between the two, at the design level — no server exists
yet (see `docs/v1-scope.md`).

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

## 3. Proposed endpoints (not yet implemented)

```
POST /v1/tasks
```
Submits a new task-request. Because a configurator journey can take minutes, this endpoint is
expected to respond quickly with a run handle rather than blocking for the full run:

```json
{ "taskId": "example-configurator-journey-0001", "runId": "run_...", "status": "accepted" }
```

```
GET /v1/tasks/{runId}
```
Returns the current state: `running`, or a terminal `task-response` body once the run has
finished (`status` field per the response schema: `success`, `blocked`, `failure`,
`max_steps_reached`, `max_backtracks_reached`, `max_duration_reached`).

```
GET /v1/health
```
Basic liveness/readiness check for n8n to gate scheduled workflows on.

### Sync vs. async (open decision)

Submit-and-poll (above) is the proposed default so n8n's HTTP Request node isn't held open for
the duration of a multi-minute journey. A webhook-callback variant (engine POSTs the finished
`task-response` back to an n8n webhook URL supplied in the request's `metadata`) is a
reasonable alternative and is easy to add later without breaking the schema — it's a delivery
mechanism, not a contract change. This is listed as an unresolved decision in
`docs/v1-scope.md`.

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

## 5. Authentication (open decision)

No auth mechanism is finalized yet (see `docs/v1-scope.md`, open decision #1). Candidates:

- A shared-secret bearer token, provided to n8n and the engine via environment variables on
  each side — never committed to source control.
- Network-level trust (engine only reachable from n8n's own network/VPC), with no
  application-level auth.

Whichever is chosen, **no credential of any kind is stored in this repository**. Both n8n and
the engine read secrets from their own runtime environment/secret store.

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
