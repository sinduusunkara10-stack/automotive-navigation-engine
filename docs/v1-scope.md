# v1 Scope

This document defines the scope boundary for the current phase of work and for the v1
implementation that follows it. It exists so contributors (human or Claude Code) don't
quietly expand the engine into a brand-specific tool or skip the foundation in favor of
jumping straight to code.

## This commit (foundation phase)

In scope, and delivered by this change:

- `README.md` — project overview and entry points
- `docs/architecture.md` — core design, loop, action vocabulary, safety layer, capture
  module boundary, proposed `/src` layout
- `docs/v1-scope.md` — this document
- `docs/n8n-integration.md` — the HTTP API contract n8n will call
- `schemas/task-request.schema.json` — versioned request contract
- `schemas/task-response.schema.json` — versioned response contract
- `examples/configurator-task.json` — worked example for use case 1
- `examples/competitor-offers-task.json` — worked example for use case 2
- `CLAUDE.md` — working conventions for future Claude Code sessions in this repo

Explicitly **not** in scope for this commit:

- No `/src` TypeScript implementation
- No `package.json`, build tooling, or dependency installation
- No Playwright automation code
- No Claude prompt implementation (only the design of the reasoning boundary)
- No HTTP server
- No CI/CD pipeline
- No tests (there is no implementation yet to test)

## v1 implementation scope (recommended next phase, not yet started)

In scope for v1:

- Core loop (`navigate -> observe -> decide -> act -> check success -> repeat`) implemented
  against the fixed action vocabulary: `click`, `scroll`, `wait`, `go_back`, `navigate`,
  `capture`, `stop_success`, `stop_blocked`, `stop_failure`.
- Compact structured observation builder (accessibility tree + visible interactive elements;
  no raw HTML forwarded to the reasoning layer).
- Safety layer: allowed-domain enforcement, `maxSteps`, `maxBacktracks`, repeated-action
  detection, loop detection, no-payment/no-purchase, no-personal-data-entry, no-form-submission
  unless explicitly enabled, and diagnostic capture on failure.
- Capture modules needed for the two example use cases: `page_visits`, `cta_clicks`,
  `data_layer_evidence`, `ga4_network_events`, `screenshots`, `errors`, `offer_extraction`.
- HTTP API endpoint(s) for n8n to submit a task and retrieve a result, schema-validated at the
  boundary in both directions.
- Structured per-step logging as defined in the response schema.

Explicitly out of scope for v1 (candidate for v2+):

- A visual/manual review UI for run results (n8n + Sheets/BigQuery cover reporting for now).
- Parallel/concurrent multi-task execution (v1 assumes one task run at a time per engine
  instance; queuing is an n8n/orchestration concern, not the engine's).
- Authentication/login flows on target sites.
- Any action beyond the fixed v1 vocabulary (e.g. drag, hover, type-into-field) — new actions
  are a deliberate, versioned addition to both the schema and `src/actions`, not an ad hoc
  extension.
- Form submission generally remains off by default in v1; enabling it per task is supported by
  the schema (`safety.allowFormSubmission`) but the guardrail and any associated capture logic
  should be implemented conservatively and reviewed before being exercised against a real site.
- Additional capture modules beyond the two example use cases (e.g. cookie-consent capture,
  stock/availability capture) — the registry is designed for this, but they are not built yet.
- Non-Chromium browser engines, mobile emulation profiles, geolocation/locale variation.
- Automatic retries/self-healing across full task runs (a single run either completes or stops
  with a status; re-running a task is an orchestrator-level decision).

## Assumptions

- The reasoning layer is Claude, called via API, with output constrained to the action
  vocabulary; the exact prompt/response contract is an implementation detail of
  `src/reasoning` and versioned under `/prompts`.
- n8n is the only orchestrator in scope; the HTTP API is not designed as a public/multi-tenant
  service in v1 (no auth model is specified yet — see open decisions below).
- Target websites are public marketing/configurator pages; the engine is not designed to
  operate behind authentication in v1.
- "Screenshots" in capture modules and responses are stored as external references (paths or
  URLs to blob/object storage), not embedded as base64 in the JSON response, to keep responses
  small and schema-clean.
- A single engine run handles a single task end-to-end; long-running/resumable runs are out of
  scope for v1.

## Unresolved decisions (need a decision before or during v1 implementation)

1. ~~**Auth model for the HTTP API.**~~ **Resolved:** a shared-secret bearer token
   (`NAVIGATION_ENGINE_API_TOKEN`), enforced on `POST /v1/tasks` and `GET /v1/tasks/:runId` by
   `src/api/auth.ts`. See `docs/n8n-integration.md` §5 and `README.md` §"Authentication".
2. **Screenshot/artifact storage backend.** Local disk, S3-compatible bucket, or something
   n8n already manages? Affects what `ref` values look like in `captures.screenshots`.
3. **Sync vs. async task execution.** A configurator journey may take minutes; does n8n call
   and block, or submit-and-poll/webhook-callback? `docs/n8n-integration.md` proposes
   submit-and-poll as the default but this is not finalized.
4. **Claude model/version pinning strategy** for the reasoning layer — partially resolved:
   `ClaudeReasoningProvider` pins a documented default (`CLAUDE_MODEL`, default
   `claude-sonnet-5`; see README "Reasoning provider selection" and `docs/architecture.md` §6),
   overridable per deployment via env var. How prompt-version changes are tracked against
   response quality over time remains open.
5. **Rate limiting / politeness controls** (delay between steps, respecting robots.txt or
   site terms) for competitor-offers-style monitoring tasks — not yet specified in the safety
   schema beyond the existing step/duration/backtrack limits.
6. **Multi-locale/multi-market task variants** — whether locale is part of `metadata` (advisory
   only) or needs to become a first-class, engine-relevant field. Partially informs the
   `semantic_page_match` success-criteria type (`docs/n8n-integration.md` §9): it is a
   literal-vocabulary overlap between `objective` and page text, not translation, so it will
   not reliably recognise a page written in a language different from the objective. `locale`/
   `language` remain optional, engine-blind reporting metadata (`metadata` only) rather than a
   field the engine reads — an operator who knows a target site's language in advance should
   author `objective` (and a `semantic_page_match` criterion's `description`) in that language
   rather than expect the engine to translate.
7. **Retention policy** for captured evidence (dataLayer payloads, screenshots, network
   events) — this repo does not currently define how long artifacts are kept or where.

## Recommended next implementation step

Scaffold the `/src` skeleton described in `docs/architecture.md` §10 with a minimal
`package.json` (TypeScript, Playwright, a JSON Schema validator, a test runner), implement the
core loop against a **mock reasoning layer** (deterministic canned decisions) and a **local
fixture page** first, and get one full run — configurator-style — producing a schema-valid
`task-response.json` end to end before wiring in the real Claude reasoning client or the HTTP
API. This validates the loop/actions/safety/capture-module boundaries independently of network
calls to either a browser target or Claude, and gives fast, deterministic tests to build on.
