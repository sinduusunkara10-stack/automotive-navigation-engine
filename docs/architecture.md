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

Element `id`s are assigned once via a `data-nav-engine-id` DOM attribute the first time an
element is scanned, and reused on every later scan of the same node -- so an id stays stable
for the lifetime of the page even if the DOM around it reorders. A genuinely hidden element
(`display:none`/`visibility:hidden`/zero size -- e.g. a responsive duplicate nav link kept in
the DOM for another breakpoint) is never offered as a candidate at all: that is a permanent,
safely-determinable fact at scan time, and offering it would let the reasoning layer confuse it
with a visible look-alike. A disabled or currently-covered element *is* still offered (choosing
one is not inherently confused, unlike picking an invisible duplicate); those are point-in-time
facts the engine instead handles safely at execution time, below.

### Action-execution consistency

Because deciding an action is asynchronous (a real reasoning-provider call, or a retry), the
page can change between when an element was observed and when the engine is ready to act on it
-- an SPA re-render, a transient overlay, content removed entirely. `src/core/loop.ts`
revalidates a selected `click` target's live actionability (attached, visible, enabled, not
covered by another element) immediately before dispatching it. A target that has gone stale is
never blindly clicked: the reasoning provider is asked once more, with a freshly rebuilt
observation, so it can pick a different, currently-valid target; if that retry still can't
produce an actionable target, the original decision is dispatched unchanged.

`src/actions/click.ts` is the last line of defence: it revalidates the target itself right
before clicking, and if the click still fails for a recoverable (timeout-class) reason -- the
element was hidden/disabled/covered/detached, or a race changed it at the exact moment of the
click -- it attempts a generic fallback: navigating directly to the element's `destinationUrl`.
This is only ever possible for a real `<a href>` (`destinationUrl` is only ever populated from
`HTMLAnchorElement.href`, never inferred from anchor text), and only when that URL uses an
allowed protocol and is within `allowedDomains` -- otherwise the fallback is rejected and the
action fails normally. A used or rejected fallback, along with the target's role/visible/
attached/enabled state, locator-resolution result, click-error category, and whether
re-observation was attempted, is folded into the existing `errors` capture's free-text
`message` (via the `navigate`-style `navigation_failure` warning on success, or the normal
critical action-failure diagnostic on failure) -- no schema change, since `ErrorCapture.message`
is already generic, free-form text.

## 6. Reasoning layer

`src/reasoning` is a pluggable client boundary behind one interface, `ReasoningProvider`
(`reasoningProvider.ts`): `decide(context: ReasoningContext): Promise<Decision>`. Two
implementations exist:

- `MockReasoningProvider` (`mockReasoningProvider.ts`) — deterministic, no network calls; the
  default provider, used by every automated test and by the API unless overridden.
- `ClaudeReasoningProvider` (`claudeReasoningProvider.ts`) — the real Claude-backed provider.

Both see exactly the same `ReasoningContext`: objective, success criteria,
`allowedActions`/`allowedDomains` for this run, remaining step/backtrack budget, the current
compact `Observation` (never raw HTML), recent action history, and satisfied success-criteria
ids. Neither ever receives a `Page`/browser handle — the reasoning layer cannot reach cookies,
storage, headers, or any DOM beyond what `Observation` already exposes.

### ClaudeReasoningProvider

Selected via `REASONING_PROVIDER=claude` (see README "Reasoning provider selection"). Per
decision:

1. `promptBuilder.ts` builds a bounded system/user prompt from `ReasoningContext` only —
   objective, success criteria, current page url/title/notableText, interactive elements
   (id/type/accessibleName/visible/destinationUrl), `allowedActions`, `allowedDomains`, a
   trimmed recent-action history, and remaining step/backtrack budget. Lists are capped
   (elements, notable text, recent actions) to keep prompts small.
2. `claudeDecisionSchema.ts` builds a strict Zod schema, scoped to this run's `allowedActions`,
   for exactly one decision: `action` (closed enum), `targetElementId` (click only),
   `navigateUrl` (navigate only — validated against `allowedDomains`, never a free `target`
   string Claude could smuggle a selector/script/command through), `reason`, `confidence`, and
   a narrow `params` (only the numeric knobs `scroll`/`wait` already accept).
