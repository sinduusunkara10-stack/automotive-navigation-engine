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
safety guards, a deterministic **preflight domain-discovery phase** (see "Preflight domain
discovery" below), and a set of capture modules (`page_visits`, `page_metadata`,
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

`npm test` also runs `tests/integration/actionExecutionConsistency.test.ts` against a bespoke
local server, covering the observation -> reasoning -> execution pipeline's generic
consistency guarantees end to end: a hidden duplicate element is never offered as a click
candidate; a stable element id survives a DOM reorder; a target that goes stale (removed,
hidden, disabled, covered) between being observed and being acted on triggers re-observation
and a fresh decision rather than a blind click; and a click that still fails for a recoverable
reason falls back to a generic, safety-checked `destinationUrl` navigation (with the fallback
correctly rejected for a URL outside `allowedDomains`, an unsafe protocol, or no
`destinationUrl` at all). See `docs/architecture.md` §5 ("Action-execution consistency").

`npm test` also runs `tests/unit/*.test.ts`, which cover the Claude reasoning provider (prompt
construction, decision validation, retry/fallback behavior, provider selection, and usage
diagnostics aggregation) entirely against a deterministic fake model client — no network
access, no `ANTHROPIC_API_KEY`, and no Claude usage. See "Reasoning provider selection" below
for the real provider and its separate, opt-in manual smoke test, and "Reasoning provider usage
diagnostics" below for what's reported in `TaskResponse.diagnostics.reasoningProvider`.

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

### Reasoning provider usage diagnostics

Every `TaskResponse` carries a versioned `diagnostics.reasoningProvider` structure
(`schemas/task-response.schema.json` `$defs/reasoningProviderDiagnostics`, `TaskResponse.schemaVersion`
"1.1.0") summarising how much of the run's decision-making came from a real Claude call versus
elsewhere, regardless of which `ReasoningProvider` was selected:

| Field | Meaning |
|---|---|
| `provider` | `"claude"` or `"mock"`. |
| `model` | Model id used, when applicable. Absent for the mock provider. |
| `callCount` | Real provider calls made this run, **each counted once** — a retried decision counts as 2 calls (the original attempt plus the retry), not 1. Always `0` for the mock provider, which never calls a real API. |
| `acceptedDecisionCount` / `rejectedDecisionCount` / `fallbackDecisionCount` | How many of the provider's decisions were accepted, rejected (by engine-side validation or a provider/API error), or fell back to a safe `stop_blocked` because no valid decision could be produced. |
| `totalInputTokens` / `totalOutputTokens` | Summed token usage across every real call this run — **reported as raw counts, not a computed monetary cost**, because model pricing can change independently of this engine; compute cost downstream from these numbers against whatever pricing applies at query time. |
| `totalLatencyMs` | Summed wall-clock time across every real call. |
| `retryCount` | How many attempts beyond each decision's first attempt occurred this run (`CLAUDE_MAX_RETRIES`, hard-capped at 1 per decision — see above — so this is at most one per decision, summed across the run). |
| `decisions` | Optional per-attempt breakdown (step index where available, attempt number, outcome, confidence where available, input/output tokens, latency) for finer-grained inspection. |

This is aggregated directly from `ClaudeReasoningProvider`'s existing in-memory decision log
(`getDecisionLog()`/the same log `getUsageDiagnostics()` reads) — there is no second,
independent usage-tracking mechanism to keep in sync. It never contains prompts, raw model
responses, page content, request bodies, API keys, headers, or credentials — only the aggregate
and per-decision numbers/outcome codes above (see `tests/unit/reasoningProviderDiagnostics.test.ts`
and `tests/integration/reasoningProviderDiagnostics.test.ts`). n8n (or any other caller of the
HTTP API) finds this at `result.diagnostics.reasoningProvider` in the `GET /v1/tasks/:runId`
response (see "Local HTTP API" below) — it is kept out of `captures` (raw website evidence) and
`engineAssessment` (engine classification) per the separation rule in `CLAUDE.md`.

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

**This is a one-decision provider smoke test, not a complete journey test.** Its only job is to
prove that exactly one real Claude decision comes back safe and usable — it never attempts to
complete the fixture's full multi-page journey. Pass/fail is judged against
`ClaudeReasoningProvider`'s decision log (see `evaluateSmokeTestAcceptance` in
`tests/manual/smokeTestAcceptance.ts`), and the test **passes** when all of the following hold:

