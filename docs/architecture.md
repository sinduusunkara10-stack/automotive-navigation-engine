# Architecture

## 1. Purpose

This document describes the architecture of the **Generic Navigation Engine**: a reusable
Playwright + Claude system that drives a browser through a website to accomplish a
caller-defined objective, following a fixed loop:

```
navigate -> observe -> decide -> act -> check success -> repeat
```

Automotive journey intelligence (configurator completion, competitor offer capture) is the
**first consumer** of this engine, not its foundation. Nothing in the core loop, the action
vocabulary, or the safety layer may reference automotive concepts, GA4, a specific brand, or
a specific website structure. Anything domain-specific lives in **capture modules** and in the
JSON task supplied at run time — never in the core.

## 2. Core principle: loop vs. plugins

The engine is split into two halves that must never blur:

| Layer | Knows about | Does not know about |
|---|---|---|
| **Core loop** (`src/core`, `src/actions`, `src/observation`, `src/reasoning`, `src/safety`) | Generic navigation state, the fixed action vocabulary, success-criteria evaluation, guardrails | Automotive, GA4, dataLayer, Peugeot/Stellantis, offers, configurators |
| **Capture modules** (`src/capture-modules`) | How to pull a specific kind of evidence off a page (dataLayer contents, GA4 network calls, offer text) | Navigation strategy, when to stop, how to decide the next action |

A new use case (e.g. "capture cookie-consent banners" or "capture stock availability") should
be addable as a new capture module and a new task JSON, **without touching the core loop**.

## 3. The navigate → observe → decide → act → check-success loop

1. **navigate** — Playwright ensures the browser is at the URL the previous action produced
   (or the task's `startUrl` on step 0).
2. **observe** — the engine builds a *compact structured observation* of the current page
   (see §5). Raw HTML is never sent to the reasoning layer.
3. **decide** — the observation, the objective, the success criteria, and the recent step
   history are given to the reasoning layer (Claude), which returns exactly one action from
   the controlled vocabulary (see §4), plus a short rationale.
4. **act** — the safety layer validates the decision (allowed domain, allowed action, not a
   repeated/looping action, within step/backtrack budgets) and, if it passes, Playwright
   executes it deterministically.
5. **check success** — success criteria from the task JSON are re-evaluated against the new
   page state; active capture modules run if the step warrants a capture; progress is logged.
6. **repeat** until a `stop_*` action is chosen, a limit is hit, or an unrecoverable error
   occurs.

Every iteration produces exactly one `StepLog` entry (see the response schema) containing the
observation, the decision rationale, the selected action, the action result, the current URL,
and progress toward success. Nothing about this loop is automotive-specific.

## 4. Controlled action vocabulary

The reasoning layer never generates Playwright code. It selects one action per step from a
fixed, versioned vocabulary; the engine maps each action to a deterministic Playwright
executor:

- `click` — click a resolved element reference
- `scroll` — scroll the page or an element into view / by an amount
- `wait` — wait for a condition or a bounded timeout
- `go_back` — browser back navigation (counts against `maxBacktracks`)
- `navigate` — go to an explicit URL (must pass the allowed-domain check)
- `capture` — invoke the task's active capture modules against the current page
- `stop_success` — end the run, success criteria considered met
- `stop_blocked` — end the run, a safety constraint prevented progress
- `stop_failure` — end the run, the objective could not be reached

A task's `safety.allowedActions` further restricts this list per run (e.g. a read-only offers
scan need not ever allow `click` past the offers page, though in practice most journeys need
`click`). Adding a new action to the vocabulary is a deliberate, versioned change to
`src/actions` and both JSON schemas — it is not something a task JSON or the reasoning layer
can introduce on its own.

## 5. Compact structured observation

Sending full page HTML to the reasoning model is explicitly disallowed. Instead, each step
produces an `Observation`:

- page `url` and `title`
- a condensed list of `interactiveElements` (role, accessible name, a stable `id` the engine
  can resolve back to a Playwright locator, visibility) — sourced from the accessibility tree
  and visible DOM, not a full serialization
- a short list of `notableText` snippets (headings, banners, prices) when relevant

This keeps prompts small, keeps decisions auditable, and avoids leaking arbitrary page markup
into the reasoning layer or the logs. The observation builder (`src/observation`) is generic;
capture modules may pull additional page-specific detail (e.g. offer card text) directly via
Playwright when a `capture` action runs, but that detail does not need to pass through the
reasoning prompt.

## 6. Reasoning layer

`src/reasoning` is responsible for:

- building a bounded prompt from the objective, success criteria, current observation, and a
  trimmed recent-step history
- calling Claude with a constrained output format (the action vocabulary + target + params +
  short rationale) — enforced by schema/JSON-mode validation, not by trusting free text
- rejecting/re-prompting on a malformed or out-of-vocabulary decision