3. `anthropicReasoningModelClient.ts` — the only file that imports `@anthropic-ai/sdk` — calls
   `client.messages.parse()` with `output_config.format` built from that schema (structured
   outputs; see the Anthropic docs), so the response is schema-validated before it even reaches
   this engine. SDK errors are caught and reduced to a small sanitised category set (e.g.
   `rate_limited`, `authentication_failed`, `timeout`) — raw SDK error text, which could echo
   request details, never crosses this boundary.
4. `validateClaudeDecision.ts` is a second, engine-side check: re-confirms `action` is still in
   `allowedActions`, resolves `targetElementId` against the elements actually observed this
   step, re-validates `navigateUrl` against `allowedDomains` via the same `domainGuard` the
   safety layer uses, and enforces `CLAUDE_MIN_CONFIDENCE` (documented policy: below the
   threshold, the decision is treated as invalid, not silently accepted).
5. On a malformed/invalid/errored response, `ClaudeReasoningProvider` retries **at most once**
   (`CLAUDE_MAX_RETRIES`, hard-capped at 1 regardless of configuration — the same
   never-relaxed-ceiling pattern `src/safety` uses for `maxSteps`/`maxBacktracks`). If no valid
   decision is produced, it returns a safe `stop_blocked` decision rather than throwing —
   `ReasoningProvider.decide()` always resolves to a `Decision`, so the core loop never needs a
   Claude-specific error path. The safety layer in `src/safety` still re-validates whatever any
   provider returns; this is a second line of defence, not a replacement for it.

Per-decision usage metadata (input/output tokens, model, latency, retry count, accept/reject/
error/fallback outcome) is recorded on an in-memory decision log
(`ClaudeReasoningProvider#getDecisionLog()`), never under `captures.*` (raw website evidence)
or `engineAssessment` (engine classification) — see the separation rule in CLAUDE.md.

`ClaudeReasoningProvider#getUsageDiagnostics()` (part of the optional
`ReasoningProvider.getUsageDiagnostics?()` hook) aggregates that same decision log — never a
second usage-tracking mechanism — into the safe, per-run summary the engine attaches at
`TaskResponse.diagnostics.reasoningProvider`: `provider`, `model`, `callCount`,
`acceptedDecisionCount`, `rejectedDecisionCount` (validation failures and provider/API errors
folded together), `fallbackDecisionCount`, `totalInputTokens`, `totalOutputTokens`,
`totalLatencyMs`, `retryCount`, and an optional per-decision `decisions[]` breakdown (step
index where available, attempt, outcome, confidence, input/output tokens, latency). It never
carries prompts, raw model responses, page content, request bodies, API keys, headers, or
credentials, and it reports token counts rather than a computed monetary cost, since model
pricing can change independently of this engine. `MockReasoningProvider#getUsageDiagnostics()`
always reports `provider: "mock"` with every count at zero, so mock runs can never be mistaken
for real Claude API usage. `src/core/engine.ts` resolves one `ReasoningProvider` instance per
run (rather than defaulting per step) precisely so this aggregation reflects the whole run, and
calls `getUsageDiagnostics()` once after the loop ends. See `schemas/task-response.schema.json`
`$defs/reasoningProviderDiagnostics` / `$defs/reasoningProviderDecisionSummary`, and
`TaskResponse.schemaVersion` "1.1.0" (bumped from "1.0.0" for this additive change — no
existing field was removed or renamed).

Configuration (`src/reasoning/config.ts`): `ANTHROPIC_API_KEY` (required, read only from this
env var, never logged), `CLAUDE_MODEL` (default `claude-sonnet-5` — this provider is called
once per navigation step, so a lower-cost/lower-latency model is the conservative default;
override for tasks needing stronger reasoning), `CLAUDE_MAX_OUTPUT_TOKENS`,
`CLAUDE_TIMEOUT_MS`, `CLAUDE_MAX_RETRIES` (hard-capped at 1), `CLAUDE_MIN_CONFIDENCE`.

