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
  `covered`, `frameOrigin`, and `nearestHeadingText`) — sourced from the accessibility tree and
  visible DOM, not a full serialization
- a short list of `notableText` snippets (headings, banners, prices) when relevant
- an optional `progressIndicatorText` list, when the page marks up a progress/step indicator
- an optional `activeDialog` (role + short accessible-name excerpt), when a visible
  `role="dialog"`/`aria-modal="true"`/native `<dialog>` surface is open — see §18

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

One level of generic, same-origin child-frame scanning is now in scope (see "Frame-aware
observation" below) — a real production run showed a blocker's live control living inside an
`<iframe>`. Shadow DOM *traversal* remains out of scope: `document.querySelectorAll` cannot see
into any shadow root, open or closed, and nothing in this repo's fixtures, examples, or
confirmed production behaviour has yet *proven* a target site's configurator/lead-form controls
live inside one, so adding that traversal now would still be speculative complexity without
confirmed evidence backing it. Nested iframes (a frame within a frame) are likewise still out of
scope for the same reason.

What **is** now in scope, precisely to let a future investigation supply that missing evidence
rather than guess at it: `Observation.elementDiscoveryDiagnostics` (response `schemaVersion`
`"1.6.0"`, `src/observation/observationBuilder.ts`) — bounded, generic counts about the
interactive-element scan itself (raw candidate count before filtering, button-like/link-like/
other-role counts, per-reason excluded counts, and `shadowHostCount`, the number of elements in
the document with a non-null *open* shadow root). A production run reporting zero interactive
elements while a manual inspection of the same URL immediately afterwards showed a visible,
clickable control is the exact symptom a shadow-DOM-encapsulated control would produce
(`rawElementCount: 0` alongside `shadowHostCount > 0`) — `tests/unit/
elementDiscoveryDiagnostics.test.ts` proves this mechanism in a controlled fixture. `shadowHostCount`
only ever detects an *open* shadow root; a closed one is fundamentally undetectable from outside
the component that created it, so `shadowHostCount: 0` does not itself rule out closed-shadow-DOM
containment. If a future run's own `elementDiscoveryDiagnostics` confirms `shadowHostCount > 0`
against `rawElementCount: 0`, that is the concrete evidence to revisit full shadow-DOM traversal.

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
-- an SPA re-render, a transient overlay appearing or clearing itself, content removed or
replaced entirely. `src/core/loop.ts` revalidates a selected `click` target's live actionability
(attached, visible, enabled, not covered by another element, its owning frame still available)
immediately before dispatching it, in a small bounded loop (`MAX_STALE_TARGET_RECOVERY_ATTEMPTS`,
currently 3): a target that has gone stale is never blindly clicked -- the reasoning provider is
asked again, with a freshly rebuilt observation, so it can pick a different, currently-valid
target. If every attempt in the loop is exhausted, the *last* decision is dispatched unchanged --
`src/actions/click.ts`'s own pre-dispatch check and `destinationUrl` fallback (below) remain the
final safety net, and a resulting failure is itself non-fatal (see "Blocker recovery" below)
rather than ending the run.

`src/actions/click.ts` is the last line of defence: it revalidates the target itself right
before clicking (resolving a frame-scoped id against its *live* owning frame every time -- see
"Frame-aware observation" below), and if the click still fails for a recoverable (timeout-class)
reason -- the element was hidden/disabled/covered/detached, its frame became unavailable, or a
race changed it at the exact moment of the click -- it attempts a generic fallback: navigating
directly to the element's `destinationUrl`. This is only ever possible for a real `<a href>`
(`destinationUrl` is only ever populated from `HTMLAnchorElement.href`, never inferred from
anchor text), and only when that URL uses an allowed protocol (`http`/`https` only -- never
`javascript:`, `data:`, or any other scheme) and is within `allowedDomains` -- otherwise the
fallback is rejected and the action fails normally. A used or rejected fallback, along with the
target's role/visible/attached/enabled state, locator-resolution result, click-error category,
and whether re-observation was attempted, is folded into the existing `errors` capture's
free-text `message` (via the `navigate`-style `navigation_failure` warning on success, or the
`stale_target_recovery`/normal critical action-failure diagnostic on failure).

### Blocker recovery

A real production run can encounter a control that looks identical, in one observation, to a
genuinely clickable one -- reachable when it was observed, but gone (hidden, detached, covered,
timed out, or its owning frame removed) by the time the engine actually tries to dispatch a click
on it. A consent/preference banner is the most common source of this (a CMP re-rendering or
auto-clearing itself right as a decision is made), but nothing in this mechanism is specific to
consent, cookies, or any vendor -- it applies to any control that races between decision and
dispatch.

`ActionResult.staleTarget` (set by `src/actions/click.ts`) marks a failed click whose cause was
mechanically classified this way -- as distinct from `disabled` (a legitimate, already-visible
fact, not a race) and from a genuinely unknown Playwright error. `src/core/loop.ts` tracks
*consecutive* staleTarget failures in `RunState.consecutiveStaleTargetFailures`, reset to 0 the
moment a step makes real progress (any successful action, or a non-click action). A staleTarget
failure does not by itself end the run: the step simply completes without a terminal status, and
the outer loop (`src/core/engine.ts`) calls `runStep` again, which starts with a brand-new
`buildObservation` -- another chance for the reasoning provider to see the current, accurate
state and choose accordingly. Only once the *same* fixed, generic bound
(`MAX_STALE_TARGET_RECOVERY_ATTEMPTS`) is exceeded does the run stop, with the precise
`stale_target_recovery_exhausted` reason (never the generic `action_execution_error`) -- this is
deliberately a *tighter*, dedicated bound, independent of (and reached well before) the existing
repeated-action guard and `maxSteps`, both of which remain fully in effect as secondary
safety nets if a reasoning provider keeps proposing the exact same broken target.

The reasoning layer's own latitude to interact with a consent/preference-shaped control at all is
governed by `safety.consentInteractionPolicy` (`types/task-request.ts`) -- `"reject_optional"`
(the default), `"essential_only"`, `"accept_optional"` (an explicit, never-default opt-in to
actually grant optional consent when a control for doing so is visible, not merely a last resort
for unblocking a control that's reachable regardless of the consent choice made), or
`"do_not_interact"`. This is surfaced to the model as one short, plain-language system-prompt
clause (`src/reasoning/promptBuilder.ts`) driven entirely by the enum value -- there is no
CTA-word dictionary, translation table, or vendor-specific selector anywhere in the engine. Which
*specific* control best fits the resulting semantic description (e.g. "a control that declines
optional data collection") is left to the model's own judgement, exactly like every other action
choice in this prompt (e.g. preferring a "summary" vs. "continue"-purposed control). The engine
never keyword-matches "accept"/"reject" text and never itself decides which button is which -- see
"Deterministic consent-policy enforcement" below for how the engine still checks the *outcome* of
that judgement without ever inspecting the control itself.

Dismissing a blocker is never itself treated as satisfying the objective: a click's
`actionAnalytics.newlySatisfiedCriteriaIds` only ever reflects a success criterion the engine
independently evaluated as newly true, and a criterion is never written to be trivially satisfied
by any click.

### Frame-aware observation

One level of generic, same-origin child-frame scanning (`src/observation/frames.ts`) lets the
engine see and act on a blocker (or any control) whose live element happens to live inside an
`<iframe>`, without any vendor/CMP-specific iframe selector: `buildObservation` runs the exact
same interactive-element scan against each accessible direct child frame of the main document,
and each resulting element carries a frame-scoped id (`frameN:<local-id>`) plus `frameOrigin`
(scheme+host+port only, never a full URL) so the reasoning layer and diagnostics can tell it
apart from a main-document element. `readElementState` and `actions/click.ts` re-resolve a
frame-scoped id against the *live* frame list every time (never a cached handle), since frames
are dynamic. A frame the engine cannot evaluate script in at all -- removed between the
accessibility probe and the scan, or otherwise inaccessible, including a cross-origin frame a
given embed configuration refuses script access to -- is never silently skipped in a way that
could let the engine fall back to clicking an unrelated, possibly-hidden main-document element
instead: it contributes no candidates, is reported only as an origin on
`Observation.inaccessibleFrameOrigins` (bounded, capped small), and a click that later targets it
(a frame-scoped id whose frame no longer resolves) is classified `frame_unavailable` -- the same
staleTarget-recoverable category as any other race. This stays deliberately shallow (one level,
not recursive into nested frames, and no shadow-DOM traversal) -- see the "Observation evidence"
note above on why iframe/shadow-DOM support otherwise stays out of scope until a concrete site
shows it's needed; a real production run has now shown exactly that need for one level of
same-origin iframe support.

### Diagnostics for blocker recovery

Beyond the free-text diagnostics above, three structured fields let a caller answer "was a
blocker genuinely present, and how did the engine recover" directly from Get Task Result, without
parsing message text: `StepLog.reObservationAttempted` and `StepLog.recoveryAttempts` (was the
pre-dispatch bounded loop used this step, and how many cycles), and `ActionResult.staleTarget` on
any action that failed for a recoverable reason. Combined with the already-untruncated
`StepLog.observation.interactiveElements[].covered`/`visible`/`disabled` on every step, these are
enough to reconstruct, for any step: which candidate was selected, whether it was actionable when
observed, whether recovery was attempted, and whether the run ultimately proceeded -- without the
engine ever computing or asserting a semantic judgement like "this was the consent banner" on the
caller's behalf (it has no generic, reliable way to know that, and inventing one would violate the
same rule that keeps CTA wording out of the core loop).

The optional `host_context_snapshot` capture module (`src/capture-modules/hostContext.ts`)
answers a narrower, related question -- did state actually carry across a cross-host transition
-- with a bounded, **names-only** footprint: cookie name/domain pairs from the whole browser
context's cookie jar, and localStorage/sessionStorage key names from the current page's own
origin, captured only on the step a run's hostname changes (including the very first step, as a
landing-host baseline). Never a cookie or storage *value*. It deliberately never attempts to
classify a name/key as "consent-related" -- that would require exactly the kind of
vendor-specific dictionary the core must not contain; every name/key present is reported, and a
human or downstream analysis decides what's relevant. `src/core/engine.ts`'s single Playwright
`Page`/`BrowserContext` is reused for the whole run (a normal same-tab navigation keeps the same
cookie jar throughout, whether or not it ends up crossing hosts); localStorage/sessionStorage,
by ordinary browser design, are always scoped to the origin that's currently loaded, so a
same-registrable-domain transition between two different hostnames (e.g. a landing page and a
configurator on separate subdomains) inherently starts each with fresh, empty storage even though
cookies set on a shared parent domain may still be present -- this snapshot lets a caller confirm
that empirically for a real run instead of the engine having to guess at or assert it.

### Blocker-signature persistence tracking

A follow-up production incident showed a gap in the recovery above: a consent overlay was
"dismissed" via a control that succeeded mechanically but never actually cleared the overlay,
after which four different candidate targets were each intercepted by the same still-present
obstruction, spending a reasoning-provider call on each before `stale_target_recovery_exhausted`
was finally reached. Two related problems, both purely generic, no consent-specific detection:

- A click's *mechanical* success (no Playwright error) was the only signal ever used to decide
  whether a blocking overlay had been cleared -- never re-verified against the control it was
  actually blocking.
- Each newly-proposed candidate target spent a fresh reasoning call, even when the *page state*
  causing the failure (the intercepting element itself) had not changed at all since the last
  attempt.

`RunState.lastBlockerTargetId`/`lastBlockerSignature`/`blockerSignatureRepeatCount`
(`src/core/state.ts`) track whichever element most recently failed as covered/intercepted, and a
compact, generic fingerprint of whatever is intercepting it --
`ElementState.coveredBySignature` (`src/observation/observationBuilder.ts`), built purely from
the intercepting element's own tag/role/trimmed text via the same `elementFromPoint` hit-test
`covered` already uses, never a brand/vendor-specific selector.

`src/core/loop.ts` consults this at two points, both re-verifying the tracked target's *live*
`covered` state directly rather than trusting any click's mechanical success:

- **Proactively**, at the top of a step, if nothing is yet tracked: whichever covered element (if
  any) the fresh observation already shows becomes the tracked blocker, so a subsequent
  dismiss-type click's actual effect gets verified next step regardless of whether that click
  itself ever fails.
- **Before spending a reasoning call** (both the very first decision of a step, and the
  pre-dispatch revalidation loop's own retries): if the tracked target is still covered by the
  *exact same* signature as last time, one repeat is still allowed (a provider always gets at
  least one chance to react); a second consecutive occurrence of the identical signature skips
  the reasoning call entirely and is recorded as a deterministic stale-target occurrence instead,
  feeding the *same* `consecutiveStaleTargetFailures` ceiling the existing bounded recovery above
  already uses -- a permanently stuck overlay still reaches `stale_target_recovery_exhausted`
  exactly as before, just without spending every remaining reasoning call finding that out.

Tracking clears the moment the target is confirmed no longer covered, or covered by a visibly
different element (a different signature) -- never assumed cleared just because some click
happened to succeed. This applies identically to a consent overlay, a loading/busy panel, or any
other obstruction: the mechanism never inspects control text or purpose, only the intercepting
element's own generic identity.

Separately, `safety.consentInteractionPolicy`'s `"reject_optional"` system-prompt clause
(`src/reasoning/promptBuilder.ts`) was strengthened to explicitly state that a decline-and-continue
control is preferred over a manage/settings control even when both are visible -- still a
plain-language instruction to the model, not a keyword-matched or enforced choice, consistent with
this mechanism's existing design.

### Deterministic consent-policy enforcement

A real production run (Nissan UK) showed that the plain-language prompt clause above is not, by
itself, enough: `consentInteractionPolicy` was `"accept_optional"`, but the reasoning layer chose
the necessary-only cookie-banner control anyway, reasoning that minimal consent was preferred --
because a cookie banner's necessary-only control almost always dismisses the banner just as well
as its accept-all counterpart, `"accept_optional"`'s previous wording ("solely to clear a blocking
control... never when the objective is reachable without it") made it behaviourally
indistinguishable from `"reject_optional"` in the exact scenario it exists for, and nothing in the
engine checked the *outcome* of the model's choice against the requested policy.

Two changes close this gap, both staying inside this mechanism's existing generic, semantic-
judgement design:

- `"accept_optional"`'s prompt wording (above) no longer gates granting optional consent behind
  blocking-overlay necessity: it now states plainly that accepting optional consent is itself the
  desired outcome under this policy, to be preferred whenever a control for it is visible.
- Every decision's structured output now also includes a required, self-reported
  `consentControlIntent` (`types/consentControl.ts`): `"grants_optional_consent"`,
  `"declines_optional_consent"`, `"opens_consent_settings"`, or `"not_consent_related"` (the
  correct value for the overwhelming majority of decisions) -- classified by the model using the
  same generic, language-agnostic semantic judgement as everything else in this prompt, never a
  fixed wordlist. `src/safety/consentPolicyGuard.ts`'s `isConsentIntentCompliant` then
  deterministically compares this self-report against `consentInteractionPolicy`, with no
  knowledge of the control's label, selector, or vendor whatsoever -- it only compares two
  already-classified enum values.

This check runs twice, mirroring the existing double layer already used for domain/redirect
safety (`checkNavigationAllowed`, used both by `validateClaudeDecision.ts` and independently by
`src/safety/index.ts`): first inside `validateClaudeDecision.ts`, Claude-specific and
pre-dispatch, where a contradicting decision is rejected as `consent_policy_violation` and given
one bounded corrective retry (the same `CORRECTIVE_RETRY_CATEGORIES` machinery
`src/reasoning/claudeReasoningProvider.ts` already uses for a malformed/invalid response, with an
addendum naming the actual policy instead of a generic schema complaint); second, independently of
which provider produced the decision, inside `src/safety/index.ts`'s `validateDecision`, which
flags the same `consent_policy_violation` and forces `stop_blocked` exactly like any other
guardrail trip if a non-compliant decision ever reaches it regardless. A decision that still
contradicts the policy after the one corrective retry stops the run safely with that flag rather
than ever silently dispatching the opposite of what was requested -- audit trail for all of this
(the resolved policy for the run, and each decision's `consentControlIntent`/
`consentPolicyCompliant`) is on `diagnostics.reasoningProvider`
(`REASONING_PROVIDER_DIAGNOSTICS_VERSION` "1.2.0").

### Bounded journey replanning

A `stop_blocked` action -- proposed directly by the reasoning layer, or substituted by the
safety layer (`src/safety`) for a decision it rejected (`domain_blocked`, `action_not_allowed`,
`repeated_action`, `loop_detected`) -- used to end the run immediately with `status: "blocked"`.
That is often too eager: the obstruction is frequently local to the *current* page (a dead-end
control, a rejected navigation target, a detected loop), and the existing `go_back` action
already gives the reasoning layer a way to retreat onto a page it has already seen and try a
different route, exactly as it would for any other action.

`src/core/loop.ts` now gives a run a small, fixed number of chances to do exactly that before
honouring `stop_blocked`: `MAX_JOURNEY_REPLANNING_ATTEMPTS` (currently 2, tracked per run via
`RunState.journeyReplanningAttempts`). When a `stop_blocked` action is about to be dispatched,
the engine substitutes the existing `go_back` action for it instead, provided:

- `go_back` is itself one of the task's `safety.allowedActions` (this is never a way around
  that restriction);
- there is a previous page to actually go back to (at least one prior step has already run);
- and one more `go_back` would not, by itself, already exceed `maxBacktracks` or `maxSteps`.

This is a conservative pre-check, never the sole enforcement of either ceiling: every
substituted `go_back` is recorded through the exact same `RunState.recordAction` path (and
therefore the exact same `backtrackCount`/`stepCount` accounting) as a `go_back` the reasoning
layer chooses on its own, so `checkLimitsBreach` -- evaluated independently at the top of the
next `runStep` call regardless -- remains the actual hard stop the moment either ceiling is
reached. Nothing about this mechanism inspects *why* the action was blocked, alters
`CLAUDE_MIN_CONFIDENCE` or any other confidence threshold, adds a new action to the vocabulary,
or touches either JSON schema: it is a bounded, generic substitution of one already-existing
action for another, entirely internal to the core loop.

If the substituted `go_back` itself fails to execute (e.g. no browser history entry was actually
available), the run falls through to the same `"blocked"` outcome the original `stop_blocked`
action would have produced, rather than the unrelated `action_execution_error` a failed action
normally reports. If it succeeds, the step is not terminal: the outer loop calls `runStep` again
with a fresh observation, exactly as after any other successful action, giving the reasoning
layer a genuine further attempt at the objective from the earlier page. Once
`MAX_JOURNEY_REPLANNING_ATTEMPTS` is exhausted, a further `stop_blocked` is honoured immediately,
exactly as before this mechanism existed.

Every attempt is visible directly on the relevant `StepLog` without any schema change, since
`safetyFlags` and `decision` are already free-form: `safetyFlags` gains
`"journey_replanning_attempted"`, and `decision` records which attempt this is (out of
`MAX_JOURNEY_REPLANNING_ATTEMPTS`), whether the original `stop_blocked` was proposed directly by
the reasoning layer or substituted by the safety layer, and the original decision's own
rationale. The safety-guard diagnostic error already recorded for a rejected decision
(`captures.errors`, category `safety_guard_stop`/`limit_stop`) reflects this too: `severity`/
`recoverable`/`stoppedRun` and the message text describe a bounded replanning attempt rather than
claiming the run stopped when it did not.

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
- **bounded, non-fatal recovery for a stale click target** — see "Blocker recovery" above; a
  fixed, generic ceiling independent of the general guardrails below it
- **screenshot + diagnostic capture on failure** — any `stop_failure`, unhandled error, or
  guardrail trip triggers a diagnostic screenshot/log capture regardless of which capture
  modules the task requested

`safety.consentInteractionPolicy` (see "Blocker recovery" above) is a different kind of control
from the hard guardrails above it: it is advisory, surfaced to the reasoning layer as plain
system-prompt instruction, the same way the engine already asks the model to prefer an
objective-matching control by meaning rather than a fixed wordlist. The engine has no generic,
non-vendor-specific way to deterministically verify a specific click honoured the policy (that
would require exactly the CTA-word/vendor dictionary this repo's core must not contain), so this
is not a hard guardrail like domain enforcement or the payment/personal-data locks above.

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
`screenshots`, `errors`, `offer_extraction`, `host_context_snapshot`), but the registry is
designed to accept new modules without touching the core loop. `host_context_snapshot` (see
"Blocker recovery" above) is the newest: a bounded, names-only cookie/storage footprint captured
only when a run's hostname changes, letting a caller empirically confirm whether state carried
across a cross-host transition. `page_metadata` and `finish_page_ctas` were added to the enum by
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

### Cross-client analytics-capture-evidence fix: provenance, popups, and GA4 request bodies

A production run against a real client's "Request a Quote"/"View Offer Details"-style CTA
showed three structural gaps in the mechanism above, none of them brand- or client-specific:

1. **Popup/new-context capture.** A click that opens a new browsing context
   (`target="_blank"`, or a `window.open()` call from a click handler) used to be closed
   immediately, before any capture code ever ran against it — whatever GA4 request or
   `dataLayer.push()` its own click handler fired *inside that context* was permanently lost.
   `src/capture-modules/popupCapture.ts`'s `adoptPopupForCapture` now instruments a popup as
   early as possible (attached the instant Playwright's own `"popup"` event fires — see
   `src/actions/click.ts`'s `onPopup` handler — not after the click's own dispatch/navigation
   handling has already run its course) for a short, bounded window
   (`POPUP_ADOPTION_WINDOW_MS`), then closes it. The engine still never adopts the popup as
   its own tracked page — navigation safety/`allowedDomains` and the existing generic
   `destinationUrl` fallback (`src/actions/click.ts`) are entirely unchanged; this is
   capture-only. `ActionResult`/`CtaClickCapture` gain `openedNewContext` (a popup was
   opened at all) and `observedNewContext` (it was actually instrumented before closing,
   vs. neither capture module being requested at all).
2. **Frame/context provenance and the click-vs-navigation race.** `data_layer_evidence` and
   `ga4_network_events` entries now carry a generic `source`
   (`"main_frame"`/`"child_frame"`/`"popup_context"`), `contextId`, and — for a child
   frame — `frameOrigin`. `captureDataLayer` (`src/capture-modules/dataLayer.ts`) is now
   frame-aware, reusing `src/observation/frames.ts`'s existing same-origin child-frame
   discovery rather than reading only the main document. Separately,
   `attachDataLayerPushCapture` attaches a real-time `dataLayer.push` observer (a
   `page.exposeBinding` + `page.addInitScript` pair, re-applied on every navigation) that
   captures a push the moment it happens, in Node, independent of the per-step full-array
   snapshot — this is what recovers a click handler's own `dataLayer.push()` when it fires
   immediately before a same-tab navigation that would otherwise tear down the JS context
   (and reset `window.dataLayer` to a fresh array) before any later snapshot could see it.
   **Consequence for consumers:** a page's dataLayer evidence can now be split across more
   than one `data_layer_evidence` entry sharing that page's own `url`/`stepIndex` (the
   per-step snapshot, plus any real-time push entries for the same pushes) — a caller must
   flatten every entry for a given `url`/`stepIndex`, never assume a single lookup is the
   complete picture (this is why correlation is keyed on `stepIndex`/`contextId`, not
   positional indexing).