The reasoning layer is a pluggable client boundary: it is the only place the engine talks to
Claude, and its output is always validated against the same action vocabulary the safety layer
enforces. Prompts live under `/prompts`, are versioned, and are treated as part of the engine's
contract surface (changing them can change navigation behavior).

## 7. Safety / guardrail layer

`src/safety` enforces, independent of what the reasoning layer decides:

- **allowed-domain enforcement** — any `navigate`/redirect target is checked against
  `allowedDomains`; violations force `stop_blocked`
- **maxSteps / maxBacktracks / maxDurationSeconds** — hard ceilings from the task JSON
- **repeated-action detection** — the same (action type, target) pair repeating beyond
  `maxRepeatedActions` forces a stop rather than spinning
- **loop detection** — cycles in the visited-state sequence (e.g. A → B → A → B) are detected
  independent of exact repeated actions
- **no payment/purchase** — the safety schema hard-disallows this (`const: false`); any task
  requesting it is rejected at intake, not just at run time
- **no personal-data entry** — same treatment as payment/purchase
- **no form submission unless explicitly enabled** — `safety.allowFormSubmission` defaults to
  `false`; a `click` that would submit a form is blocked unless the task opts in
- **screenshot + diagnostic capture on failure** — any `stop_failure`, unhandled error, or
  guardrail trip triggers a diagnostic screenshot/log capture regardless of which capture
  modules the task requested

Guardrail trips are recorded as `safetyFlags` on the relevant `StepLog` entry so the response
always explains *why* a run stopped, not just *that* it stopped.

## 8. Capture modules

Capture modules are the only place task-specific extraction logic lives. Each module:

- registers under a stable name (e.g. `data_layer_evidence`, `offer_extraction`)
- is activated per task via `captureModules` in the task request
- runs against the current page when a `capture` action executes (and, for modules like
  `page_visits`/`errors`, opportunistically on every step)
- writes into its own section of `captures` in the response, keeping **raw, website-derived
  evidence** (e.g. the unmodified `dataLayer` array, the literal displayed price text)
  strictly separate from **engine-generated classification** (`engineAssessment` in the
  response — e.g. "objective achieved: true, confidence: 0.9"). This separation is a hard
  requirement: nothing in `captures` may be an engine inference, and nothing in
  `engineAssessment` may be presented as page-observed fact.

v1 ships the module set implied by the two example use cases (`page_visits`, `page_metadata`,
`cta_clicks`, `finish_page_ctas`, `journey_path`, `data_layer_evidence`, `ga4_network_events`,
`screenshots`, `errors`, `offer_extraction`), but the registry is designed to accept new modules
without touching the core loop. `page_metadata` and `finish_page_ctas` were added to the enum by
the local-evidence-capture proof of concept (see `docs/v1-scope.md`). `cta_clicks` and
`journey_path` were added by the action-tracking / journey-path proof of concept: `cta_clicks`
records only the CTAs the engine actually clicked (a different shape — and a different trigger,
the `click` action itself rather than `capture` — than `finish_page_ctas`, which records all
visible CTAs on whichever page a `capture` action runs against, whether clicked or not);
`journey_path` records one ordered entry per completed navigate/observe/decide/act cycle,
derived from the same per-step data already in the response's `steps` array but reshaped as a
standalone, domain-agnostic capture. `errors` records generic technical diagnostics (page JS
errors, console errors, failed network requests, navigation/action failures, missing target
elements, and safety/limit stops) as raw evidence, kept separate from `engineAssessment`; see
below for its triggers.

Most capture modules run only when the `capture` action is dispatched. Some exceptions, driven
by what the evidence actually requires:

- `data_layer_evidence` samples `window.dataLayer` opportunistically on every step (not only on
  `capture`), so evidence reflects each page's own initial and subsequently pushed entries as
  the run crosses multiple pages, not just whichever page happens to be current when `capture`
  runs.
- `ga4_network_events` attaches a request listener for the lifetime of the run (from just
  before the first navigation until the run ends), because GA4-style requests can fire at any
  point in a page's lifecycle, not only when `capture` is dispatched.
- `cta_clicks` runs opportunistically whenever the engine executes a `click` action, not on
  `capture`, because it exists to record actual click events as they happen, not evidence
  visible on demand. Its evidence (visible text, accessible name, element type, destination
  URL) is read from the target element immediately before the click executes, since a click
  can navigate away and take that element with it.
- `journey_path` runs on every completed step regardless of which action was selected, because
  it is the ordered navigation history itself, not evidence pulled from the page.
- `errors` attaches page-level listeners (page JS errors, console errors, failed network
  requests) for the lifetime of the run, from just before the first navigation, for the same
  reason as `ga4_network_events`: these can fire at any point in a page's lifecycle. It also
  records a diagnostic entry directly from the core loop whenever a navigation/action fails or
  times out, a click target isn't found among the observed interactive elements, or a safety
  guardrail (including `maxSteps`/`maxBacktracks`/loop detection) stops the run — none of which
  are tied to the `capture` action either.

