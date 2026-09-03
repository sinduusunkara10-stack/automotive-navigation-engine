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
| **Preflight domain discovery** (`src/discovery`) | Generic URL/hostname safety, Public Suffix List registrable-domain matching, redirect/canonical/anchor signal gathering, objective-text overlap scoring | Automotive, GA4, dataLayer, or any brand/site-specific concept -- see §12 |
| **Capture modules** (`src/capture-modules`) | How to pull a specific kind of evidence off a page (dataLayer contents, GA4 network calls, offer text) | Navigation strategy, when to stop, how to decide the next action |

A new use case (e.g. "capture cookie-consent banners" or "capture stock availability") should
be addable as a new capture module and a new task JSON, **without touching the core loop**.

## 3. The navigate → observe → decide → act → check-success loop

Before this loop ever starts, a deterministic **preflight domain-discovery phase** runs once
(see §12): it performs the engine's initial navigation to `startUrl`, and from that navigation
(and only that navigation -- never a live browser, never the reasoning layer) proposes the
`allowedDomains` set the rest of the run enforces. A caller is never required to enumerate
every domain/subdomain a journey might use.

1. **navigate** — Playwright ensures the browser is at the URL the previous action produced
   (or the task's `startUrl` on step 0, already reached by preflight discovery).
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
   `src/core/successEvaluator.ts` implements `url_pattern`, `element_present`, and the generic,
   selector/URL-free `semantic_page_match` (objective-vocabulary overlap against page
   title/headings/interactive-element text, via `src/core/semanticPageMatch.ts`); see
   `docs/n8n-integration.md` §9 for the full evaluation model and why the other two enum
   values require destination-specific knowledge a caller may not have in advance.
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
  can resolve back to a Playwright locator, visibility, and optionally `disabled`, `ariaState`,
  and `covered`) — sourced from the accessibility tree and visible DOM, not a full serialization
- a short list of `notableText` snippets (headings, banners, prices) when relevant
- an optional `progressIndicatorText` list, when the page marks up a progress/step indicator

This keeps prompts small, keeps decisions auditable, and avoids leaking arbitrary page markup
into the reasoning layer or the logs. The observation builder (`src/observation`) is generic;
capture modules may pull additional page-specific detail (e.g. offer card text) directly via
Playwright when a `capture` action runs, but that detail does not need to pass through the
reasoning prompt.

### Observation evidence: interactive-element selector, ARIA state, headings

The interactive-element selector is intentionally broader than plain anchors and buttons —
`a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"],
[role="radio"], [role="checkbox"], input[type="submit"], input[type="button"]` — so a
configurator's custom tab strip, option chips, or radio/checkbox-style controls are visible
candidates, not just conventional links and buttons. `notableText` now scans `h1`-`h4` (was
`h1`-`h2`), since a configuration step's own heading is frequently nested under a page-level
`h1`/`h2`. Each interactive element optionally carries `disabled` (from the `disabled`
attribute or `aria-disabled="true"`), `ariaState` — the element's `aria-selected`/
`aria-checked`/`aria-pressed`/`aria-current` attribute values, read verbatim and never
normalised into an engine-defined closed set of states, so no future ARIA value a site might
use ever requires an engine change — and `covered`, true when another element (a modal,
overlay, or banner) currently sits visually on top of the element's centre point, using the
same `elementFromPoint` hit-test `src/core/loop.ts`'s pre-dispatch revalidation and
`src/actions/click.ts`'s fallback already use (see "Action-execution consistency" below) —
computed up front here too so the reasoning layer itself can see a control is not currently
reachable instead of only discovering that after proposing a click that then fails.
`progressIndicatorText` is read the same way, from any
element the page marks up via `role="progressbar"`, `aria-valuenow`, or `aria-current="step"`.
`src/core/semanticPageMatch.ts`'s `gatherSemanticPageSignals` uses the same selectors (plus
optional `ariaState`/`progressText` evidence, forwarded only to an optional `semanticVerifier`,
never scored by the deterministic lexical evaluator) so success evaluation never sees narrower
evidence than the reasoning layer's own observation.