3. **GA4 request completeness.** `attachGa4NetworkCapture` (`src/capture-modules/ga4NetworkEvents.ts`)
   now also reads `request.method()` and — for a POST/`sendBeacon` hit — the raw body
   (`postDataRaw`, bounded to `MAX_GA4_POST_BODY_BYTES` and flagged `truncated` rather than
   dropped past that), plus a generic, best-effort form-urlencoded parse of it
   (`postDataParams`; never attempted when the body doesn't unambiguously look like
   `key=value` pairs). `measurementId` and `consentState` are mechanically read from GA4's
   own fixed, protocol-level parameter names (`tid`; `gcs`/`dma`/`dma_cps`) across the union
   of query and body params — never inferred, never brand/client vocabulary.

None of this adds brand/vendor/CTA-label logic anywhere in `src/capture-modules` or
`src/actions`: `source`, `contextId`, `frameOrigin`, `truncated`, `method`, `postDataRaw`,
`postDataParams`, `measurementId`, `consentState`, `openedNewContext`, and
`observedNewContext` are all generic, mechanically-derived facts about *how* evidence was
captured, never an interpretation of what it means — mapping raw evidence to a specific
client's reporting columns remains n8n's job (`docs/n8n-integration.md` §6), unchanged.

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
    routeMemory.ts         # Route Memory (see §16): decision-point fingerprinting,
                            # candidate identity, and the per-run RouteMemory store
    successEvaluator.ts    # evaluates successCriteria against the live page
    semanticPageMatch.ts    # generic objective-vocabulary-overlap scoring for the
                            # semantic_page_match criterion type, used only by successEvaluator.ts
    initialNavigation.ts   # the engine's one-off first page.goto(), via robustNavigation.ts
    robustNavigation.ts    # shared domcontentloaded-first goto + timeout-recovery logic,
                            # used by initialNavigation.ts and by src/actions/navigate.ts
                            # and click.ts for in-loop action navigation
    boundedArray.ts         # generic keep-most-recent-N append-with-cap helper (see §13)
    memoryDiagnostics.ts    # bounded process.memoryUsage() sampling (see §13)

  /config                 # env-based configuration, read once and fail-fast at startup
    initialNavigationConfig.ts # INITIAL_NAVIGATION_TIMEOUT_MS
    actionNavigationConfig.ts  # ACTION_NAVIGATION_TIMEOUT_MS (navigate action / clicks that navigate)
    taskStoreConfig.ts         # TASK_RECORD_TTL_SECONDS / RUN_STALE_THRESHOLD_MS / HEARTBEAT_INTERVAL_MS
    concurrencyConfig.ts       # MAX_CONCURRENT_TASKS (see §13)
    captureLimits.ts           # bounded-growth ceilings for capture collections (see §13)

  /api                    # HTTP API boundary (n8n integration, see §9) and run lifecycle
    server.ts               # createApiServer(): routing, auth, concurrency check
    runner.ts                # executeTaskAsync(): browser/page lifecycle, heartbeat, cleanup
    auth.ts                   # bearer-token auth
    taskStore.ts               # TaskStore interface + RunRecord/RunStatus/StaleReason types
    inMemoryTaskStore.ts        # default, non-persistent TaskStore implementation
    redisTaskStore.ts            # opt-in, persistent TaskStore implementation (see §13)
    taskStoreFactory.ts           # TASK_STORE/REDIS_URL-based backend selection, fail-fast
    staleDetection.ts              # shared idle-past-threshold -> "stale" transition (see §13)
    workerIdentity.ts               # one WORKER_ID per process instance (see §13)
    concurrencyLimiter.ts            # MAX_CONCURRENT_TASKS in-process counter (see §13)
    validation.ts                     # request/response JSON Schema validation
    version.ts                         # API_VERSION
    main.ts                             # process entry point

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
    dataLayer.ts             # implemented (data_layer_evidence) -- frame-aware per-step
                              # snapshot (captureDataLayer) plus a real-time
                              # dataLayer.push observer (attachDataLayerPushCapture) that
                              # survives a same-tab navigation race, see §8 above
    dataLayerDelta.ts        # implemented -- generic before/after dataLayer delta used by
                              # the action-attributed analytics capture below, distinct from
                              # dataLayer.ts's own per-step full-snapshot capture
    ga4NetworkEvents.ts      # implemented -- GET query params, POST/sendBeacon body
                              # (bounded, generically parsed), measurementId/consentState
    popupCapture.ts           # implemented -- bounded popup/new-context adoption, see §8 above
    captureContext.ts         # shared contextId constants (MAIN_CONTEXT_ID, popupContextId)
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
    consentPolicyGuard.ts   # deterministic ConsentInteractionPolicy vs. self-reported
                            # ConsentControlIntent check (see "Deterministic consent-policy
                            # enforcement" above) -- reused by both validateClaudeDecision.ts
                            # and this package's own validateDecision()
    index.ts               # aggregates the guards into one validateDecision() call

  /types                   # TS types mirroring /schemas/*.json
    actions.ts
    captureModule.ts
    task-request.ts
    task-response.ts
    consentControl.ts       # ConsentControlIntent -- a reasoning/diagnostics-only vocabulary
                            # type, never part of the request wire shape, kept in its own file
                            # so src/types stays self-contained (no src/types file imports
                            # outside src/types)
    routeMemory.ts          # Route Memory (see §16) shared type shapes -- kept here (not in
                            # core/routeMemory.ts) so src/reasoning can depend on the type
                            # shapes without depending on src/core's implementation module

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