## 9. HTTP API boundary (n8n integration)

n8n submits a `task-request` JSON (see `schemas/task-request.schema.json`) over HTTP and
receives a `task-response` JSON (see `schemas/task-response.schema.json`) back. Both are
schema-validated at the boundary. n8n owns everything downstream: forms, Google Sheets,
BigQuery, alerting. See `docs/n8n-integration.md` for the API contract. The engine itself does
not know n8n exists beyond "something calls this HTTP API with a validated JSON body."

## 10. TypeScript folder structure

The v1 scaffold below is built and covered by an automated local proof-of-concept test.
Pieces from the original target layout that are not part of this phase (Claude reasoning
client, HTTP API, browser session manager, structured logging, env/config loading) are noted
as not-yet-built rather than removed from the plan — see §11.

```
/src
  /core                   # generic navigation loop / orchestration state machine
    engine.ts             # top-level runTask(taskRequest) -> taskResponse
    loop.ts               # navigate -> observe -> decide -> act -> check-success iteration
    state.ts              # run state: step count, backtrack count, visited-state history
    successEvaluator.ts    # evaluates successCriteria against the live page

  /actions                # controlled action vocabulary, one deterministic executor each
    click.ts
    scroll.ts
    wait.ts
    goBack.ts
    navigate.ts
    capture.ts
    stopSuccess.ts
    stopBlocked.ts
    stopFailure.ts
    index.ts              # action registry / dispatch table

  /observation            # compact structured page observation, no raw HTML
    observationBuilder.ts

  /reasoning               # pluggable decision-provider boundary
    reasoningProvider.ts    # ReasoningProvider interface
    mockReasoningProvider.ts # deterministic stand-in used by the local PoC; no Claude API call yet

  /capture-modules         # pluggable, task-specific evidence extraction
    pageVisits.ts           # implemented
    pageMetadata.ts         # implemented
    dataLayer.ts             # implemented (data_layer_evidence)
    ga4NetworkEvents.ts      # implemented
    screenshots.ts           # implemented
    finishPageCtas.ts        # implemented
    ctaClicks.ts             # implemented
    journeyPath.ts           # implemented
    errors.ts                # implemented (errors)
    registry.ts             # tracks which of the schema's captureModule names are implemented

  /safety                  # guardrails independent of the reasoning layer
    domainGuard.ts
    limitsGuard.ts
    repeatedActionGuard.ts
    loopDetector.ts
    index.ts               # aggregates the guards into one validateDecision() call

  /types                   # TS types mirroring /schemas/*.json
    actions.ts
    captureModule.ts
    task-request.ts
    task-response.ts

  index.ts

/schemas                   # versioned JSON Schemas (source of truth for the contract)

/examples                  # example task requests per use case

/docs

/tests
  integration/
    local-poc.test.ts      # drives the engine against the local fixture end to end
  fixtures/                 # start.html / success.html used by the local PoC
  helpers/
    staticServer.ts         # local-origin HTTP server for the fixture pages
```

Key intent behind this layout:

- `core`, `actions`, `observation`, `reasoning`, and `safety` contain **zero** references to
  automotive/GA4/brand concepts.
- `capture-modules` is the only directory allowed to know what a "dataLayer event" or an
  "offer card" is, and even there each module only knows its own concern. `page_visits`,
  `page_metadata`, `data_layer_evidence`, `ga4_network_events`, `screenshots`,
  `finish_page_ctas`, `cta_clicks`, `journey_path`, and `errors` are implemented;
  `offer_extraction` remains a reserved name in the schema's `captureModule` enum, not yet
  built.
- `types` mirrors `/schemas/*.json` so the engine's internal types and the wire contract
  cannot silently drift.

## 11. What the v1 scaffold does and does not include

This phase implements the core loop end to end against a **mock reasoning provider** and a
**local HTML fixture** — no network calls to Claude, n8n, or any real website. See
`docs/v1-scope.md` for the full scope boundary. Deliberately not built yet:

- A real Claude-backed `ReasoningProvider` (`reasoningProvider.ts` is the extension point).
- The HTTP API surface for n8n (`/api`), a browser session manager (`/browser`), structured
  per-run logging beyond the response's `steps` array (`/logging`), and env/config loading
  (`/config`).
- Capture modules beyond `page_visits`, `page_metadata`, `data_layer_evidence`,
  `ga4_network_events`, `screenshots`, `finish_page_ctas`, `cta_clicks`, `journey_path`, and
  `errors` (`offer_extraction` remains a reserved name, not yet built).
- `formSubmissionGuard` / `dataEntryGuard` as separate modules — until form submission or
  data entry is exercised by a real task, this stays unimplemented rather than speculative.
- A `/prompts` directory — there is no real prompt to version yet.
