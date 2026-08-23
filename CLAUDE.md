# CLAUDE.md

Guidance for Claude Code sessions working in this repository.

## What this repository is

A **generic, reusable navigation engine** for digital analytics / website intelligence /
journey discovery, built with TypeScript, Node.js, Playwright, and Claude as a constrained
decision-maker. Automotive journey intelligence (configurator completion, competitor offer
capture) is the first consumer of this engine — it is not the engine's identity.

Read `docs/architecture.md` and `docs/v1-scope.md` before making structural changes. Read
`schemas/task-request.schema.json` and `schemas/task-response.schema.json` before changing
anything that touches the request/response contract — they are the source of truth for the
engine's external interface.

## Non-negotiable design rule

**The core navigation loop must never become domain-specific.** If you find yourself adding an
`if (automotive)` branch, an automotive/GA4/brand-named field, or a hardcoded selector for a
specific site into `src/core`, `src/actions`, `src/observation`, `src/reasoning`, or
`src/safety` (once that code exists), stop — that logic belongs in a **capture module**
(`src/capture-modules`) or in the task JSON supplied at run time, not in the core.

Concretely:

- The core loop only knows the fixed action vocabulary: `click`, `scroll`, `wait`, `go_back`,
  `navigate`, `capture`, `stop_success`, `stop_blocked`, `stop_failure`. New actions are a
  deliberate, versioned change to both JSON schemas and `src/actions` — never an ad hoc
  extension for one task.
- Claude (the reasoning layer) selects an action from that vocabulary; it never generates or
  is asked to generate arbitrary Playwright code at run time.
- Never send raw page HTML to the reasoning layer. Use the compact structured observation
  (visible + accessible elements) described in `docs/architecture.md` §5.
- Keep **raw, website-derived evidence** (`captures.*` in the response) strictly separate from
  **engine-generated classification** (`engineAssessment` in the response). Don't let a
  capture module write an inference into `captures`, and don't let assessment logic write
  observed page text into `engineAssessment`.

## Safety constraints to preserve in every change

These are hard requirements, not defaults to be relaxed for convenience:

- Allowed-domain enforcement on every navigation/redirect.
- `maxSteps` and `maxBacktracks` are hard ceilings, always enforced by the safety layer
  independent of what the reasoning layer decides.
- Repeated-action and loop detection must stop a run rather than let it spin.
- No payment/purchase flows, ever (`safety.allowPaymentOrPurchase` is schema-locked to
  `false`).
- No personal-data entry, ever (`safety.allowPersonalDataEntry` is schema-locked to `false`).
- No form submission unless a task explicitly sets `safety.allowFormSubmission: true`.
- On failure or a guardrail trip, capture a diagnostic screenshot/log — don't fail silently.

## Secrets

Never commit API keys, tokens, credentials, personal data, or proprietary company/brand
information (real dealer sites, real internal URLs, real customer data) to this repository.
Example task JSONs under `/examples` use placeholder domains
(`example-automotive-oem.com`, `example-competitor-oem.com`) deliberately — keep it that way.
Runtime secrets belong in environment variables, loaded by `src/config` once that code exists,
never in source, never in committed `.env` files (`.env` is gitignored; `.env.example` with
placeholder values only, if added, is fine).

## Contracts and versioning

- `schemas/task-request.schema.json` and `schemas/task-response.schema.json` are the
  authoritative wire contracts. Any change to them is a contract change: bump
  `schemaVersion`/`outputSchemaVersion` handling accordingly and update the examples so they
  keep validating.
- After editing either schema or either example, re-validate, e.g.:
  ```
  npx ajv-cli validate --spec=draft2020 -c ajv-formats \
    -s schemas/task-request.schema.json -d "examples/*.json"
  ```
  (requires `ajv-cli` and `ajv-formats`; install as dev dependencies once `package.json`
  exists, or run via `npx` as above.)
- Keep `docs/architecture.md`'s proposed `/src` folder structure and the actual `/src` tree in
  sync as the implementation lands — update the doc in the same change that restructures code.

## Working style expected in this repo

- Don't implement more than the current task asks for. This repo was deliberately foundationed
  in phases (see `docs/v1-scope.md`); check that document before assuming the next logical
  chunk of implementation is wanted.
- Prefer extending the capture-module registry or the task JSON over adding special cases to
  the core loop.
- When adding a new capture module, give it a stable snake_case name matching the
  `captureModule` enum in `schemas/task-request.schema.json` and add its corresponding section
  to `captures` in `schemas/task-response.schema.json`.
- No comments explaining *what* code does; only comment a genuinely non-obvious *why*
  (a safety workaround, a subtle Playwright timing issue, etc.), consistent with the general
  engineering conventions this session was given.
