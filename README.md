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
and safety guards, driven in this phase by a deterministic mock reasoning provider against a
local HTML fixture (no Claude API, n8n, Google Sheets, BigQuery, or real website involved yet).
See `docs/v1-scope.md` for exactly what has and hasn't been built.

## Running the local proof of concept

```
npm install
npm run typecheck       # tsc --noEmit
npm run validate:schemas # validates examples/*.json against schemas/task-request.schema.json
npm test                 # runs the engine against tests/fixtures/*.html end to end
npm run check             # all three, in order
```

`npm test` starts a local static server for `tests/fixtures/start.html` and `success.html`,
runs the engine with the mock reasoning provider against it, and asserts the resulting
`TaskResponse` validates against `schemas/task-response.schema.json`.

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