Provider selection (`src/reasoning/providerFactory.ts`) reads `REASONING_PROVIDER`: unset/empty
defaults safely to `MockReasoningProvider`; `mock`/`claude` select explicitly; any other value
fails clearly (`UnsupportedReasoningProviderError`) rather than silently running the wrong
provider. This is wired in at the API boundary (`src/api/runner.ts`), not in `src/core/loop.ts`
— the core loop still just takes whatever `ReasoningProvider` it is given, keeping provider
selection an application concern, not a core-loop one.

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
    initialNavigation.ts   # the engine's one-off first page.goto(), via robustNavigation.ts
    robustNavigation.ts    # shared domcontentloaded-first goto + timeout-recovery logic,
                            # used by initialNavigation.ts and by src/actions/navigate.ts
                            # and click.ts for in-loop action navigation

  /config                 # env-based configuration, read once and fail-fast at startup
    initialNavigationConfig.ts # INITIAL_NAVIGATION_TIMEOUT_MS
    actionNavigationConfig.ts  # ACTION_NAVIGATION_TIMEOUT_MS (navigate action / clicks that navigate)

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
    mockReasoningProvider.ts # deterministic stand-in; default provider, no Claude API call
    claudeReasoningProvider.ts       # real Claude-backed provider (see §6)
    promptBuilder.ts                 # builds the compact prompt from ReasoningContext
    claudeDecisionSchema.ts          # strict Zod schema for the one-decision structured output
    validateClaudeDecision.ts        # engine-side re-validation before a decision is trusted
    reasoningModelClient.ts          # SDK-agnostic model-client boundary (fakeable in tests)
    anthropicReasoningModelClient.ts # the only file importing @anthropic-ai/sdk
    config.ts                        # env config for ClaudeReasoningProvider
    providerFactory.ts               # REASONING_PROVIDER-based provider selection

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
  unit/
    promptBuilder.test.ts             # asserts the Claude prompt is compact + non-sensitive
    validateClaudeDecision.test.ts    # business-rule validation of a Claude decision
    claudeReasoningProvider.test.ts   # provider behavior via an injected fake model client
    providerFactory.test.ts           # REASONING_PROVIDER selection behavior
    fakes/, helpers/                  # deterministic test doubles, no network/API key
  manual/
    claudeReasoningProviderSmokeTest.ts # opt-in real-API smoke test (see README); not run by npm test
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
**local HTML fixture** by default, plus a real, opt-in **Claude-backed reasoning provider**
(`ClaudeReasoningProvider`, selected via `REASONING_PROVIDER=claude`; see §6) — automated tests
and the default configuration still never make a network call to Claude, n8n, or any real
website. See `docs/v1-scope.md` for the full scope boundary. Deliberately not built yet:

- The HTTP API surface for n8n (`/api`) exists as a local proof of concept only (see
  README.md "Local HTTP API"); a browser session manager (`/browser`) and structured
  per-run logging beyond the response's `steps` array plus `ClaudeReasoningProvider`'s
  in-memory decision log (`/logging`) remain unbuilt. A general env/config loading module
  now exists at `src/config` (`initialNavigationConfig.ts`, `actionNavigationConfig.ts`),
  alongside the reasoning-provider-scoped `src/reasoning/config.ts`.
- Computing a monetary cost from reasoning-provider token usage — `diagnostics.reasoningProvider`
  reports raw token counts (see §6) so cost can be computed downstream against whatever pricing
  applies at query time; the engine deliberately never hardcodes a per-token price.
- Using `TaskRequest.outputSchemaVersion` to change what shape of response the engine returns —
  it is validated at intake but the engine always returns the current `TaskResponse.schemaVersion`
  ("1.1.0") regardless of what a caller declares it expects; version-negotiated response shapes
  are not built.
- Capture modules beyond `page_visits`, `page_metadata`, `data_layer_evidence`,
  `ga4_network_events`, `screenshots`, `finish_page_ctas`, `cta_clicks`, `journey_path`, and
  `errors` (`offer_extraction` remains a reserved name, not yet built).
- `formSubmissionGuard` / `dataEntryGuard` as separate modules — until form submission or
  data entry is exercised by a real task, this stays unimplemented rather than speculative.
- A `/prompts` directory — the Claude prompt lives in `src/reasoning/promptBuilder.ts` and is
  covered by `tests/unit/promptBuilder.test.ts`, but is not yet split into a separately
  versioned `/prompts` asset.