- exactly one Claude decision-log entry exists, from provider `"claude"`, with outcome
  `"accepted"` on attempt `0` (so no retry occurred);
- the resulting action is schema-valid, drawn from the controlled action vocabulary, and any
  target element id it requires was actually present in that step's observation;
- no raw secret or API key shows up anywhere in the logged output.

With `maxSteps: 1`, the engine is expected to end the run with status `max_steps_reached`
immediately after that one accepted decision (the safety layer's limits guard forces a stop step
without ever calling Claude a second time) — **that alone does not fail this smoke test.** It
still fails if no Claude decision was produced, more than one API decision was made, the decision
was rejected/malformed, the provider wasn't Claude, a retry occurred, or the API call itself
failed.

### Running the smoke test in GitHub Actions

[`.github/workflows/manual-claude-smoke-test.yml`](.github/workflows/manual-claude-smoke-test.yml)
wraps the same smoke test above for CI. Key points:

- **Manually triggered only** — its sole trigger is `workflow_dispatch`. It never runs on push,
  pull request, a schedule, or any other automatic event.
- **Performs exactly one billed Claude API call** — it runs `npm run smoke:claude` exactly once,
  with `CLAUDE_MAX_RETRIES=0`, so a failed call is not retried.
- **Uses only the local fictional fixture** under `tests/fixtures/` — no real website, n8n,
  Google Sheets, or BigQuery, and it never starts the local HTTP API (`src/api`).
- The `ANTHROPIC_API_KEY` secret is supplied only to that one step via
  `${{ secrets.ANTHROPIC_API_KEY }}`, is never echoed/logged, and the job fails clearly (without
  printing the key) if the repository secret isn't configured.

**How to run it:** in this repository on GitHub, go to **Actions → Manual Claude Reasoning
Provider Smoke Test → Run workflow**, pick the branch, and confirm. This requires the
`ANTHROPIC_API_KEY` repository secret to already be configured under **Settings → Secrets and
variables → Actions**.

