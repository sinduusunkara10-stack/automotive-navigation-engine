# Generic Navigation Engine

A reusable, Claude-powered Playwright navigation engine for digital analytics, website
intelligence, and journey discovery. It runs a fixed loop —
`navigate -> observe -> decide -> act -> check success -> repeat` — against a caller-supplied
JSON task, driven by a controlled action vocabulary rather than free-form generated code.

**Automotive journey intelligence is the first use case** (configurator journey discovery,
GA4 tag capture, competitor offer monitoring), but the core engine is domain-agnostic by
design: it must not be hardcoded for automotive sites, any specific configurator, GA4, or any
individual brand. New use cases are added as task JSON + capture modules, not as changes to
the core loop. See `docs/architecture.md` for why this separation matters and how it's
enforced.

## How it fits together

- **Claude Code** builds, tests, and maintains this engine.
- **TypeScript / Node.js** is the implementation language.
- **Playwright** controls the browser deterministically; Claude only *selects* an action from
  a fixed vocabulary, it never generates Playwright code at run time.
- **n8n** is the external orchestrator: it submits a task JSON over HTTP and receives a
  structured result JSON back, then handles forms, validation, Google Sheets, BigQuery, and
  reporting.
- **GitHub** stores source code, prompts, schemas, tests, and documentation (this repo).

## Repository layout

```
README.md                  # you are here
CLAUDE.md                  # working conventions for Claude Code sessions in this repo
docs/
  architecture.md          # core design, navigation loop, action vocabulary, proposed /src layout
  v1-scope.md               # what's in/out of scope for this phase and for v1, open decisions
  n8n-integration.md        # HTTP API contract between n8n and the engine
schemas/
  task-request.schema.json  # versioned contract: what a task JSON must contain
  task-response.schema.json # versioned contract: what the engine returns
examples/
  configurator-task.json        # use case 1: automotive configurator journey
  competitor-offers-task.json   # use case 2: competitor offers capture
```

`/src` contains a v1 scaffold: the core navigation loop, action executors, observation builder,
safety guards, and a set of capture modules (`page_visits`, `page_metadata`,
`data_layer_evidence`, `ga4_network_events`, `screenshots`, `finish_page_ctas`, `cta_clicks`,
`journey_path`, `errors`), driven in this phase by a deterministic mock reasoning provider
against local HTML fixtures (no Claude API, n8n, Google Sheets, BigQuery, or real website
involved yet). See `docs/v1-scope.md` for exactly what has and hasn't been built.

`src/api` adds a minimal local HTTP boundary around this engine (see "Local HTTP API" below).
It still only runs the mock reasoning provider against local fixtures — it is a proof-of-concept
wrapper, not a deployment.

## Running the local proof of concept

```
npm install
npm run typecheck       # tsc --noEmit
npm run validate:schemas # validates examples/*.json against schemas/task-request.schema.json
npm test                 # runs the engine against tests/fixtures/*.html end to end
npm run check             # all three, in order
```

`npm test` starts a local static server for `tests/fixtures/start.html`, `step2.html`, and
`success.html`, runs the engine with the mock reasoning provider through that two-hop journey,
and asserts the resulting `TaskResponse` validates against
`schemas/task-response.schema.json`. The fixture pages include a simulated `window.dataLayer`,
simulated GA4 `collect` requests, page metadata, and (on the success page) multiple visible
CTAs, so the same run exercises every implemented capture module, including the actual CTA
clicks recorded in `cta_clicks` and the full ordered `journey_path`. Screenshots captured
during the test are written to `test-artifacts/screenshots/` (gitignored) rather than embedded
in the response.

`npm test` also runs `tests/fixtures/errors-start.html` through the engine with the `errors`
capture module enabled. That fixture deliberately triggers safe, fictional failures (an
uncaught page JS error, a console error, a request to a nonexistent endpoint, and a click
target intercepted so the action itself fails) and asserts each is captured under
`captures.errors` as raw technical diagnostics, distinguishing recoverable events from ones
that stopped the run, with no cookies, auth headers, request bodies, credentials, tokens, or
raw stack traces included.

## The generic loop

Every task, regardless of use case, runs the same loop:

1. **navigate** to the current target URL
2. **observe** a compact, structured summary of the page (visible + accessible elements —
   never raw HTML)
3. **decide** the next action, via Claude, constrained to a fixed vocabulary:
   `click`, `scroll`, `wait`, `go_back`, `navigate`, `capture`, `stop_success`, `stop_blocked`,
   `stop_failure`
