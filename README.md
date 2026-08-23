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
`journey_path`, `errors`), driven by a pluggable reasoning provider: the deterministic
**mock** provider by default, or the real **Claude-backed** provider opt-in via
`REASONING_PROVIDER=claude` (see "Reasoning provider selection" below). Automated tests always
use the mock provider or a deterministic fake Claude client — never a real network call to
Claude, n8n, Google Sheets, BigQuery, or a real website. See `docs/v1-scope.md` for exactly what
has and hasn't been built.

`src/api` adds a minimal local HTTP boundary around this engine (see "Local HTTP API" below). It
runs against local fixtures/target URLs you supply, using the mock reasoning provider by default
or the real Claude API when opted in — it is a proof-of-concept wrapper either way, not a
deployment.

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

`npm test` also runs `tests/unit/*.test.ts`, which cover the Claude reasoning provider (prompt
construction, decision validation, retry/fallback behavior, provider selection) entirely
against a deterministic fake model client — no network access, no `ANTHROPIC_API_KEY`, and no
Claude usage. See "Reasoning provider selection" below for the real provider and its separate,
opt-in manual smoke test.

## Reasoning provider selection

The engine's reasoning layer (`src/reasoning`, see `docs/architecture.md` §6) is pluggable
behind one `ReasoningProvider` interface. Two implementations exist:

- **`MockReasoningProvider`** — deterministic, no network calls. **The default** if
  `REASONING_PROVIDER` is unset or empty, and what every automated test uses.
- **`ClaudeReasoningProvider`** — calls the real Claude API (via the official
  `@anthropic-ai/sdk`) for exactly one structured navigation decision per step, validated
  against the same controlled action vocabulary and `allowedDomains` the safety layer enforces
  before it ever reaches Playwright.

Select the provider with:

```
REASONING_PROVIDER=mock     # default; also selected automatically if unset/empty
REASONING_PROVIDER=claude   # real Claude-backed provider; requires ANTHROPIC_API_KEY
```

An unsupported value (e.g. a typo) fails clearly at startup rather than silently falling back
to mock. Copy `.env.example` to `.env` for local use — **never commit a real `.env`** (it is
gitignored; only `.env.example`, with placeholder values, is committed).

### Claude provider configuration

Read only from `ANTHROPIC_API_KEY` — never logged, returned, partially displayed, or committed.
Optional tuning (defaults shown; see `src/reasoning/config.ts`):

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_MODEL` | `claude-sonnet-5` | Called once per navigation step (potentially many times per run), so a lower-cost/lower-latency model is the conservative default. Not hardcoded without this documented rationale — override for tasks needing stronger reasoning. |
| `CLAUDE_MAX_OUTPUT_TOKENS` | `1024` | Clamped to `[64, 4096]`. |
| `CLAUDE_TIMEOUT_MS` | `15000` | Per-request timeout, clamped to `[1000, 60000]`. |
| `CLAUDE_MAX_RETRIES` | `1` | **Hard-capped at 1** regardless of this value — the same never-relaxed-ceiling pattern `src/safety` uses for `maxSteps`/`maxBacktracks`. |
| `CLAUDE_MIN_CONFIDENCE` | `0.5` | Below this, a decision is treated as invalid (rejected, retried once, then a safe `stop_blocked` fallback) — never silently accepted. |

### Safety and validation controls specific to the Claude provider

- Claude only ever sees the same compact `Observation` the core loop already builds (objective,
  success criteria, current URL/title/notable text, interactive elements with
  id/type/accessibleName/visible/destinationUrl, `allowedActions`, `allowedDomains`, remaining
  step/backtrack budget, recent actions) — never raw HTML, cookies, storage, headers, or
  authentication values. Enforced structurally: `ReasoningContext` (what the provider receives)
  has no field through which any of those could reach the prompt. See
  `tests/unit/promptBuilder.test.ts`.
- The decision is constrained by a strict, per-run structured-output schema
  (`src/reasoning/claudeDecisionSchema.ts`) built from *this run's* `allowedActions` — Claude
  cannot select an action outside that list, and cannot return JavaScript, Playwright code,
  selectors, or shell commands (there is no field for them).
- Every decision is re-validated engine-side before it can reach the safety layer or Playwright
  (`src/reasoning/validateClaudeDecision.ts`): the action must still be in `allowedActions`, a
  `click` target must reference an element actually observed this step, and a `navigate` URL is
  re-checked against `allowedDomains` with the same guard the safety layer itself uses.
- On invalid/malformed output, a refusal, or an API error, the provider retries at most once and
  then returns a safe `stop_blocked` decision rather than throwing or crashing the run — the
  existing safety layer in `src/safety` re-checks whatever any provider returns regardless.
- API errors are reduced to a small sanitised category (e.g. `rate_limited`,
  `authentication_failed`, `timeout`) before being recorded anywhere; the API key and raw SDK
  error text never cross that boundary.

### Manual local-fixture smoke test (opt-in, real API call)

`npm test` / `npm run check` never call the real Claude API. A separate, manual smoke test does,
and only when both conditions hold:

```
REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run smoke:claude
```

**Usage and cost warning:** this makes exactly **one real, billed** call to the Claude API
(`tests/manual/claudeReasoningProviderSmokeTest.ts` caps the task at `maxSteps: 1` — the minimum
needed to prove the integration end to end). It only ever navigates the local fictional fixture
under `tests/fixtures/` — **no real website, n8n, Google Sheets, or BigQuery is involved**. If
either env var is unset, the script prints a message and exits without making any call.

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

`src/api` exposes a minimal HTTP boundary around the engine described above, against local
fixtures/target URLs you supply — nothing here talks to n8n, Google Sheets, BigQuery, or
Browserless. It uses `MockReasoningProvider` by default; setting `REASONING_PROVIDER=claude`
(see "Reasoning provider selection" above) makes it use the real Claude API for navigation
decisions instead — still a local proof of concept, not a production deployment.

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