**How to check pass/fail:** open the workflow run under the **Actions** tab. A green run means
typecheck, schema validation, the automated test suite, and the single Claude smoke-test call
all succeeded (look for a line starting `OK:` in the last step's log). A red run means one of
those steps failed — expand the failing step's log for the reason; the log never contains the API
key, raw request/response bodies, or full prompts. A run that logs `OK:` and then reports final
engine status `max_steps_reached` is a **pass**, not a failure — see "one-decision provider smoke
test, not a complete journey test" above.

**Spending protection:** because each run bills one Claude API call, leave any "auto-reload"
billing setting on your Anthropic account **off**, and only trigger this workflow intentionally.

### Manual full local-journey test (opt-in, up to 3 real API calls) — final pre-deployment check

Separate again from both the automated tests and the one-decision smoke test above,
`tests/manual/claudeFullLocalJourneyTest.ts` proves the real `ClaudeReasoningProvider` can drive
the engine through the **complete** three-page local fictional journey —
`start.html -> step2.html -> success.html` — reusing the existing engine (`src/core/engine.ts`)
and fixtures, not a reimplementation. Run it explicitly with:

```
REASONING_PROVIDER=claude ANTHROPIC_API_KEY=sk-ant-... npm run fulljourney:claude
```

**Usage and cost warning:** this makes **up to three real, billed** calls to the Claude API — one
per page (`tests/manual/fullJourneyTask.ts` caps the task at `maxSteps: 3`, a hard ceiling enforced
by the engine's own limits guard, so a journey that cannot complete in three decisions is stopped
safely without ever making a fourth call). It only ever navigates the local fictional fixture under
`tests/fixtures/` — **no real website, n8n, Google Sheets, or BigQuery is involved**. If either env
var is unset, the script prints a message and exits without making any call.

The test **passes** when all of the following hold, evaluated by `evaluateFullJourneyAcceptance`
(`tests/manual/fullJourneyAcceptance.ts`) against `ClaudeReasoningProvider`'s decision log and the
completed `TaskResponse`:

- Claude selected a valid, schema-conformant, in-vocabulary action on `start.html`, and Playwright
  reached `step2.html`; Claude then selected a valid action there, and Playwright reached
  `success.html`;
- the run's normal success criteria were satisfied and the final engine status is `"success"`;
- the completed `TaskResponse` validates against `schemas/task-response.schema.json` version
  `1.1.0`;
- `diagnostics.reasoningProvider` is present, `provider` is `"claude"`, `callCount` equals the
  actual number of real provider calls made (at most 3), `acceptedDecisionCount` equals
  `callCount`, and `rejectedDecisionCount`, `fallbackDecisionCount`, and `retryCount` are all zero;
- `totalInputTokens` and `totalOutputTokens` are both greater than zero;
- no raw secret or API key shows up anywhere in the logged output.

**Deterministic, network-free coverage of the same acceptance criteria** lives in
`tests/unit/manualClaudeFullLocalJourneyAcceptance.test.ts` (pure pass/fail logic) and
`tests/integration/claudeFullLocalJourney.test.ts` (a real `ClaudeReasoningProvider` driven by a
fake, in-memory model client through the actual fixture journey) — both run as part of `npm test`
and never touch the network or `ANTHROPIC_API_KEY`.

**Running it in GitHub Actions:**
[`.github/workflows/manual-claude-full-local-journey.yml`](.github/workflows/manual-claude-full-local-journey.yml)
wraps the same test for CI, with the same safety posture as the one-decision smoke-test workflow:

- **Manually triggered only** — its sole trigger is `workflow_dispatch`; it never runs on push,
  pull request, a schedule, or any other automatic event.
- **At most 3 billed Claude API calls, never a 4th** — `maxSteps: 3` in
  `tests/manual/fullJourneyTask.ts` is a hard ceiling enforced by the engine's own limits guard,
  independent of the workflow's env tuning.
- `CLAUDE_MAX_RETRIES=0` — a failed call is never retried within this run.
- A small `CLAUDE_MAX_OUTPUT_TOKENS` (256) — enough for one structured navigation decision, no
  more.
- **Uses only the local fictional fixture** under `tests/fixtures/` — no real website, n8n, Google
  Sheets, or BigQuery, and it never starts the local HTTP API (`src/api`).
- A single-run `concurrency` group so a second manual trigger can never overlap with (and
  double-bill) an in-flight run, and a conservative 15-minute job timeout.
- The `ANTHROPIC_API_KEY` secret is supplied only to the one real-call step via
  `${{ secrets.ANTHROPIC_API_KEY }}`, is never echoed/logged, and the job fails clearly (without
  printing the key) if the repository secret isn't configured.
- Automated string-level checks on both the workflow file and the capped task
  (`tests/unit/manualClaudeFullLocalJourneyWorkflow.test.ts`) verify all of the above — manual
  trigger only, correct secret reference, no literal key, the call ceiling, no retry, and that the
  real full-journey script (`npm run fulljourney:claude`) appears exactly once.

**How to run it:** in this repository on GitHub, go to **Actions → Manual Claude Full Local
Journey Test → Run workflow**, pick the branch, and confirm. Requires the same
`ANTHROPIC_API_KEY` repository secret as the one-decision smoke test.

**Expected successful output:** a green run, ending with a safe summary log (status, step count,
provider, model, call count, accepted/rejected/fallback counts, total input/output tokens, total
latency, retry count — never prompts, raw responses, HTML, env vars, headers, cookies, request
bodies, or credentials) and a line starting `OK:` reporting final status `"success"` in 3 or fewer
real Claude calls, all accepted on the first attempt.

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

## Generic success criteria

`successCriteria[].type` (`src/core/successEvaluator.ts`) supports `url_pattern` and
`element_present` (both require the caller to already know a destination URL shape or CSS
selector on the target site) and, as of request `schemaVersion` `"1.2.0"`,
**`semantic_page_match`** — a generic, brand/language-agnostic criterion that scores how much
of the task's `objective` (plus the criterion's own `description`) shows up in the live page's
title, headings, and interactive-element text, using the same token-overlap approach
`src/discovery/relevance.ts` already uses for preflight domain discovery. It needs no selector,
URL pattern, hostname, brand, or CTA label — only `startUrl`, `objective`, and (optionally)
`journeyType`, the fields an orchestrator's form trigger can supply for a site it has never
crawled before. See `docs/n8n-integration.md` §9-§11 for the full evaluation model, its known
literal-vocabulary/language limitation, and how an n8n Build node should construct
`successCriteria` generically instead of falling back to per-brand values.