## 13. Memory stability and run persistence

A production incident (a Render instance running the API at its 512MB memory ceiling was
OOM-killed mid-run, wiping the in-memory task store; the next status poll for a still-valid
`runId` returned 404 instead of any useful terminal state) drove two related, but
independent, hardening changes. Neither introduces a Tier 3 worker/API process split —
both stay within the existing single-process API server.

### Confirmed memory-risk findings

Investigation of the browser/task lifecycle (`src/api/runner.ts`, `src/core/engine.ts`,
`src/api/taskStore.ts` as they were before this section's changes) found:

- One Chromium browser and one page per run, cleaned up in `finally` blocks — no
  browser/context/page leak. Playwright listener registrations (`ga4NetworkEvents.ts`,
  `errors.ts`) are all detached via the same `finally` in `engine.ts`.
- Screenshots are written to disk as PNG files; only the file path string is held in
  memory (`captures.screenshots`), never a base64 string or Buffer — but the *array* of
  those path strings, and separately `TaskResponse.steps` (each carrying a full
  `Observation`, including `interactiveElements`), were both confirmed unbounded across a
  run's lifetime (see "Evidence-retention limits" below).
- No duplication of the completed `TaskResponse` object itself was found: it is built once
  in `engine.ts`, held by a single reference as it passes through `runner.ts` into the
  `TaskStore` record, and the only other copy that ever exists is the transient JSON string
  produced once per HTTP response write (`JSON.stringify`) -- not a persistent second copy.
- The task store never evicted completed/failed records — every run's full
  `TaskResponse` stayed in the process's memory for its entire lifetime, accumulating
  across runs. This was the largest confirmed contributor.
- No concurrency limit existed: every accepted run launched its own full Chromium
  instance with no ceiling.
- `captureDataLayer` (`src/capture-modules/dataLayer.ts`) read the *entire* current
  `window.dataLayer` on every step (not a delta), so on a page whose dataLayer keeps
  growing, memory used by this one capture grew worse than linearly within a single run.
- `captures.ga4_network_events` and `captures.errors` accumulated for a run's entire
  lifetime via persistent listeners, with no cap.
- `chromium.launch()` was called with no memory-reducing flags.

### Bounded capture collections

`src/config/captureLimits.ts` defines generic, content-agnostic ceilings applied via
`src/core/boundedArray.ts`'s `appendBounded` (keep-most-recent-N, drop oldest):
`MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT` (200), `MAX_GA4_NETWORK_EVENTS` (500),
`MAX_ERROR_ENTRIES` (200). None of these know anything about a specific site, brand, or
capture semantics beyond "array, entry, cap". These three are fixed, not
env-configurable — they bound noisy, purely-diagnostic streams where only recency matters.

### Evidence-retention limits (screenshots, steps, interactive elements)

A keep-most-recent-only cap is the wrong shape for evidence that represents a *journey*:
`captures.screenshots`, `TaskResponse.steps`, and each stored step's
`observation.interactiveElements` were all confirmed unbounded, and naively dropping the
oldest would silently lose "where the run started" while keeping only its tail. Bounded
instead via `src/core/boundedArray.ts`'s `capPreservingEnds` / `appendBoundedPreservingEnds`
-- keep the first `keepFirst` entries permanently, then a keep-most-recent-N window over
the rest, so a run's beginning *and* its end both survive. `keepFirst` is always clamped to
at most half of the configured max, so a large `keepFirst` (or a small configured max) can
never fully suppress the tail -- the most recent entry always survives.

Unlike the fixed diagnostic caps above, how much journey evidence to retain is a
legitimate per-deployment tuning choice, so these three ceilings ARE env-configurable
(`src/config/captureLimits.ts`'s `readMaxScreenshotsPerRun` / `readMaxStoredSteps` /
`readMaxStoredInteractiveElementsPerObservation`, each fail-fast on an invalid value):

- `MAX_SCREENSHOTS_PER_RUN` (default 20, keeps the first 2) — applied in
  `src/actions/capture.ts`.
- `MAX_STORED_STEPS` (default 50, keeps the first 5) — applied incrementally in
  `src/core/engine.ts`'s main loop, so the array never grows past the limit at any point
  during a run, rather than growing unbounded and only being trimmed at the end.
- `MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION` (default 100, split evenly between
  earliest and latest) — applied per step, via `engine.ts`'s `boundStepLogForStorage`,
  **only to what gets stored** in the response. The live `Observation` object the
  reasoning/validation loop itself uses to decide and validate actions (e.g. confirming a
  clicked element was actually present) is never touched — confirmed by a regression test
  (`tests/integration/evidenceRetentionLimits.test.ts`) that runs a real journey against a
  fixture with 40+ interactive elements, a storage cap far below that count, and asserts
  the run still succeeds.

### Memory-safe Chromium launch flags

`src/api/runner.ts` launches Chromium with flags that reduce its own memory footprint
without touching rendering fidelity or multi-frame behaviour (`--disable-dev-shm-usage`,
`--disable-gpu`, `--disable-extensions`, `--disable-background-networking`,
`--disable-default-apps`, `--disable-sync`, `--metrics-recording-only`, `--mute-audio`,
`--no-first-run`). Deliberately excludes `--single-process`, which would destabilize the
multi-frame handling `observationBuilder.ts` and frame-aware observation depend on.

### Memory diagnostics

`src/core/memoryDiagnostics.ts` records a bounded (`MAX_MEMORY_SAMPLES = 50`,
keep-most-recent) series of `process.memoryUsage()` samples at run start, after each
step, and after browser/context cleanup, surfaced as `TaskResponse.diagnostics.memory`
(response schema `1.7.0`). Purely diagnostic, generic Node runtime evidence — never
anything about the page/task being run — so an out-of-memory incident can be correlated
with a run's own memory trend after the fact.

**Diagnostic logging is never treated as an OOM fix.** An OOM SIGKILL from the OS/container
is uncatchable by any JS exception handler; this repo deliberately does not add a
`process.on("uncaughtException")`/`process.on("unhandledRejection")` handler and frame it
as solving memory exhaustion. `src/api/main.ts`'s existing `SIGINT`/`SIGTERM` graceful
shutdown is unrelated (a clean shutdown signal, not a crash).

### Run-record persistence (`TaskStore`)

`src/api/taskStore.ts` defines a backend-agnostic `TaskStore` interface
(`createRun`/`getRun`/`completeRun`/`failRun`/`heartbeat`, all `Promise`-returning) with
two implementations:

- `src/api/inMemoryTaskStore.ts` — the default (`TASK_STORE` unset or `memory`). Same
  behaviour as before this change (nothing survives a process restart), used for local
  development and the test suite.
- `src/api/redisTaskStore.ts` — opt-in (`TASK_STORE=redis`, requires `REDIS_URL`). One
  Redis key per run (`nav-engine:run:<runId>`), the whole `RunRecord` as its JSON value,
  written via `SET key value EX <ttlSeconds>` with the TTL refreshed on every write. A run
  record now survives an API process restart because it lives in Redis, not in the killed
  process's own memory — directly addressing the incident above.

`src/api/taskStoreFactory.ts` selects the backend from `TASK_STORE`/`REDIS_URL` and,
matching this repo's existing fail-fast-at-startup convention (`src/api/auth.ts`,
`src/config/initialNavigationConfig.ts`), aborts server creation clearly if `TASK_STORE=redis`
is configured but Redis is unreachable, rather than serving requests that would each fail
individually once they tried to persist.