4. **act** — Playwright executes the chosen action deterministically, after a safety layer
   validates it (allowed domain, within step/backtrack limits, not a repeated/looping action,
   no payment/personal-data/form-submission unless explicitly enabled)
5. **check success** against the task's declared success criteria, logging progress
6. **repeat** until a `stop_*` action, a limit, or an unrecoverable error ends the run

Task-specific extraction (dataLayer evidence, GA4 network events, CTA/offer capture,
screenshots) happens in pluggable **capture modules**, kept separate from this core loop. See
`docs/architecture.md` for the full design.

## Local HTTP API (proof of concept, not production-ready)

`src/api` exposes a minimal HTTP boundary around the engine described above. It still only
runs the mock reasoning provider against local fixtures/target URLs you supply — nothing here
talks to the Claude API, n8n, Google Sheets, BigQuery, or Browserless.

```
npm run start:api   # starts the API on http://127.0.0.1:3000 (override with PORT=xxxx)
npm run test:api    # runs the API integration tests in isolation
```

Endpoints:

- `GET /v1/health` — liveness check.
- `POST /v1/tasks` — accepts a `task-request.schema.json`-shaped body, starts a run in the
  background, and immediately returns `{ taskId, runId, status: "accepted" }`.
- `GET /v1/tasks/:runId` — returns `{ status: "running" }` while the run is in progress, or the
  completed/failed result once it finishes.

Sample request (`POST /v1/tasks`):

```json
{
  "schemaVersion": "1.0.0",
  "taskId": "example-run-0001",
  "objective": "Reach the fixture's success page by following the visible continue control.",
  "startUrl": "http://127.0.0.1:4173/start.html",
  "allowedDomains": ["127.0.0.1"],
  "successCriteria": [
    {
      "id": "reached_success_page",
      "type": "url_pattern",
      "description": "The current page URL matches the success fixture.",
      "config": { "pattern": "http://127.0.0.1:4173/success.html" }
    }
  ],
  "captureModules": ["page_visits", "cta_clicks", "journey_path"],
  "limits": { "maxSteps": 5, "maxBacktracks": 0 },
  "safety": { "allowedActions": ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"] },
  "outputSchemaVersion": "1.0.0"
}
```

Sample response (`GET /v1/tasks/:runId` once complete):

```json
{
  "runId": "run_5f2c...",
  "taskId": "example-run-0001",
  "status": "completed",
  "result": {
    "schemaVersion": "1.0.0",
    "taskId": "example-run-0001",
    "status": "success",
    "startUrl": "http://127.0.0.1:4173/start.html",
    "finalUrl": "http://127.0.0.1:4173/success.html",
    "steps": ["..."],
    "captures": { "page_visits": ["..."], "cta_clicks": ["..."], "journey_path": ["..."] },
    "engineAssessment": { "objectiveAchieved": true, "confidence": 1, "summary": "..." },
    "diagnostics": { "stepCount": 2, "backtrackCount": 0, "totalDurationMs": 812, "finishReason": "stop_success_action" }
  }
}
```

**Current limitations:**

- Runs are stored in an in-memory `Map` only (`src/api/taskStore.ts`) — **all run state is lost
  when the process restarts**. This is a local proof of concept, not durable storage.
- No authentication of any kind is implemented. **The API must not be exposed to any deployed,
  shared, or n8n-accessible environment until authentication is added** (see
  `docs/n8n-integration.md` §5).
- No queues, database, webhooks, dashboard, cloud deployment, Docker packaging, API keys, or
  rate limiting — deliberately out of scope for this task.
- One task runs at a time per browser instance launched; there is no concurrency/queueing
  layer.
- Basic protections that are in place: a JSON body size limit, `Content-Type: application/json`
  enforcement, no permissive CORS headers, generic (non-leaking) error responses, and graceful
  shutdown on `SIGINT`/`SIGTERM`.

## Example task JSONs

- [`examples/configurator-task.json`](examples/configurator-task.json) — navigate an
  automotive homepage into a configurator, complete the journey to a finish/summary state,
  and capture pages visited, CTAs, dataLayer evidence, GA4 network events, and screenshots.
- [`examples/competitor-offers-task.json`](examples/competitor-offers-task.json) — navigate a
  competitor offers page and capture offer text, model, displayed price, visible validity
  information, and evidence screenshots.

Both validate against [`schemas/task-request.schema.json`](schemas/task-request.schema.json).

## Contributing / extending

Read [`CLAUDE.md`](CLAUDE.md) first — it captures the non-negotiable design rule (core loop
stays generic), the safety constraints that must never be relaxed, and the secrets policy
(never commit API keys, tokens, credentials, or proprietary brand information).