## Preflight domain discovery

Before that loop starts, a deterministic **preflight phase** (`src/discovery`) runs once: it
performs the engine's initial navigation to `startUrl`, then proposes an `allowedDomains` set
from what it observes there — so a caller need only supply `startUrl`, `objective`, and
optionally `journeyType`. `allowedDomains` in the task request is now **optional**; when
present, it's still trusted unconditionally, on top of what preflight discovers. See
`examples/minimal-preflight-discovery-task.json` for a task that supplies only those three
fields.

Preflight automatically trusts the exact `startUrl` hostname, the hostname an HTTP redirect
from `startUrl` actually lands on, and any hostname sharing a **Public Suffix List
registrable domain** (via the `tldts` library — never string-splitting) with either of those,
discovered through the canonical URL or on-page links. A hostname on a *different*
registrable domain is never auto-trusted just because it appears in a link — it's surfaced as
an `externalCandidates` entry for review instead. Non-http/https protocols, `localhost`,
loopback addresses, and link-local addresses are always rejected as discovered candidates
(the caller's own explicit `startUrl` is the one exemption from the last three, since a
caller may deliberately target a local/dev host). See `docs/architecture.md` §12 for the full
policy and rationale.

Every run reports what preflight found at `TaskResponse.diagnostics.domainDiscovery`
(`schemaVersion` `1.2.0`): `trustedDomains`, `externalCandidates`, `rejectedCandidates`,
`proposedAllowedDomains`, and the final `allowedDomainsUsed` for the run.

## Local HTTP API

`src/api` exposes a minimal, authenticated HTTP boundary around the engine described above,
against local fixtures/target URLs you supply — nothing here talks to n8n, Google Sheets,
BigQuery, or Browserless. It uses `MockReasoningProvider` by default; setting
`REASONING_PROVIDER=claude` (see "Reasoning provider selection" above) makes it use the real
Claude API for navigation decisions instead.

```
npm run start:api   # starts the API on http://127.0.0.1:3000 (override with PORT=xxxx)
npm run test:api    # runs the API integration tests in isolation
```

### Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `PORT` | No | HTTP port, default `3000`. |
| `NODE_ENV` | No | `development`/`production` for normal use. `test` is reserved for the automated test suite. |
| `NAVIGATION_ENGINE_API_TOKEN` | **Yes** (outside `NODE_ENV=test`) | Bearer token required on `POST /v1/tasks` and `GET /v1/tasks/:runId`. The server refuses to start without it (see "Authentication" below). |
| `INITIAL_NAVIGATION_TIMEOUT_MS` | No | Timeout (ms) for the engine's initial page navigation, which waits only for `domcontentloaded` — never `load`/networkidle. Default `30000`, must be a positive integer, capped at a hard maximum. An invalid value fails server startup clearly (see `src/config/initialNavigationConfig.ts`). |
| `ACTION_NAVIGATION_TIMEOUT_MS` | No | Timeout (ms) for navigation triggered by in-loop actions — the `navigate` action and link clicks that cause a document navigation — also waiting only for `domcontentloaded`, never `load`/networkidle. Default `30000`, must be a positive integer, capped at a hard maximum. An invalid value fails server startup clearly (see `src/config/actionNavigationConfig.ts`). |
| `REASONING_PROVIDER` | No | `mock` (default) or `claude`. |
| `ANTHROPIC_API_KEY` | Only when `REASONING_PROVIDER=claude` | See "Reasoning provider selection" above. |
| `CLAUDE_MODEL`, `CLAUDE_MAX_OUTPUT_TOKENS`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MAX_RETRIES`, `CLAUDE_MIN_CONFIDENCE` | No | Existing Claude tuning, unchanged — see `src/reasoning/config.ts`. |

Copy `.env.example` to `.env` for local use — **never commit a real `.env`** (it is gitignored).
**In any deployed environment, all of the above come from the hosting platform's own secret
manager** (e.g. its environment/secret store), never from a file baked into the image or
checked into source.

### Authentication

`POST /v1/tasks` and `GET /v1/tasks/:runId` require:

```
Authorization: Bearer <NAVIGATION_ENGINE_API_TOKEN>
```

`GET /v1/health` stays unauthenticated by design, so orchestrators and container health checks
can probe liveness with no credential. Requests to the two task endpoints are rejected with
`401` when the header is missing, malformed (not exactly `Bearer <token>`), or carries a token
that doesn't match — the comparison is constant-time and the response/logs never reveal
whether a submitted token was close to correct. The server itself refuses to start if
`NAVIGATION_ENGINE_API_TOKEN` is unset outside `NODE_ENV=test`, so a misconfigured deployment
fails immediately and loudly rather than serving an API nobody can authenticate against.

Endpoints:

- `GET /v1/health` — unauthenticated liveness check. Returns `{ status, service, version }`,
  plus an optional `commit` field (the deployed commit SHA, read from Render's own
  `RENDER_GIT_COMMIT` env var, or the generic `GIT_COMMIT_SHA` fallback on other platforms
  — see `src/config/deploymentInfo.ts`) when the deployment platform provides it, so an
  operator investigating a live run can confirm which commit actually served it — never any
  other environment variable, dependency version, filesystem path, secret, or configuration.
- `POST /v1/tasks` — accepts a `task-request.schema.json`-shaped body, starts a run in the
  background, and immediately returns `{ taskId, runId, status: "accepted" }`.
- `GET /v1/tasks/:runId` — returns `{ status: "running" }` while the run is in progress, or the
  completed/failed result once it finishes.

Sample authenticated requests (placeholder token — substitute your own):

```bash
curl http://127.0.0.1:3000/v1/health

curl -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer <NAVIGATION_ENGINE_API_TOKEN>" \
  -H "Content-Type: application/json" \
  -d @examples/configurator-task.json

curl http://127.0.0.1:3000/v1/tasks/run_5f2c... \
  -H "Authorization: Bearer <NAVIGATION_ENGINE_API_TOKEN>"