**Test coverage against a real Redis server, not only a mock.** `tests/unit/
redisTaskStore.test.ts` and `tests/unit/taskStoreFactory.test.ts` use `ioredis-mock` (an
in-process substitute) for fast, dependency-free coverage of the store's own logic.
`tests/integration/redisRealServer.test.ts` additionally runs the same create/get/complete
round-trip, plus a cross-connection persistence check (a fresh `TaskStore`/client pair
reading a record an earlier one wrote — the real-server equivalent of "survives an API
process restart"), against an **actual Redis server**, exercising the real wire protocol
end to end. CI provides this via a GitHub Actions service container (`.github/workflows/
ci.yml`'s `redis` service, `redis:7-alpine`, exposed at `localhost:6379`), so every PR
run covers the real path. Locally, `npm test` runs this file too, but it skips gracefully
(not a failure) if it can't reach a Redis server within 1.5s — running a local Redis
first (e.g. `redis-server` or `docker run -p 6379:6379 redis:7-alpine`) makes it exercise
the real path locally as well; `REDIS_URL_FOR_TESTS` overrides the default
`redis://127.0.0.1:6379` if needed.

### Heartbeat and stale detection

While a run is active, `executeTaskAsync` (`src/api/runner.ts`) refreshes its run record
every `HEARTBEAT_INTERVAL_MS` (default 15000ms). Each record also carries a `workerId` —
one random-token-plus-PID identity per process instance (`src/api/workerIdentity.ts`),
guaranteed to differ after a restart even if the OS reuses the PID.

`src/api/staleDetection.ts`'s `applyStaleDetection`, run lazily whenever a `"running"`
record is read, checks whether it has gone idle past `RUN_STALE_THRESHOLD_MS` (default
90000ms). If so, the record's status becomes `"stale"` with a `staleReason`:

- `"worker_lost"` — the record's `workerId` differs from the reading process's own: the
  run's owning process is gone (e.g. the OOM-restart scenario this section exists to fix).
- `"run_stale"` — the same process still owns the record but stopped heartbeating anyway
  (e.g. a hung run).

`GET /v1/tasks/:runId` returns this as a clear terminal-ish status
(`{status: "stale", staleReason}`) instead of an indefinite `"running"` answer or a
confusing 404. This wrapper status is outside the schema-governed `result` field (see §9),
so it required no `schemaVersion`/`outputSchemaVersion` bump; a caller (e.g. n8n) that
wants to recognize `"stale"` explicitly is a separate, later integration change.

### Concurrency limit

`src/api/concurrencyLimiter.ts` is a simple in-process counter (`tryAcquire`/`release`),
checked synchronously (no `await` between the capacity check and the increment) in
`handleCreateTask` before a run is accepted. `MAX_CONCURRENT_TASKS` defaults
conservatively to 1, since each accepted run launches its own full Chromium instance — a
meaningful fraction of a small (e.g. 512MB) instance's memory budget. Once at capacity,
`POST /v1/tasks` returns `503 {error: "concurrency_limit_reached"}` — rejection, not
queueing (a queue is Tier-3-adjacent infrastructure, deliberately out of scope here).

## 14. Low-memory browser mode

A second production incident occurred even with every §13 mitigation deployed
(screenshots removed from the calling n8n workflow's own `captureModules` selection,
`MAX_CONCURRENT_TASKS=1`, bounded stored captures/steps/observations, and the memory-safe
Chromium launch flags): a run still exceeded a 512MB Render instance's memory ceiling, was
OOM-killed, and correctly surfaced as `{status: "stale", staleReason: "worker_lost"}` per
§13's own heartbeat/stale-detection design. Every §13 mitigation targets memory held by
the **Node.js orchestration process** (stored captures, run records, diagnostics samples);
none of them touch memory used by the **Chromium browser process itself**, which every
run launches one of. This section addresses that remaining, larger contributor without
requiring a Render plan upgrade or the Tier 3 worker/API process split.

### Investigation findings

- **Resource types loaded, before this change**: all of them, unfiltered — `runner.ts` had
  no `page.route()` or resource-blocking context option prior to this change, confirmed by
  inspection.
- **Can Playwright request routing safely block image/media/font?** Yes.
  `page.route("**/*", handler)` intercepts every request before it resolves;
  `request.resourceType()` classifies it as one of Playwright's fixed vocabulary
  (`document, stylesheet, image, media, font, script, texttrack, xhr, fetch, eventsource,
  websocket, manifest, other`), so a handler can single out `image`/`media`/`font` without
  any URL-pattern or brand-specific matching.
- **Does document/script/stylesheet/xhr/fetch/beacon-GA4 traffic remain available?** Yes —
  only `image`/`media`/`font` are touched; every other resource type is passed through via
  `route.continue()` unmodified.
- **Could blocking image/media/font prevent a configurator from rendering controls or
  firing analytics?** Low residual risk: DOM structure, CSS layout, and JavaScript
  execution (including `fetch`/`xhr` calls and `dataLayer` pushes) are unaffected by
  blocked image/media/font bytes. The one edge case is a control whose own visibility is
  conditioned on that specific image's `load` event firing (rare in practice, and not
  present in this repo's own capture-module assumptions). Confirmed empirically (not just
  argued) in `tests/integration/lowMemoryBrowserMode.test.ts`: a fixture's trim-selection
  buttons remain visible interactive elements, and its own `dataLayer` push, `fetch` call,
  and GA4 `<img>`-beacon parameters are all still captured, with every image/font/media
  request blocked before reaching the origin server.
- **GA4/analytics capture safety, specifically**: `src/capture-modules/ga4NetworkEvents.ts`
  listens on `page.on("request", ...)`, which Playwright fires the moment a request is
  *issued* — independent of how routing later resolves it (`continue`/`abort`/`fulfill`).
  A GA4 beacon fired via `new Image().src = ...` (resourceType `"image"`) is therefore
  still observed and parsed for its query parameters even though its actual network
  delivery is blocked. This is the property that makes blocking `image` safe for the
  analytics use case without a beacon-URL exception.
- **Service workers, cache, video, WebGL, preloaded resources**: service worker
  registration is disabled for the run's page (`newPage({serviceWorkers: "block"})`) since
  a single-shot run torn down immediately after gets no benefit from it. Browser cache is
  already a non-issue — each run gets a fresh, non-persistent context. Preloaded resources
  are covered automatically (a preloaded font still surfaces with resourceType `"font"`).
  WebGL/3D-viewer rendering and video decoding are plausible additional contributors for a
  3D configurator viewer specifically, but are **not addressed by this change** — blocking
  them is more invasive and not required by the stated use case; noted here as a candidate
  for a future, separately-justified change if a 3D-viewer-heavy run still exceeds budget.
- **Can browser-process memory be measured separately from Node's own memory?** No, not
  via the API this engine uses: `chromium.launch()` returns a `Browser` object with no
  `.process()` accessor (confirmed against Playwright's own type definitions — only
  `BrowserServer`, returned by the unused `chromium.launchServer()`, and
  `ElectronApplication` expose one). `src/core/memoryDiagnostics.ts`'s
  `process.memoryUsage()` samples have therefore only ever measured the Node.js
  orchestration process, never the separate Chromium OS process that is the likely
  dominant contributor to an OOM. Not fixed in this change (would require
  `chromium.launchServer()` or `/proc` parsing, judged out of scope for the smallest
  generic fix); recorded here as a known gap.
- **Unnecessary Chromium subprocesses launched by the engine?** No — one `chromium.launch()`
  call per run. Chromium's own internal multi-process architecture (GPU/renderer/zygote
  processes) is standard and already partially reduced by §13's `--disable-gpu` flag.
- **One context/page per run, always closed?** Yes, confirmed unchanged from §13's own
  finding: `browser.newPage()` once per run, closed in the existing `finally` chain in
  `runner.ts`.

### Design: opt-in resource-type blocking

`LOW_MEMORY_BROWSER_MODE=true` (read by `src/config/lowMemoryBrowserConfig.ts`'s
`readLowMemoryBrowserMode`; only the literal string `"true"`, case-insensitive, enables it
— any other value, including unset, leaves it off) makes `src/api/runner.ts`:

- Open the run's page with `serviceWorkers: "block"`.
- Attach `src/api/browserResourceRouting.ts`'s `attachLowMemoryResourceRouting(page)`,
  which routes `**/*` and, for `image`/`media`/`font` requests only, calls
  `route.fulfill({status: 200, ...})` with a minimal stand-in body (a 1x1 transparent GIF
  for `image`, an empty body for `media`/`font`) instead of `route.abort()`. Every other
  resource type is passed through via `route.continue()` unmodified. `fulfill` (not
  `abort`) is deliberate: `src/capture-modules/errors.ts` records `requestfailed` events
  and `>=400` responses as capture-visible errors, and an intentionally-blocked resource
  should never crowd out a genuine error within the bounded `MAX_ERROR_ENTRIES` cap that
  §13 already established — `fulfill` with `status: 200` triggers neither listener.
- Record, per resource type, `allowedCount`/`blockedCount`, `allowedBytesMeasured` (summed
  from real `Content-Length` response headers, 0 when absent — never fabricated), and
  `blockedBytesEstimated` (`blockedCount × a fixed per-type average` — 150,000 bytes for
  image, 2,000,000 for media, 50,000 for font — explicitly an estimate, since a blocked
  resource is never actually fetched and so has no real size to measure). Surfaced as
  `TaskResponse.diagnostics.resourceRouting` (response schema `1.8.0`), following the same
  bounded-fixed-shape-aggregate pattern as `diagnostics.memory`/`diagnostics.reasoningProvider`
  — a small array keyed by Playwright's own fixed resource-type vocabulary, never an
  unbounded per-request list.
- Detach routing (and the response listener) before the page closes, matching the existing
  `finally`-chain cleanup order in `runner.ts`.

When the mode is off (the default), `runner.ts`'s behavior — and `TaskResponse` shape — is
byte-for-byte unchanged: no routing is attached, and `diagnostics.resourceRouting` is
simply absent from the response, matching the existing precedent for other opt-in
diagnostics fields.

Deliberately out of scope for this change, per the incident report's own instruction: any
Tier 3 worker/API process separation, and direct Chromium-process memory measurement.

### Tests

- `tests/unit/lowMemoryBrowserConfig.test.ts` — the env-var reader defaults off, is on only
  for the literal `"true"` (case-insensitively), and stays off for near-misses (`"1"`,
  `"yes"`, `"on"`, `""`).
- `tests/unit/browserResourceRouting.test.ts` — using fake `Page`/`Route`/`Response`
  objects (no real browser): `image`/`media`/`font` are always fulfilled with `status:
  200`, never `continue()`d; `document`/`script`/`stylesheet`/`xhr`/`fetch`/`other` are
  always `continue()`d, never fulfilled; `diagnostics()` correctly separates measured
  allowed bytes (from a real `content-length` header, 0 when absent) from estimated
  blocked bytes (always non-zero, from the fixed per-type constants); `detach()` removes
  the response listener and unroutes the page.