This still never traverses into an `<iframe>` or a shadow DOM — `document.querySelectorAll`
only reaches the light DOM of the top-level document, exactly as before. That stays deliberately
out of scope: nothing in this repo's fixtures, examples, or reported production behaviour has
shown a target site's configurator/lead-form controls living inside an iframe or a shadow root,
so adding that traversal now would be speculative complexity with no concrete evidence backing
it. If a future task surfaces a site where the reasoning layer legitimately cannot see or
interact with a control because it is inside an iframe/shadow root, that is the point to revisit
this — with the concrete site/DOM evidence in hand, not before.

Element `id`s are assigned once via a `data-nav-engine-id` DOM attribute the first time an
element is scanned, and reused on every later scan of the same node -- so an id stays stable
for the lifetime of the page even if the DOM around it reorders. A genuinely hidden element
(`display:none`/`visibility:hidden`/zero size -- e.g. a responsive duplicate nav link kept in
the DOM for another breakpoint) is never offered as a candidate at all: that is a permanent,
safely-determinable fact at scan time, and offering it would let the reasoning layer confuse it
with a visible look-alike. A disabled or currently-covered element *is* still offered (choosing
one is not inherently confused, unlike picking an invisible duplicate) — both are reported as
`disabled`/`covered` evidence on the element so the reasoning layer can factor them into its own
choice (the system prompt instructs it to prefer an uncovered, objective-matching control over a
covered one, and that dismissing a blocker is never itself the objective), but both remain
point-in-time facts that can change between decision and dispatch, which is why the engine also
still handles them safely at execution time, below.

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

### SemanticCriterionVerifier (multilingual `semantic_page_match` fallback)