```

Sample response (`GET /v1/tasks/:runId` once complete):

```json
{
  "runId": "run_5f2c...",
  "taskId": "example-run-0001",
  "status": "completed",
  "result": {
    "schemaVersion": "1.2.0",
    "taskId": "example-run-0001",
    "status": "success",
    "startUrl": "http://127.0.0.1:4173/start.html",
    "finalUrl": "http://127.0.0.1:4173/success.html",
    "steps": ["..."],
    "captures": { "page_visits": ["..."], "cta_clicks": ["..."], "journey_path": ["..."] },
    "engineAssessment": { "objectiveAchieved": true, "confidence": 1, "summary": "..." },
    "diagnostics": {
      "stepCount": 2,
      "backtrackCount": 0,
      "totalDurationMs": 812,
      "finishReason": "stop_success_action",
      "reasoningProvider": {
        "version": "1.0.0",
        "provider": "mock",
        "callCount": 0,
        "acceptedDecisionCount": 0,
        "rejectedDecisionCount": 0,
        "fallbackDecisionCount": 0,
        "totalInputTokens": 0,
        "totalOutputTokens": 0,
        "totalLatencyMs": 0,
        "retryCount": 0
      }
    }
  }
}
```

n8n reads this same completed-result JSON returned from `GET /v1/tasks/:runId` -- reasoning-provider
usage lives at `result.diagnostics.reasoningProvider` (see "Reasoning provider usage diagnostics"
below), alongside `result.diagnostics.stepCount`/`totalDurationMs`/etc.; it is never mixed into
`result.captures` (raw website evidence) or `result.engineAssessment` (engine classification).

**Current limitations:**

- Runs are stored in an in-memory `Map` only (`src/api/taskStore.ts`) — **all run state is lost
  when the process restarts.** The container is meant to run as **one service instance**; a
  persistent or shared task store is required before scaling to multiple instances (a second
  instance would never see runs created on the first).
- No queues, database, webhooks, dashboard, cloud-vendor-specific deployment files, or rate
  limiting — deliberately out of scope for this phase.
- One task runs at a time per browser instance launched; there is no concurrency/queueing
  layer.
- Basic protections that are in place: bearer-token authentication (above), a JSON body size
  limit, `Content-Type: application/json` enforcement, no permissive CORS headers, generic
  (non-leaking) error responses, and graceful shutdown on `SIGINT`/`SIGTERM`.

## Docker

A `Dockerfile` builds a deployable image: a `node:20-slim` builder stage compiles the
TypeScript with `tsc`, and the runtime stage is based on the official
`mcr.microsoft.com/playwright` image (matching the pinned `playwright` version in
`package.json`) so Chromium and its OS dependencies are already present. The runtime stage
installs only production dependencies (`npm ci --omit=dev`), runs as the image's pre-created
non-root `pwuser`, exposes only the application port, and declares a container `HEALTHCHECK`
against `GET /v1/health`. `.dockerignore` keeps `.env`, `.git`/`.github`, `node_modules`,
`tests`, `test-artifacts`, and docs out of the build context and the image.

Build and run locally:

```bash
docker build -t navigation-engine .

docker run --rm -p 3000:3000 \
  -e NAVIGATION_ENGINE_API_TOKEN=<a-long-random-secret> \
  -e REASONING_PROVIDER=mock \
  navigation-engine
```

For `REASONING_PROVIDER=claude`, also pass `-e ANTHROPIC_API_KEY=...`. **Never bake either
secret into the image or a committed file** — pass them at `docker run` time via `-e`/
`--env-file`, or, in a real deployment, whatever secret-injection mechanism the hosting
platform provides (e.g. its environment/secret manager). Verify the container:

```bash
curl http://127.0.0.1:3000/v1/health
curl -i -X POST http://127.0.0.1:3000/v1/tasks   # no Authorization header -> 401
curl -X POST http://127.0.0.1:3000/v1/tasks \
  -H "Authorization: Bearer <a-long-random-secret>" \
  -H "Content-Type: application/json" \
  -d @examples/configurator-task.json
```

There is no `docker-compose.yml` — a single `docker run` plus the local fixture server used by
`npm test` is sufficient to validate the image, and this repo intentionally adds no
cloud-vendor-specific deployment files (see `docs/v1-scope.md`).

## Example task JSONs

- [`examples/configurator-task.json`](examples/configurator-task.json) — navigate an
  automotive homepage into a configurator, complete the journey to a finish/summary state,
  and capture pages visited, CTAs, dataLayer evidence, GA4 network events, and screenshots.
- [`examples/competitor-offers-task.json`](examples/competitor-offers-task.json) — navigate a
  competitor offers page and capture offer text, model, displayed price, visible validity
  information, and evidence screenshots.
- [`examples/minimal-preflight-discovery-task.json`](examples/minimal-preflight-discovery-task.json)
  — a fully generic configurator-entry task: only `startUrl`, `objective`, and `journeyType`
  describe the target site (no `allowedDomains`, hostname, CSS selector, or brand/market
  value anywhere); preflight domain discovery determines `allowedDomains` on its own, and its
  `semantic_page_match` success criterion (see "Generic success criteria" above) recognises
  the target state from `objective` and live page text alone.

All three validate against
[`schemas/task-request.schema.json`](schemas/task-request.schema.json).

## Contributing / extending

Read [`CLAUDE.md`](CLAUDE.md) first — it captures the non-negotiable design rule (core loop
stays generic), the safety constraints that must never be relaxed, and the secrets policy
(never commit API keys, tokens, credentials, or proprietary brand information).