- `tests/integration/lowMemoryBrowserMode.test.ts` — a real Chromium instance against a
  local HTTP fixture (a generic stand-in for an OEM configurator page: an image, a
  preloaded font, a video element, a `fetch` call, and a `dataLayer` push plus a GA4
  `<img>`-beacon, deliberately not naming or shaped after any specific brand, per
  CLAUDE.md's non-negotiable design rule) proves, end to end: without the mode, image/font
  requests reach the origin server normally; with the mode enabled, the run still succeeds,
  the fixture's interactive trim-selection and continue controls are still exposed in the
  observation, image/font/media requests never reach the origin server (hit count `0`), the
  `fetch` call still reaches it normally, the GA4 beacon's parameters are still captured in
  `captures.ga4_network_events` despite its own network delivery being blocked,
  `page_visits`/`cta_clicks`/`journey_path`/`data_layer_evidence` are all still populated,
  no `network_request_failed` errors are introduced, and `diagnostics.resourceRouting`
  reports the expected blocked/allowed counts and byte figures.

### Expected memory reduction (estimate, not measured on Render)

Not measured against the actual Render deployment that experienced the OOM, so this is
an estimate based on the resource types removed from Chromium's own decode/render/GPU
pipeline, not a guaranteed figure: image decoding, video buffering, and font-file loading
are memory-**and-CPU**-non-trivial for a headless Chromium process, particularly for a
configurator page carrying multiple high-resolution product images and/or video. This
change should meaningfully reduce Chromium's own RSS for such a page; it cannot be
quantified precisely here because (per the investigation findings above) this engine has
no way to measure the Chromium process's own memory separately from Node's.
`diagnostics.resourceRouting`'s blocked-count/estimated-bytes figures are surfaced
specifically so an operator can correlate a real run's blocking activity with Render's own
instance-level memory graph after deployment.

### Deployment and rollback

Deploy with `LOW_MEMORY_BROWSER_MODE` **unset** first — zero behavior change, safe to
verify the deploy itself succeeded before opting in. Then set
`LOW_MEMORY_BROWSER_MODE=true` as a Render environment variable to enable the mode; no
code change, redeploy, n8n change, or Redis/persistence change is required to toggle it
either way. Roll back by unsetting the variable (or setting it to any value other than
`"true"`) and redeploying — matching the same unset-to-disable rollback pattern already
established for `TASK_STORE` in §13.

## 15. Container memory circuit breaker

Even with §14's WebGL disabling deployed, a run can still exceed a container's memory
ceiling: neither §13 nor §14 can measure or bound the Chromium *process's* own memory
directly (Playwright exposes no such API — see §14's own investigation findings), so any
mitigation targeting a *specific* resource type or rendering capability is inherently a
best guess at what a given page happens to be heavy on. This section adds a last-resort,
generic backstop: rather than trying to reduce memory further, it detects the *container's*
total memory approaching its own ceiling and stops the run safely, before the OS's own OOM
killer does.

### Feasibility: confirmed via a prerequisite, separate, no-op diagnostic first

Before implementing this breaker, a read-only startup diagnostic (`src/config/
cgroupMemoryDiagnostic.ts`, logged once by `src/api/main.ts`) confirmed whether the
deployed container actually exposes readable Linux cgroup memory accounting — the exact
mechanism a Render (or any containerized) instance's own memory ceiling is enforced
through. Confirmed on Render:

```
[startup] cgroup memory diagnostic: available (v2) -- current=/sys/fs/cgroup/memory.current
(120397824 bytes), limit=/sys/fs/cgroup/memory.max (536870912 bytes)
```

This breaker (`src/safety/containerMemoryGuard.ts`) reuses that exact same read (cgroup v2
`memory.current`/`memory.max`, falling back to cgroup v1
`memory.usage_in_bytes`/`memory.limit_in_bytes`) rather than duplicating the logic.

### Design

Opt-in via `MEMORY_CIRCUIT_BREAKER_ENABLED=true` (`src/config/
containerMemoryCircuitBreakerConfig.ts`). Off by default — zero behavior change unless
explicitly enabled.

- **Sampling** happens in `src/api/runner.ts`, on its own independent timer
  (`MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS`, default 3000ms) — decoupled from the
  loop's own step cadence, since a step can take much longer or shorter than the sampling
  interval. An immediate sample is also taken at run start, so even a very fast run gets
  at least one reading.
- **Breach detection** (`readContainerMemory`, `src/safety/containerMemoryGuard.ts`):
  current usage ≥ `MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION` (default 0.75) ×
  the container's limit (cgroup-reported `memory.max`/`memory.limit_in_bytes`, or
  `MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES` if set as an override). Pure and synchronous —
  never throws.
- **Enforcement** is checked once per step, at the exact same checkpoint
  `checkLimitsBreach` (maxSteps/maxBacktracks/maxDuration) already uses in
  `src/core/loop.ts` — a cooperative check (`isMemoryThresholdBreached`), not a preemptive
  interrupt of an in-flight action. This means detection is prompt (every sample interval)
  but enforcement can be delayed by however long the current step's own action takes to
  resolve — see "Known limitations" below.
- **Stopping safely**: reusing the *exact same* mechanism as `max_steps_reached`/
  `max_backtracks_reached`/`max_duration_reached` — a forced `stop_failure` action,
  producing a normal (bounded) `StepLog`, a `captures.errors` entry (category
  `limit_stop`), and a new terminal status, `container_memory_threshold_reached`
  (`TaskResponse.status`), with `statusReason`/`diagnostics.finishReason` set to the
  distinct string `"container_memory_threshold"`. Because this is the same path every
  other hard limit already uses, page/browser closing and evidence preservation are
  inherited for free from the existing `runner.ts` cleanup chain and the loop's own
  bounded `steps[]`/`captures` accumulation — no new closing or evidence-preservation
  logic was needed.
- **Redis persistence**: the run's `TaskStore` record (`src/api/taskStore.ts`) gains an
  optional `latestContainerMemorySample` field, refreshed via an extended
  `TaskStore.heartbeat(runId, containerMemorySample?)` on every sample tick — a single
  latest snapshot, not a growing history. The completed `TaskResponse` itself also carries
  the same latest sample as `diagnostics.containerMemory` (response schema `1.9.0`),
  attached in `runner.ts` after `runTask()` returns, following the exact precedent
  `diagnostics.resourceRouting` (§14) already established for post-hoc diagnostics
  attachment.
- **Safe failure modes** (explicit requirements, all satisfied):
  - No readable cgroup files → `available: false`, `breached` always `false` — the
    breaker is inert, never affects the task.
  - A sampling exception (e.g. a file disappearing mid-run) is caught per-tick; only that
    tick's effect is lost, never the run or the service.
  - A `TaskStore.heartbeat` write failure during sampling is fire-and-forget
    (`.catch(() => {})`), matching the existing heartbeat's own discipline — a Redis
    hiccup never blocks or crashes a run.

### Files changed

`src/config/containerMemoryCircuitBreakerConfig.ts` (new), `src/safety/
containerMemoryGuard.ts` (new), `src/api/runner.ts`, `src/api/taskStore.ts`,
`src/api/inMemoryTaskStore.ts`, `src/api/redisTaskStore.ts`, `src/core/loop.ts`,
`src/core/engine.ts`, `src/types/task-request.ts`, `src/types/task-response.ts`,
`schemas/task-request.schema.json`, `schemas/task-response.schema.json`.

### Tests

- `tests/unit/containerMemoryCircuitBreakerConfig.test.ts` — env-var defaults, bounds,
  and fail-fast validation.
- `tests/unit/containerMemoryGuard.test.ts` — pure breach-detection logic against
  injected readings: unavailable never breaches, threshold math, override precedence,
  a missing/non-positive limit never breaches.
- `tests/integration/containerMemoryCircuitBreaker.test.ts` — the loop-level mechanism
  directly (`runTask({..., isMemoryThresholdBreached})`) against a real fixture: a
  breach stops the run on the very next step with the new status/statusReason, preserves
  `journey_path`/`errors` evidence already captured, and an always-false signal never
  affects a run (no false positives).
- `tests/integration/containerMemoryCircuitBreakerRunner.test.ts` — the full
  `runner.ts` wiring against **real** cgroup files (a deliberately tiny
  `MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES` override guarantees an immediate, deterministic
  breach against this process's actual current usage — no fake filesystem needed):
  `diagnostics.containerMemory` is attached to the completed result, and the sample is
  persisted to the `TaskStore` record via `heartbeat`. Skips gracefully (not a failure) if
  the running environment doesn't expose readable cgroup memory files at all, matching
  `tests/integration/redisRealServer.test.ts`'s convention for an unavailable real
  dependency. A second test confirms `diagnostics.containerMemory` stays entirely absent
  when the breaker is disabled (the default).

### Schema impact

Additive only. Response `schemaVersion` `1.8.0` → `1.9.0`: `status` gained the enum value
`"container_memory_threshold_reached"`, and `diagnostics.containerMemory` (new
`$defs/containerMemoryDiagnostics`) was added, present only when the breaker was enabled
for that run. Cascaded per this repo's convention: request `outputSchemaVersion` `1.8.0` →
`1.9.0`, request `schemaVersion` `1.9.0` → `1.10.0`. No existing field was removed,
renamed, or had its meaning changed; when the breaker is disabled (the default), a
`TaskResponse` is byte-for-byte unchanged.

### Known limitations

- **Enforcement granularity**: sampling is prompt (every `MEMORY_CIRCUIT_BREAKER_SAMPLE_
  INTERVAL_MS`), but the actual stop only happens at the next per-step checkpoint — a
  single step whose own action takes long enough (e.g. a slow navigation) can still let
  memory climb past the threshold, or in the worst case past the container's real ceiling,
  before the loop gets a chance to react. This reduces, but does not eliminate, the risk of
  an uncontrolled OOM kill.
- **No attribution**: a total-container-memory reading cannot say *what* is consuming
  memory (Chromium vs. Node, or which subsystem within Chromium) — it is a prevention
  mechanism, not a diagnostic one. See §14's own investigation findings on why Chromium's
  process memory has never been directly measurable via Playwright.
- **Deployment-environment assumption**: relies on the container actually exposing
  readable cgroup files at the expected paths — confirmed on Render (see the diagnostic
  log above), but not guaranteed on every possible deployment target. Fails safe (inert,
  never breaches) rather than failing loudly when absent.
- **Not implemented, per explicit scope**: no additional browser-level memory
  optimizations, no Tier 3 worker/API process separation, no n8n changes.

### Deployment and rollback

Deploy with `MEMORY_CIRCUIT_BREAKER_ENABLED` **unset** first — zero behavior change.
Enable via `MEMORY_CIRCUIT_BREAKER_ENABLED=true` as a Render environment variable; tune
`MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION` / `MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS`
/ `MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES` only if the defaults (0.75, 3000ms, cgroup-reported
limit) don't fit a specific deployment. No code change, redeploy of other services, n8n
change, or Redis-persistence-shape change is required to toggle it either way. Roll back
by unsetting `MEMORY_CIRCUIT_BREAKER_ENABLED` (or setting it to anything other than
`"true"`) and redeploying — the same unset-to-disable pattern already established for
`TASK_STORE` (§13) and `LOW_MEMORY_BROWSER_MODE` (§14).

## 16. Route Memory (Phase 1)

A real journey frequently revisits the same page more than once within a single run —
after a `go_back`, or after a dead-end `navigate`/`click` that leads somewhere unhelpful and
the reasoning layer retreats. Before this change, nothing in the engine recognised "I have
been at this exact decision point before, and I already tried this" once even one other step
intervened: `RecordedAction.observedProgress` (§6's `recentActions`) is a plain, linear,
adjacent-history signal — it tells the reasoning layer "the last action you took didn't
change anything," but says nothing once a run has moved on to a different page and later
returns. A reasoning provider could therefore re-select an already-failed or already-inert
candidate at a revisited page, burning a step (and, for a real Claude-backed run, a model
call) rediscovering something the run already knew.

Route Memory (`src/core/routeMemory.ts`, shared type shapes in `src/types/routeMemory.ts`)
is a small, generic, engine-internal memory that closes this gap for Phase 1: it remembers,
per **decision point**, which candidate route choices have already been tried and what
happened, and surfaces that as extra context to the reasoning layer's own prompt. It is
**observe-and-inform only** — it never blocks, vetoes, or overrides a decision itself; that
remains a candidate for a later phase, once this phase's evidence-gathering value has been
validated against real runs.

### Decision-point fingerprint

`computeDecisionPointFingerprint(observation)` identifies "where" a decision is being made
by the page's own content, not merely its URL: the page `url` plus the deduplicated, sorted
set of every visible interactive element's `role`+`accessibleName`. Two independently-taken
observations of the genuinely same decision point — e.g. before and after a `go_back` that
triggers a fresh page load — fingerprint identically even though every element's own
ephemeral `data-nav-engine-id` (§5) has been reassigned by that fresh scan, because the
fingerprint never reads the id. Sorting and deduplicating also makes the fingerprint
insensitive to DOM reordering and to repeated identical controls. This is deliberately
narrower than a full-page fingerprint (e.g. hashing all of `notableText` or every attribute)
— the goal is only "would the same set of candidate actions be available here again," not
"is the page byte-for-byte identical."

### Candidate identity

`computeCandidateIdentity(action, observation)` resolves a stable identity for a candidate
**route choice** — deliberately narrower than the full action vocabulary, since Route Memory
is only about which path through the site was chosen, not every action:

- `click` — identified by the target element's own `role`+`accessibleName` (resolved against
  the observation the decision was made from), never its `id` — the same reasoning as the
  fingerprint above: an id is only stable for the lifetime of one page instance, not across a
  fresh load of the same page.
- `navigate` — identified by the target URL itself (`SelectedAction.target`, the same field
  `validateClaudeDecision.ts` already populates from Claude's `navigateUrl`).
- Every other action (`scroll`, `wait`, `go_back`, `capture`, `stop_success`, `stop_blocked`,
  `stop_failure`) returns no identity at all — nothing to choose *between* at a decision
  point for these; Route Memory only ever tracks alternatives being weighed against each
  other, not the full action vocabulary.

A `click` whose target can no longer be resolved against the given observation (e.g. a
disallowed/malformed decision) also yields no identity — there is nothing stable to identify
it by, and it is not a real candidate the reasoning layer could have meaningfully chosen.

### Candidate outcome tracking

`RouteMemory` (the per-run store, held on `RunState.routeMemory`) keys records by
`(decisionPointFingerprint, candidateId)` and tracks `attempts` (an incrementing count) and
`lastOutcome`, one of:

- **`blocked`** — the safety layer rejected the candidate before it was ever dispatched.
  Recorded immediately in `src/core/loop.ts`, from `decision.action` (the reasoning layer's
  original proposal) whenever `safetyResult.allowed` is false — independent of whatever the
  engine substitutes in its place (a forced `stop_blocked`, or a further-substituted
  `go_back` via bounded journey replanning, §5's "Bounded journey replanning"), since that
  substituted action was never the candidate actually chosen.
- **`failed`** — the candidate was dispatched but did not execute successfully
  (`ActionResult.success: false`), covering a genuine failure and a still-unresolved
  `staleTarget` recovery attempt alike; the *next* real attempt (if any) can still upgrade
  `lastOutcome` away from `failed` later.
- **`advanced`** / **`no_change`** — a successful dispatch is recorded provisionally as
  `no_change` (the conservative default: no observable progress) at the moment it is
  recorded, then upgraded to `advanced` by `RunState.resolveLastActionProgress` — the exact
  same generic, deferred url/title-diff mechanism `RecordedAction.observedProgress` already
  uses — the moment the *next* observation confirms the page actually moved on. This mirrors
  `observedProgress` deliberately: no second Playwright read, no action-type-specific logic,
  and identical semantics for what counts as "progress."

Every outcome is generic and mechanical — nothing here inspects control text, purpose, or
brand, and nothing here is specific to any capture module or success-criteria type.

### Prompt context: tried candidates at the current decision point

Before asking the reasoning layer for a decision, `src/core/loop.ts`'s `obtainDecision`
computes the current observation's decision-point fingerprint and looks up
`RunState.routeMemory.getTriedCandidates(fingerprint)`. When non-empty, this is passed as the
new, optional `ReasoningContext.routeMemory` field (`src/reasoning/reasoningProvider.ts`) —
omitted entirely (never an empty array) when nothing has been tried at this decision point
yet, matching this repo's existing convention for optional context fields (e.g.
`Observation.progressIndicatorText`).

`src/reasoning/promptBuilder.ts` renders it into the prompt payload as `routeMemory`: each
entry's `type`/`label`/`attempts`/`lastOutcome`, capped at `MAX_ROUTE_MEMORY_CANDIDATES` (10)
— `getTriedCandidates` already sorts most-attempted-first, so a truncation always keeps
whichever dead ends have been repeated the most (the strongest "don't choose this again"
signal) ahead of a once-tried candidate. A short, generic system-prompt clause explains the
field and its four outcome values in plain language, and instructs the model to prefer a
control not listed in `routeMemory` at all, or one whose `lastOutcome` is `advanced`, over
repeating one whose `lastOutcome` is `no_change`, `failed`, or `blocked` — advisory, exactly
like the `observedProgress` guidance already in this same prompt, not an enforced rule.

### Why `src/types/routeMemory.ts`, not only `src/core/routeMemory.ts`

The shared type shapes (`RouteMemoryOutcome`, `RouteMemoryCandidate`,
`RouteMemoryCandidateSummary`) live in `src/types/routeMemory.ts`, alongside
`actions.ts`/`captureModule.ts`, rather than only in `src/core/routeMemory.ts`. `src/core`
already depends on `src/reasoning`'s types (`loop.ts` imports `Decision`/`ReasoningProvider`);
if `src/reasoning/reasoningProvider.ts` imported `RouteMemoryCandidateSummary` directly from
`src/core/routeMemory.ts`, the two directories would depend on each other's implementation
modules in both directions. Keeping the shared shapes in `src/types` (the layer both already
depend on for cross-cutting types) avoids that, matching the precedent `types/actions.ts`
already sets for `RecordedAction`/`SelectedAction`.

### Scope and what Phase 1 deliberately does not do

Per this phase's own scope (see `docs/v1-scope.md`):

- **No wire-schema change.** `ReasoningContext` is an internal type at the pluggable
  `ReasoningProvider` boundary (§6), never part of `schemas/task-request.schema.json` or
  `schemas/task-response.schema.json` — adding a field to it is not a contract change, needs
  no `schemaVersion`/`outputSchemaVersion` bump, and every existing example/task/response
  stays byte-for-byte valid and unchanged.
- **No brand/automotive-specific logic.** Every identifier Route Memory uses
  (`role`, `accessibleName`, `url`) is already generic observation data; nothing here reads
  CTA wording, a vendor/CMP attribute, or any site-specific selector.
- **Not enforced, not surfaced on `TaskResponse`.** Route Memory never overrides a decision,
  never appears in `captures.*` or `engineAssessment`, and never appears in the response at
  all — it is purely an addition to the reasoning layer's own prompt context. A later phase
  could add response-level diagnostics (mirroring `diagnostics.reasoningProvider`) or an
  enforcement mechanism (e.g. refusing to re-propose an exhausted candidate, the way the
  existing repeated-action guard already refuses an exact linear repeat) once this
  observe-and-inform phase has been validated against real runs — deliberately deferred
  rather than spun up speculatively ahead of that evidence.
- **Never persisted, never shared across runs.** `RouteMemory` is a plain in-memory map
  scoped to one `RunState`, discarded with the rest of the run's state once `runTask`
  returns — matching every other per-run mechanism in this file (e.g. `lastBlockerSignature`,
  `journeyReplanningAttempts`).

## 17. Goal-Directed Bounded Branch Exploration

A real journey frequently reaches a decision point where the objective is not yet directly
represented by any visible control's label — a page offering "View Details" and "Finance
Calculator" when the objective is to reach a quote form, neither of which shares any vocabulary
with "quote". Before this section's mechanism existed, the reasoning layer had exactly one shot
at such a candidate: pick it, and if it turned out to be a dead end, either PR #41's bounded
journey replanning (§"Bounded journey replanning") or an eventual `stop_blocked` was the only
recourse — there was no way for the engine to let the reasoning layer follow a plausible-but-
unlabelled candidate a few steps deep, judge it on accumulated evidence, and cleanly try the next
one without burning the run's entire replanning allowance on a single shallow probe.

This is a **current-run, local, bounded, goal-directed** capability — never cross-run learning,
never a persisted experience repository, never RAG or a vector store, and never brute-force
"click every visible control." It builds directly on, and does not replace, PR #40 (Action
Progress Awareness), PR #41 (Bounded Journey Replanning), and PR #42 (Route Memory Phase 1): the
same `observedProgress` evidence, the same `go_back` execution/accounting, and the same
decision-point fingerprint/candidate-identity mechanism are all reused, never duplicated.

### Objective milestone rollup

`computeMilestoneRollup` (`src/core/successEvaluator.ts`) reuses existing `successCriteria` —
never a second, parallel milestone system — as the objective's milestones. Every criterion
**group** (§9e's alternative-criteria grouping; an ungrouped criterion is its own singleton
group) is one milestone, in **array declaration order**; `activeSubGoal` is the first group, in
that order, not yet present in `satisfiedCriteriaIds`. See `docs/n8n-integration.md` §9f for the
full caller-facing guide to structuring `successCriteria` for this.

Because `RunState.satisfiedCriteriaIds` is (and always was, independent of this section) a
one-way ratchet — nothing anywhere in the engine ever removes an id from it — an already-completed
milestone **cannot** be un-satisfied by a later branch's failure. This is the direct fix for the
regression shape that motivated this work: selecting a required entity is expressed as one
milestone criterion; a downstream branch explored from the entity's own page is tracked in a
completely separate structure (Route Memory / `BranchRecord`, below), keyed by decision-point
fingerprint and candidate identity, never by `SuccessCriterion.id` — there is no code path from a
branch's `dead_end`/`blocked`/`unsafe` result back into `satisfiedCriteriaIds`. What is **not**
implemented: a live, page-state sense of "are we still positioned inside the entity's own
section right now," as distinct from "was the milestone historically satisfied" — deferred as a
speculative, potentially fragile heuristic (e.g. a URL-prefix comparison) without concrete
production evidence it's needed; only the unconditional ratchet-based guarantee ships in this
phase.

`src/reasoning/promptBuilder.ts` includes a compact `milestones` block in the prompt
(`completedMilestones`/`totalMilestones`/`activeSubGoal`) only once a task declares **two or
more** milestone groups (`MIN_MILESTONE_GROUPS_FOR_PROMPT`) — the common single-criterion task
(every pre-existing caller) gets a prompt payload byte-for-byte unaffected by this field's
existence.

**Ordering is now an enforced evaluation constraint, not only a prompt hint (regression fix).**
`activeSubGoal` above was, until this fix, purely advisory: `evaluateSuccessCriteria` itself
evaluated every not-yet-satisfied criterion every call, independent of declaration order, so a
later milestone's own `semantic_page_match` criterion could be satisfied by the *current* page
even while an earlier milestone remained outstanding — exactly what let a homepage's own
persistent navigation (which happened to name every downstream destination of a five-milestone
journey) satisfy all five milestones on the very first step. `evaluateSuccessCriteria`
(`src/core/successEvaluator.ts`) now computes, on every call, the first not-yet-satisfied
`required` group in declaration order (`computeEligibleCriteriaIds`, using
`alreadySatisfiedCriteriaIds` as it stood when the call began — never updated mid-call) and only
evaluates that group's members and every non-required group; a later required group is not
evaluated at all until every earlier one is satisfied, and at most one required group can newly
satisfy per call. Optional (`required: false`) groups remain entirely unaffected — still
evaluated unconditionally, exactly as before. This pairs with a second, independent change to
`src/core/semanticPageMatch.ts`: persistent site-wide navigation/menu/header/footer chrome
(`<nav>`, `<header>`, `<footer>`, or the equivalent ARIA landmark roles) is excluded from the
`"interactiveElements"` signal, so a link that merely advertises a destination elsewhere on the
site is never itself counted as evidence that destination was reached. Neither change alone was
sufficient: ordering stops several milestones from satisfying off one unchanged, un-navigated-past
observation; the chrome exclusion stops that same observation's own persistent nav from
masquerading as page content once a later milestone does become active. See
`docs/n8n-integration.md` §9f/§9 for the full caller-facing explanation, and
`diagnostics.milestoneEvidence` (§9g there, `MilestoneEvidenceRecord` in
`src/types/task-response.ts`) for the per-criterion evidence record this fix also added, so a
run's `TaskResponse` can explain exactly which page and mechanism satisfied each milestone.

### Branch-entry condition

A branch is only ever entered around a **successfully dispatched, safety-allowed `click`/
`navigate` candidate** (`computeCandidateIdentity`, PR #42) when all of the following hold
(`src/core/loop.ts`, using helpers from `src/core/branchExploration.ts`):

- no branch is already active (single active branch only — no nesting, no concurrency);
- a required milestone remains unsatisfied;
- `go_back` is one of the task's `allowedActions` (a branch that could never return is never
  started);
- the candidate budget at this exact decision-point fingerprint is not yet exhausted
  (`MAX_CANDIDATE_BUDGET_PER_DECISION_POINT`, 2);
- this exact candidate has no already-recorded branch result at this decision point (never
  re-enter a branch already known to be a dead end);
- `computeEffectiveBranchDepth(...) > 0` given the run's remaining budget (see below);
- and, the entry condition proper: `isAmbiguousMultiCandidateDecisionPoint` — the pre-dispatch
  observation offered **at least two distinct candidates**, and **no candidate's own
  `objectiveRelevanceScore`** (`src/discovery/relevance.ts`) **clears `MIN_DOMINANT_RELEVANCE_
  SCORE` (0.5)** — i.e. no candidate's label is a genuinely dominant lexical match.

This condition went through two iterations before landing here, both worth recording since the
second directly caught a regression against an existing PR #41 test:

1. Originally "every candidate scores zero". A candidate whose label shares one *incidental*
   word with the objective/criteria text (without that word actually indicating the right path)
   could silence branch exploration for the *whole* decision point — including for a genuinely
   zero-relevance alternative that might be the real route.
2. Revised to "no candidate uniquely holds the top score" (tie-based) to close that gap. This
   introduced a real regression: `tests/integration/journeyReplanning.test.ts`'s
   domain-blocked-replanning scenario has one page offering both "Continue" and "Objective
   control" for an objective that literally names both in sequence — each fully matches its own
   short label and both tie at the maximum possible score, 1.0. `objectiveRelevanceScore`'s
   equality alone cannot distinguish "these tie because neither means anything" from "these tie
   because both are excellent matches" — only the score's own *magnitude* carries that
   information, so a bare tie check incorrectly triggered branch mode on a page the existing,
   already-validated direct-selection behaviour already handled correctly.

The magnitude threshold supersedes tie-detection entirely: a candidate whose score is `overlap /
candidateTokens.size` clears 0.5 when at least half of the candidate's own words are drawn from
the objective/criteria text — a genuinely dominant match, trusted regardless of whether another
candidate ties it. Below that bar — a unique-but-weak score, a weak tie, or an all-zero tie alike
— nothing but the model's own semantic judgement is actually choosing, which is exactly when
branch bookkeeping earns its cost. `tests/unit/branchExploration.test.ts` carries the regression
case directly (a strong 1.0/1.0 tie must not be ambiguous) alongside the original gap case (a
weak, unique, non-dominant score must still be ambiguous).

Deliberately scoped to `click` candidates surfaced via `Observation.interactiveElements` only — a
`navigate` action is not something visibly "offered" at a decision point the way an interactive
element is, so it does not participate in this ambiguity signal (though a `navigate` can still
separately become a tracked branch once dispatched).

This condition is what keeps an ordinary, unambiguous journey (any page where a candidate's label
already lexically stands out, or where fewer than two distinct candidates exist at all) entirely
untouched by this phase — proven by `tests/integration/branchExploration.test.ts`'s own
backward-compatibility test.

### Branch depth and candidate budget within the run's remaining limits

`computeEffectiveBranchDepth` reduces the fixed default (`DEFAULT_MAX_BRANCH_DEPTH`, 3 — chosen
to stay comparable to, not dominant over, `MAX_JOURNEY_REPLANNING_ATTEMPTS`'s own existing
budget of 2, not merely because "two or three" was mentioned in the originating investigation)
so a branch never promises more of the run's remaining budget than it can actually afford:

```
totalStepsNeeded(d) = d (downstream) + (d + 1) (worst-case return hops) + 1 (one more candidate)
effectiveDepth = max(0, min(requestedMaxDepth, floor((stepsRemaining - 2) / 2), backtracksRemaining - 1))
```

recomputed fresh at *every* branch-entry decision from whatever budget genuinely remains at that
moment — never a value fixed once per run. Once at least 90% of `maxDurationSeconds` has already
elapsed, this returns 0 regardless of the step/backtrack numbers (no safe step-to-duration
conversion exists, so this is treated coarsely and conservatively). An effective depth of 0 means
branch entry does not happen at all — the candidate simply dispatches as an ordinary action,
exactly as it would have before this phase.

`MAX_CANDIDATE_BUDGET_PER_DECISION_POINT` (2) bounds how many separate branches may be entered
at one decision-point fingerprint — a hard, engine-owned ceiling, not an action-denial mechanism:
once exhausted, a candidate at that fingerprint can still be dispatched as an ordinary action, it
simply no longer gets multi-step branch tracking. Under tight production limits (e.g. `maxSteps:
10`, `maxBacktracks: 3`), the depth/budget interaction can reduce a branch to depth 1 or prevent
entry entirely by the time a decision point is reached several steps into a journey — this is
intentional graceful degradation (never an unsafe overrun), not a bug; a deployment that wants
consistent depth-3, two-candidate exploration should budget `maxSteps`/`maxBacktracks`
accordingly (roughly 25–30 / 8–10 comfortably covers the worst case of two candidates each at
depth 3 with full-length returns), left as an explicit per-deployment decision rather than
silently changed by the engine.

### Branch lifecycle and progress assessment

`BranchRecord` (`src/core/branchExploration.ts`, held at `RunState.activeBranch` while active and
moved into the bounded `RunState.branchHistory` once closed — capped at `MAX_BRANCH_HISTORY`, 20)
carries: `branchId`, `decisionPointId` (the origin fingerprint), `candidateId`/`candidateLabel`,
`entryStepIndex`, `depth`/`maxDepth`, `visitedFingerprints` (decision points seen since entry, for
in-branch loop detection), `satisfiedCriteriaIdsAtEntry`/`newlySatisfiedCriteriaIds`,
`consecutiveNoProgress`, `result`, and `returnStatus`/`returnHopsAttempted`/`returnHopsBudget`.
Single active branch only — no nesting, no concurrent branches, matching this phase's explicitly
narrow scope.

At the top of every step while a branch is active and still exploring (`!branch.result`),
`src/core/loop.ts` runs `assessBranchProgress` (`src/core/branchExploration.ts`) — **evidence
only, never a bare model assertion** — using signals the engine already computes every step:

- `depth += 1` after every successful in-branch dispatch (never the entry action itself, and
  never a return hop);
- the current decision-point fingerprint is compared against `visitedFingerprints`, but **only
  when the last action actually produced a page-state change** (`observedProgress !== false`) —
  a step whose last action never left the current page is not a "revisit" of anything, it simply
  never went anywhere; conflating the two would let a trivial same-page no-op pre-empt the
  dedicated no-progress check below before it ever gets a chance to fire;
- two consecutive in-branch actions with `observedProgress === false` (PR #40, reused unchanged)
  end the branch early;
- the branch-depth budget being reached always ends the branch, but distinguishes
  `plausible_progress` (evidence was gained) from `dead_end` (none was);
- a newly-satisfied criterion within the branch is `goal_progress`, and continues the branch.

A **failed dispatch** or a **safety-layer rejection** of a decision that would have continued an
active, still-exploring branch is handled inline, at its own point in `runStep`, rather than
deferred to the next step's assessment: it closes the branch immediately as `blocked` (a
non-safety, mechanical obstruction) or `unsafe` (a safety-rule rejection — `classifyClosureFrom
SafetyFlags` maps `loop_detected` to `dead_end`, `domain_blocked`/`action_not_allowed` to
`unsafe`, everything else to `blocked`) and begins the return sequence in place of ending the
whole run. This is the one generic behavioural change worth calling out precisely: a click/
navigate failure or safety rejection that would, *outside* an active branch, still end the run
(subject to PR #41's own existing recovery), instead only ends the *branch* while one is active
— the run itself continues via the return sequence below.

### Fingerprint-verified, bounded multi-hop return

Once a branch closes with anything other than `success`, `src/core/loop.ts` performs a bounded
return toward `branch.decisionPointId`, reusing the exact same `go_back` execution and
`RunState.recordAction`/backtrack-accounting path PR #41's own single-hop substitution already
uses — never a new execution primitive. `returnHopsBudget` is set to `depth + 1` at closure (a
maximum, never assumed to be the actual count needed): after **every single** `go_back` hop, the
next `runStep` call's fresh observation is fingerprint-checked against `decisionPointId` *before*
any further hop is attempted — restoration stops the moment it's verified, never dispatching a
hop it didn't need. If the hop budget is exhausted without a match, `go_back` isn't an allowed
action, or a hop itself fails to execute, `returnStatus` becomes `restore_failed` and the run
stops immediately with terminal `blocked` / `finishReason: "decision_point_restore_failed"` —
the engine never continues from a position it cannot verify. Browser-history depth is never
assumed to equal branch depth; this is precisely why the check runs after every hop rather than
issuing a fixed count up front.

PR #41's own single-hop `stop_blocked` → `go_back` substitution remains **unmodified** as the
final pre-stop fallback for a `stop_blocked` situation *outside* any active branch — the new
return sequence only engages, in its place, for a `stop_blocked` that would have closed an
*active* branch.

### Route Memory extension

`RouteMemoryCandidateSummary`/the internal `RouteMemoryEntry` (`src/types/routeMemory.ts`,
`src/core/routeMemory.ts`) gain `branchDepthReached`/`branchResult`/`branchAttempts`, written only
by the new `RouteMemory.recordBranchResult` — **`lastOutcome`/`attempts` keep exactly their PR
#42 meaning**, a single dispatched action's own mechanical outcome, untouched by branch
bookkeeping (`record()` is careful to preserve any existing branch fields across a later,
unrelated call for the same candidate, e.g. if it's later dispatched again as an ordinary
non-branch action once its own candidate budget is exhausted). `getTriedCandidates` — already
surfaced to the reasoning prompt as `routeMemory` — carries both fields for a candidate whenever
present, so a returned-to decision point shows both "the last time this exact click was
dispatched" and "the last time a branch was explored through it" as distinct, non-conflicting
evidence. Route Memory remains **advisory** for this purpose — the prompt's own guidance prefers
an untried candidate or one whose `branchResult`/`lastOutcome` is favourable, but the only *hard*
engine-enforced rule remains the candidate budget itself (never a general action-denial
mechanism).

### Diagnostics: no wire-schema change

Every branch-lifecycle event (entry, closure, return hop, restore failure) is recorded through
existing, already-free-form fields — `captures.errors` (via `recordDiagnosticError`, when the
`errors` capture module is requested) and `StepLog.safetyFlags`/`decision` — exactly the
precedent PR #41 established for journey-replanning diagnostics. Return-hop steps carry
`safetyFlags: ["branch_return_attempted"]` (or `"branch_restore_failed"`) directly, so they are
identifiable from `TaskResponse.steps` alone without needing to cross-reference `captures.errors`.
No `TaskResponse.schemaVersion`/`outputSchemaVersion` bump was needed for this phase.

Correlating a specific `cta_clicks`/`journey_path`/`data_layer_evidence`/`ga4_network_events`
entry with "which branch was this evidence produced during" is possible today via `stepIndex`
join against the `captures.errors` branch-lifecycle entries and `journey_path`'s own
`decisionReason` (= `StepLog.decision`, which already contains descriptive branch text) — but
there is no single structured label field for it yet. A dedicated `StepLog.explorationLabel`
(`primary_route`/`exploratory_branch`/`branch_return`/`discarded_branch`/`final_success_route`)
remains explicitly out of scope for this phase, deferred as a follow-up once this phase's
behaviour has been validated against real runs — the same deliberate-deferral discipline Route
Memory Phase 1 (§16) itself set.

### Scope

Single active branch (no nesting/concurrency); no task-level branch-depth or candidate-budget
override (both are fixed, internal constants for this phase, matching `MAX_JOURNEY_REPLANNING_
ATTEMPTS`'s own precedent); no live (as opposed to ratchet-based) required-entity-context
tracking; no public analytics exploration labelling; no cross-run memory, RAG, vector storage, or
persistent experience repository of any kind — `BranchRecord`/`RunState.branchHistory` are
discarded with the rest of the run's state once `runTask` returns, exactly like `RouteMemory`
itself.

## 18. Overlay-click detection, fallback verification, and modal-aware observation

Production incident: a CTA click handler successfully began opening an overlay (a same-document
modal identified only by `role="dialog"`/`aria-modal="true"`, backed by a hash-only URL change
the handler itself set as a side effect). Playwright's own actionability retry loop reported the
click as failed (`intercepted`) because the overlay's own backdrop came to cover the trigger
element mid-click. The engine discarded that state and fell back to `actions/click.ts`'s generic
`destinationUrl` navigation fallback — a raw `page.goto()` to the same hash URL. Since that
fallback never runs the site's click handler at all (a fragment-only navigation only fires
`hashchange`, never `click`), it changed the URL without ever opening the overlay. Every
subsequent observation then correctly, freshly reported the unchanged underlying page — not a
staleness/caching bug, but an accurate scan of a page state the fallback never actually reached.
Compounding this, Route Memory classified the fallback's URL change alone as `"advanced"`
(misleading the reasoning layer into retrying), and a repeated-card listing page (every card
sharing an identically-labelled CTA) meant the retried candidate's own identity was
indistinguishable from any other card's CTA of the same name.

Four independent, brand-agnostic fixes address this, all scoped to already-generic engine
mechanisms — nothing here is specific to any one site, brand, or CTA label.

### Overlay-click side effect detection (`src/actions/click.ts`, `src/observation/observationBuilder.ts`)

`observationBuilder.ts` exposes a lightweight `InteractionSnapshot` (whether a visible dialog
exists and a compact identity for it, plus a sorted set of visible interactive elements' own
`role::accessibleName` identities — never raw HTML) and a pure `detectClickSideEffect(before,
after)` comparison: a newly-appeared or changed dialog is treated as strong evidence on its own;
otherwise, at least `MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE` (2) newly-appeared visible
interactive elements are required, so a single incidentally-injected ad/analytics/font-loading
element is never mistaken for a real overlay (a genuine modal/drawer almost always introduces
several controls — heading, close control, its own actions — at once).

**Target-attributable click success.** `detectClickSideEffect` above is a whole-page, target-blind
comparison: a click on one control cannot be told apart, from that comparison alone, from an
unrelated element (a cookie banner, an ad, an unrelated timer-driven widget) happening to mutate
at the same moment — exactly the false-positive class a real production incident demonstrated (a
click intercepted by an unrelated consent overlay was reported as successful because the overlay
itself, not the clicked control, changed state around the same time). `detectTargetAttributableSideEffect(before, after, targetBefore, targetAfter)` requires the
observed change to be attributable to the clicked target specifically: a genuine dialog/modal
signal (`role="dialog"`/`aria-modal="true"`/native `<dialog>`) is still trusted unconditionally,
exactly as before — that markup is a standards-based fact the page author chose to declare, not a
heuristic, and very few things other than the user's own just-dispatched click cause one to
appear in the same bounded settle window. Only the *weaker* elements-count fallback signal (no
dialog markup at all) now additionally requires target self-evidence: the target's own
`aria-expanded` flipping to `"true"`, the target becoming newly covered (its own click opened a
surface that now sits on top of it), or the target disappearing from the DOM entirely. An
unattributed whole-page mutation with zero involvement of the clicked target — no dialog, no
effect on the target itself — now correctly reports `detected: false`.

`actions/click.ts` captures a pre-click `InteractionSnapshot` and the target's own
pre-click state (via `readElementState`/`targetElementSnapshot`) unconditionally, before
anything else touches the page. When a direct click throws a Playwright interception timeout
specifically classified as `"intercepted"` (never the broader `"timeout"` catch-all, and never
`"disabled"`), a bounded, mutation-aware settle wait (`waitForInteractionSideEffect`, polling
every 100ms up to `CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS` = 1000ms, exiting as soon as a side effect
is recognised rather than always waiting out the full budget) re-captures the snapshot and the
target's own state, and compares both via `detectTargetAttributableSideEffect`. If evidence is
found, the click is reported as a success (`ActionResult.clickSideEffectDetected: true`) and the
`destinationUrl` fallback is never invoked at all — the overlay's own DOM state is preserved
exactly as the browser rendered it, so the next observation exposes its controls normally. A
single additional lightweight snapshot (no extra wait budget) is also taken after an ordinary,
non-intercepted non-navigating click success, so a click that opens a same-document modal
*without* ever looking intercepted is equally recognised — this feeds §18's route-progress
classification below as much as the recovery path does.

### Fallback verification (`src/actions/click.ts`)

`verifyFallbackNavigation` treats a `destinationUrl` fallback that reaches a materially
different origin/path/query as inherently verified (an ordinary GET navigation is exactly what
the fallback exists for — see the original design note in §5's "Action-execution consistency").
A fallback that only changes the URL's fragment or query on the *same* path is not assumed
equivalent to a real click: the target's own live state is re-read after the fallback navigation
(via `readElementState`) and compared, together with the pre-click `InteractionSnapshot`
baseline, via `detectTargetAttributableSideEffect` — the same target-attribution requirement
side-effect detection above uses. `ActionResult.fallbackVerified` is set accordingly
(`true`/`false`, always present when a fallback was used), and `ActionResult.
fallbackVerificationReason` names the specific mechanism (`"path_changed"`, a
`ClickSideEffectType` value, or `"unverified_hash_or_query_only_change"`).

**`fallbackVerified` is no longer diagnostic-only.** Previously an unverified fallback was still
reported as a successful action (the dispatch itself mechanically succeeded, so the run was never
blocked on it) — only excluded from the route-progress classification below counting it as
`"advanced"`. That let a fallback whose only evidence was an unattributed URL change be silently
reported as journey progress at the `ActionResult`/`StepLog` level even though nothing about it
was ever confirmed. `ActionResult.success` is now `false` whenever `fallbackVerified` is `false`,
with `staleTarget: true` — the same non-fatal, bounded recovery classification a directly-stale
target already used (`MAX_STALE_TARGET_RECOVERY_ATTEMPTS` in `core/loop.ts`), giving the
reasoning layer a further genuine chance instead of silently reporting unverified progress as
success.

### Modal-aware observation and prompt prioritisation (`src/observation/observationBuilder.ts`, `src/reasoning/promptBuilder.ts`, `src/actions/scroll.ts`)

`buildObservation` additionally scans for the first visible `role="dialog"`/`aria-modal="true"`/
native `<dialog>` surface and, when present, reports it as `Observation.activeDialog` (role plus
a short accessible-name excerpt — never full content, which is still carried element by element
in `interactiveElements` as before). Descendant controls of an open dialog need no separate
scan change: they are ordinary light-DOM elements already covered by the existing
`interactiveElements` scan. Background controls sitting underneath the dialog are, in the common
case (a full-viewport backdrop), already reported `covered: true` by the pre-existing
`elementFromPoint` hit-test — reused here rather than duplicated. `promptBuilder.ts`'s prompt-
element-selection budget excludes zero-relevance `covered` elements from its structural
(non-lexical) pools whenever `activeDialog` is present, so background chrome can never squat on
the fixed structural budget a genuinely reachable control needs; a covered element that still
scores positively on lexical relevance remains reachable exactly as before. The system prompt
also gains one sentence: when `activeDialog` is present, prefer its own controls over background
page controls. `scroll.ts` looks for the first visible, genuinely scrollable dialog surface
(`scrollHeight > clientHeight`) and moves the mouse into it before wheeling, so a scroll issued
while a modal is open moves inside the modal; with no such surface, scrolling behaves exactly as
before this fix (a plain `page.mouse.wheel` at the current cursor position). Shadow DOM and
cross-origin frames remain out of scope for this fix — see "Known limitations" below.

### Repeated-card candidate identity (`src/core/routeMemory.ts`, `src/core/branchExploration.ts`)

A candidate's identity is now built by the shared `buildClickIdentityKey` helper (used by both
`computeCandidateIdentity` and `isAmbiguousMultiCandidateDecisionPoint`, so Route Memory and
branch-entry ambiguity detection stay consistent): a click element's own `destinationUrl` is
used when present (the strongest, most stable per-card signal — a repeated-card CTA's own href
routinely differs per card, e.g. a distinct product/offer id), falling back to the element's
`nearestHeadingText` — a short, bounded ancestor-walk-derived string naming the nearest
enclosing heading, a generic proxy for "which card/section this control belongs to" — for a
plain `<button>` with no href. Falls back to the bare `role::accessibleName` identity, unchanged
from before this fix, only when neither signal is available (genuinely indistinguishable from
this engine's own generically-captured evidence).

### Route progress classification (`src/core/loop.ts`, `src/core/state.ts`)

A successful click/navigate candidate's Route Memory outcome (`"advanced"` vs `"no_change"`) is
computed synchronously, immediately after each step's own success-criteria evaluation, rather
than deferred to the next step's URL/title diff (the previous `RunState.recordRouteMemoryPending`
/ `resolveLastActionProgress` mechanism this replaces — `RunState.resolveLastActionProgress`
itself is unchanged for its other purpose, filling in `RecordedAction.observedProgress`).
`"advanced"` now requires at least one of: a milestone/success criterion newly satisfied by this
action; `ActionResult.clickSideEffectDetected`; or a URL change that was not itself an unverified
fallback (`ActionResult.fallbackVerified !== false`). An ordinary direct click or `navigate`
action's URL/title change — the overwhelming common case — is classified exactly as before,
since `fallbackVerified` is only ever present when a fallback was actually used.

### Schema impact

Additive only (`schemaVersion`/`outputSchemaVersion` "1.10.0" → "1.11.0"): `Observation.
activeDialog`, `InteractiveElement.nearestHeadingText`, `ActionResult.clickSideEffectDetected`,
`ActionResult.fallbackVerified`. No existing field was removed, renamed, or had its meaning
changed.

### Known limitations

- Dialog/overlay detection (`activeDialog`, `InteractionSnapshot.hasDialog`) is standards-based
  (`role="dialog"`, `aria-modal="true"`, native `<dialog>`) and main-document only — it does not
  reach into shadow DOM or into a same-origin child frame's own dialog. Widening either is
  deferred as a follow-up, matching this repo's existing deliberate-deferral discipline (§16,
  §17) rather than being bundled into this fix.
- `MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE` (2) is a fixed, generic heuristic, not a
  guarantee: a modal that introduces exactly one new interactive control and does not use
  `role="dialog"`/`aria-modal` would not be recognised by the fallback signal alone (the
  dialog-based signal remains the primary, highest-confidence path).
- Route Memory remains observe-and-inform only (§16) — a candidate correctly classified as
  `"no_change"`/`"blocked"`/`"dead_end"` is surfaced strongly in the reasoning prompt (existing
  guidance, reinforced by more accurate classification and per-card identity from this fix) but
  is never mechanically blocked from being re-selected. Broadening Route Memory into an
  enforcing mechanism was deliberately left out of this fix's scope.