`src/reasoning/semanticCriterionVerifier.ts` defines a second, deliberately separate boundary:
`SemanticCriterionVerifier.verify(input): Promise<SemanticVerificationOutcome>`. This is **not**
a `ReasoningProvider` and never selects a navigation action — it exists only to adjudicate a
`semantic_page_match` success criterion (`src/core/successEvaluator.ts`) that the deterministic
lexical token-overlap evaluator could not already satisfy, most notably when the objective and
the destination page are written in different languages. `ClaudeSemanticCriterionVerifier`
reuses the exact same `ReasoningModelClient` boundary, structured-output pattern, and
hard-capped single-retry policy as `ClaudeReasoningProvider` above (same auth, same model
config, no new external dependency) but with its own prompt, its own Zod schema
(`semanticVerificationSchema.ts`), and its own decision log — a navigation decision and a
success-criterion verification are never the same model call. It fails closed (never satisfied)
on any malformed output, sub-threshold confidence, missing evidence, or provider error, and
caches verdicts per `(objective, criterion description, page evidence)` so an unchanged page is
never re-verified. `runTask({ ..., semanticVerifier })` takes this as an optional parameter,
omitted by default — every existing caller/task gets byte-for-byte the same deterministic-only
`semantic_page_match` evaluation as before this component existed. `src/api/runner.ts` wires one
in automatically (reusing the `claude` reasoning provider's own config) exactly when
`REASONING_PROVIDER=claude`. `verify()`'s input optionally carries `ariaState`/`progressText`
(from the same widened `gatherSemanticPageSignals` observation evidence — see §5) and an
optional `lastActionEvidence` (the accessible name/text/element type of the most recently
clicked control, sourced from the same read `src/capture-modules/ctaClicks.ts` already does for
the `cta_clicks` capture — never a second DOM read). This is what lets a criterion's own
description generically require that a *specific* control was activated (e.g. "the final
completion control — Summary, Continue, or an equivalent — was clicked"), verified by the model
against the actual click by meaning, never by a literal word/brand-label check anywhere in the
engine: a right-looking page reached some other way does not satisfy such a criterion. All three
fields are optional and participate in the verifier's own cache key, so omitting them (every
pre-existing caller) is byte-for-byte unchanged. Its usage is aggregated the same way as
`ReasoningProviderDiagnostics` above, at `TaskResponse.diagnostics.semanticVerifier`
(`$defs/semanticVerifierDiagnostics` in `schemas/task-response.schema.json`). Full design
rationale, false-positive protections, and cost analysis: `docs/n8n-integration.md` §"Generic
multilingual semantic_page_match verification".

`src/core/loop.ts` separately guards against a reasoning layer repeatedly proposing
`stop_success` against page evidence that hasn't changed at all since the last rejection
(independent of language): a second consecutive rejection with an identical
`(url, satisfied required criteria, missing required criteria)` fingerprint ends the run
immediately (`status: "failure"`, `finishReason: "no_progress_required_criteria_unmet"`) rather
than waiting for `maxSteps` or the repeated-action guard. See `docs/n8n-integration.md`
§"Repeated-decision and cost control".

## 7. Safety / guardrail layer

`src/safety` enforces, independent of what the reasoning layer decides:

- **allowed-domain enforcement** — any `navigate`/redirect target is checked against
  `allowedDomains`; violations force `stop_blocked`. `allowedDomains` itself is the union of
  whatever the task JSON declared (now optional -- see §12) and whatever preflight domain
  discovery proposed; `src/safety` enforces that combined set the same way regardless of
  where each entry came from
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

### Generic action-attributed analytics capture

Every journey (configurator, test drive, dealer locator, ...) needs the same kind of evidence
about the clicks the engine actually made: what was clicked, what changed as a result, and
whether that click actually advanced the journey. Rather than a per-journey capture function,
this is one generic mechanism, layered onto the existing `cta_clicks` capture (which already
records every dispatched `click` unconditionally, gated only on `captureModules` — see above):
when a task also requests `data_layer_evidence` and/or `ga4_network_events`, each `cta_clicks`
entry additionally carries an `actionAnalytics` object built entirely from evidence the engine
already reads or already collects elsewhere — no new browser reads beyond a `dataLayer`
before/after snapshot pair and a `page.title()` read, and no additional model call:

- `dataLayerDelta` — a generic, mechanical before/after **delta** of `window.dataLayer`
  around this one click (`src/capture-modules/dataLayerDelta.ts`), never a full re-snapshot.
  `available` distinguishes "no `dataLayer` array exists at all" from "it exists but nothing
  new was pushed" (empty `newEntries`); `replaced` flags the array having been reset or
  reassigned (including the ordinary case of a full page navigation, which always starts a
  fresh JS context) rather than appended to, in which case `newEntries` is the entire post-click
  array rather than a suffix.
- `ga4RequestsObservedDuringActionWindow` — GA4-style requests observed in a short, fixed
  window (`GA4_ACTION_WINDOW_MS`, 300ms) immediately after the click, sliced from the same
  persistent `ga4_network_events` listener that already runs for the run's whole lifetime (no
  second listener). Named `...ObservedDuringActionWindow`, deliberately never
  `...CausedByClick` or similar: a request observed inside this window is temporally
  correlated with the click, never asserted to have been caused by it.
- `advancedJourney` — `true` iff the click's resulting URL or title differs from before it, or
  a success criterion newly became satisfied as a direct result of it. A purely mechanical
  fact, not a model judgement.
- `newlySatisfiedCriteriaIds` — ids of success criteria that were unsatisfied before this click
  and satisfied immediately after it, computed as the delta of the engine's own
  `satisfiedCriteriaIds` around this one click.
- `verifierDecisions` — any `SemanticCriterionVerifier` decisions made while evaluating success
  criteria immediately after this click (sliced from that verifier's own decision log), so a
  verifier verdict is directly attributable to the click that produced it.

Every field composes with which capture modules the task actually requested: `dataLayerDelta`
is present only when `data_layer_evidence` was also requested; `ga4RequestsObservedDuringActionWindow`
only when `ga4_network_events` was; `advancedJourney` is always present whenever `cta_clicks` is
requested and a click was dispatched, since it costs nothing extra to compute. No new
capture-module name or task-request field was needed for any of this.

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
    semanticPageMatch.ts    # generic objective-vocabulary-overlap scoring for the
                            # semantic_page_match criterion type, used only by successEvaluator.ts
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

  /discovery               # deterministic preflight domain discovery (see §12), runs once
                            # before the Claude-driven loop starts -- no reasoning-layer call
    registrableDomain.ts    # PSL-backed eTLD+1 lookup (tldts), never string-splitting
    hostSafety.ts            # protocol/localhost/loopback/link-local URL safety checks
    relevance.ts              # generic objective-text overlap scoring for candidate links
    pageSignals.ts             # Playwright: canonical URL + candidate anchors off the live DOM
    domainDiscovery.ts          # pure computeDomainDiscovery() + runDomainDiscovery() orchestrator
    index.ts                     # barrel export

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
    dataLayerDelta.ts        # implemented -- generic before/after dataLayer delta used by
                              # the action-attributed analytics capture below, distinct from
                              # dataLayer.ts's own per-step full-snapshot capture
    ga4NetworkEvents.ts      # implemented
    screenshots.ts           # implemented
    finishPageCtas.ts        # implemented
    ctaClicks.ts             # implemented -- also builds the optional actionAnalytics
                              # object (generic action-attributed analytics capture, §8)
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

- `core`, `actions`, `observation`, `reasoning`, `safety`, and `discovery` contain **zero**
  references to automotive/GA4/brand concepts.
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
  ("1.2.0") regardless of what a caller declares it expects; version-negotiated response shapes
  are not built.
- Capture modules beyond `page_visits`, `page_metadata`, `data_layer_evidence`,
  `ga4_network_events`, `screenshots`, `finish_page_ctas`, `cta_clicks`, `journey_path`, and
  `errors` (`offer_extraction` remains a reserved name, not yet built).
- `formSubmissionGuard` / `dataEntryGuard` as separate modules — until form submission or
  data entry is exercised by a real task, this stays unimplemented rather than speculative.
- A `/prompts` directory — the Claude prompt lives in `src/reasoning/promptBuilder.ts` and is
  covered by `tests/unit/promptBuilder.test.ts`, but is not yet split into a separately
  versioned `/prompts` asset.

## 12. Preflight domain discovery

A caller submitting a task should never be required to already know every domain and
subdomain a journey might touch (e.g. that a configurator lives on a separate
`configurator.` subdomain from the marketing site's `www.`). `src/discovery` implements a
**deterministic preflight phase** that runs once, before the Claude-driven navigate → observe
→ decide → act loop ever starts, and produces the `allowedDomains` set the rest of the run
enforces. Nothing in this phase calls the reasoning layer, and nothing in it is
automotive/GA4/brand-specific — see §2's layer table.

### What preflight does

1. **Validates `startUrl` with the standard URL parser** (`new URL(...)`, never string
   splitting or a regex). A non-http/https protocol, or a URL that doesn't parse at all, is
   rejected before any navigation is attempted (`src/discovery/hostSafety.ts`,
   `assessUrlSafety`).
2. **Performs the engine's one-off initial navigation** to `startUrl` (via
   `src/core/initialNavigation.ts`, reusing the existing domcontentloaded-first
   goto + timeout-recovery logic), capturing the actual HTTP **redirect chain**
   Playwright observed (`src/core/robustNavigation.ts`'s `RobustGotoOutcome.redirectChain`,
   built from the navigation `Response`'s `request().redirectedFrom()` chain).
3. **Determines the registrable domain** (eTLD+1) of the start hostname and the redirect
   landing hostname via `tldts`, a maintained Node.js library backed by the Public Suffix
   List — never derived by splitting or regexing the last two hostname labels (which breaks
   on multi-label public suffixes like `co.uk` or `github.io`). See
   `src/discovery/registrableDomain.ts`.
4. **Inspects the landed page** (`src/discovery/pageSignals.ts`) for:
   - its `<link rel="canonical">` URL, when present;
   - **visible actionable anchors** (any `<a href>` that is actually rendered, same
     visibility test the observation builder uses);
   - **relevant navigation anchors** — anchors inside a generic semantic landmark (`<nav>`,
     `[role="navigation"]`, `<header>`, `<footer>`), never a brand-specific selector;
   - **candidates likely to help achieve the objective** — anchors whose visible/accessible
     text shares words with the task's `objective` (and optional `journeyType` hint), via a
     generic token-overlap score (`src/discovery/relevance.ts`) with no automotive/CTA
     vocabulary baked in.
5. **Produces a proposed `allowedDomains` list** (`computeDomainDiscovery` in
   `src/discovery/domainDiscovery.ts`) *before* the main navigation task begins, per the
   conservative validation policy below. `src/core/engine.ts` unions this with whatever
   `allowedDomains` the caller explicitly supplied (if any) into the final set the safety
   layer (§7) enforces for the whole run, and reports the full picture at
   `TaskResponse.diagnostics.domainDiscovery` (`schemas/task-response.schema.json`
   `$defs/domainDiscoveryDiagnostics`).

### Conservative candidate-validation policy

**Automatically trusted**, no caller/operator review needed:

- the **exact `startUrl` hostname** — the caller's own explicit choice;
- the **redirect-landing hostname**, when it differs from the start hostname — a direct,
  server-controlled consequence of navigating to the caller-approved `startUrl`, not page
  content a third party could plant;
- any hostname — found via the redirect landing, the canonical URL, or any anchor — that
  shares a **PSL registrable domain** with the start host or the landing host (a
  same-organization subdomain, e.g. discovering `configurator.example.com` from
  `www.example.com`).

**Never automatically trusted:** a hostname on a *different* registrable domain, however it
was discovered — a canonical tag, a nav-landmark link, or even a link whose text closely
matches the objective. A page's own content (including its `<link rel="canonical">`) is not
proof that the site owner intends the engine to navigate there; it is surfaced as an
`externalCandidates` entry, with the evidence that produced it, so a caller/operator can
review it and add it to the task's `allowedDomains` explicitly if the run is meant to cross
into it. **A candidate external registrable domain is never trusted merely because it
appears in a link.**

**Always rejected as a candidate**, regardless of source (redirect, canonical, anchor):

- any protocol other than `http`/`https` (`mailto:`, `tel:`, `javascript:`, `data:`, `ftp:`,
  ...);
- `localhost` (and any `.localhost` host);
- loopback addresses (`127.0.0.0/8`, `::1`);
- link-local addresses (`169.254.0.0/16`, `fe80::/10`).

The one exemption from the last three checks is the caller's own explicit `startUrl` host
(`hostSafety.ts`'s `allowLoopbackAndLinkLocal` option) — a caller may deliberately point the
engine at a local/dev target (this repo's own fixtures run on `127.0.0.1`), and that is the
caller's choice to make. Every host *discovered* during preflight — a redirect landing on a
different host, a canonical URL, a page anchor — is always assessed with that exemption left
off, precisely so a page cannot smuggle in trust for an internal/loopback target (e.g. a
cloud metadata endpoint) just by linking to it. If the redirect landing host itself (or an
intermediate redirect hop) fails this check, preflight blocks the run outright
(`DomainDiscoveryResult.blockedReason`) rather than proceeding with an unsafe navigation.

### What the caller sees

`TaskRequest.allowedDomains` is now **optional** (schema `1.1.0`; previously required with
`minItems: 1`). When present, every listed hostname is still trusted unconditionally, on top
of whatever preflight discovers. `TaskRequest.journeyType` is a new optional free-text field,
purely advisory — blended into the same objective-relevance scoring, never parsed for
domain-specific control flow. `TaskResponse.diagnostics.domainDiscovery` (schema `1.2.0`)
reports `trustedDomains` (hostname + reason + evidence), `externalCandidates` (never
auto-trusted, with the evidence and reason why), `rejectedCandidates` (what was rejected and
why), `proposedAllowedDomains` (what preflight itself added), and `allowedDomainsUsed` (the
final enforced set) — see `examples/minimal-preflight-discovery-task.json` for a task that
supplies only `startUrl`, `objective`, and `journeyType`.
