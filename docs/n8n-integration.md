# n8n Integration

n8n is the external orchestrator. It owns triggering, forms, human review, Google Sheets,
BigQuery, and reporting. The navigation engine's job is narrow and mechanical: accept a
validated task, run the navigate/observe/decide/act loop, and return a validated result. This
document describes the HTTP contract between the two.

**Current status:** a minimal HTTP server implementing this contract exists (`src/api`, see
`README.md` §"Local HTTP API"), with a Docker image for deployment (see `README.md` §"Docker").
It defaults to the mock reasoning provider against local fixtures/target URLs, and requires a
bearer token on both task endpoints (§5). It still stores runs **in-memory only** — see §8 —
so before pointing a real n8n instance at a deployed instance, confirm that limitation is
acceptable for your workflow (typically: short-lived runs, one engine instance, and n8n polling
promptly enough that a restart between submit and poll is unlikely/acceptable).

## 1. Roles

- **n8n**: builds a `task-request` JSON per run (from a form, a schedule, or a Sheets row),
  calls the engine's HTTP API, receives a `task-response` JSON, and fans the result out to
  Sheets/BigQuery/Slack/etc.
- **Engine**: stateless with respect to orchestration — it does not know about forms, sheets,
  or schedules. It validates the incoming request against `schemas/task-request.schema.json`,
  runs the loop, and returns a response validated against
  `schemas/task-response.schema.json`.

## 2. Request/response contracts

The wire format is exactly the JSON Schemas in `/schemas`:

- Request body: `schemas/task-request.schema.json`, worked examples in `/examples`.
- Response body: `schemas/task-response.schema.json`.

Both sides should validate against these schemas — n8n before sending (fail fast on a
malformed task) and the engine on receipt (never trust the network boundary). `schemaVersion`
and `outputSchemaVersion` in the request let both sides detect a contract mismatch explicitly
rather than failing on unexpected fields later in the run.

## 3. Endpoints (implemented as a local proof of concept)

```
POST /v1/tasks
```
Submits a new task-request. Because a configurator journey can take minutes, this endpoint
responds quickly with a run handle rather than blocking for the full run — the current
implementation starts the run in the background and returns immediately:

```json
{ "taskId": "example-configurator-journey-0001", "runId": "run_...", "status": "accepted" }
```

A body that isn't valid JSON, isn't `Content-Type: application/json`, or fails
`task-request.schema.json` validation is rejected (`400`/`415`) and no run is started.

```
GET /v1/tasks/{runId}
```
Returns `{ "status": "running" }` while the run is in progress, `{ "status": "failed", "error": "..." }`
if the engine could not produce a result at all, or `{ "status": "completed", "result": <task-response> }`
once finished — `result` is the same `task-response` body described below (`status` field per
the response schema: `success`, `blocked`, `failure`, `max_steps_reached`,
`max_backtracks_reached`, `max_duration_reached`). An unknown `runId` returns `404`.

```
GET /v1/health
```
Basic liveness/readiness check for n8n to gate scheduled workflows on, and what the container's
`HEALTHCHECK` calls. Unauthenticated by design. Returns only `{ status, service, version }` — no
environment details, dependency versions, filesystem paths, or secrets.

**Not yet implemented:** a durable/shared task store (runs are in-memory and lost on restart —
see §8 and `README.md`), queues, webhooks, dashboards, cloud-vendor-specific deployment files,
and rate limiting. None of these are wired up in this phase.

### Sync vs. async (resolved for the local proof of concept)

Submit-and-poll (above) is what's implemented, so n8n's HTTP Request node isn't held open for
the duration of a multi-minute journey. A webhook-callback variant (engine POSTs the finished
`task-response` back to an n8n webhook URL supplied in the request's `metadata`) is a
reasonable alternative and is easy to add later without breaking the schema — it's a delivery
mechanism, not a contract change. Not implemented in this phase.

## 4. Error handling

- **Request fails schema validation**: engine returns `400` with a validation error list; no
  run is started. n8n should treat this as a workflow-config bug, not retry blindly.
- **Run stops via a safety guardrail** (`blocked`) or exhausts a limit (`max_steps_reached`,
  `max_backtracks_reached`, `max_duration_reached`): this is a normal, schema-valid
  `task-response`, not an HTTP error. n8n branches on `status` to decide what to do next (e.g.
  alert a human, log as inconclusive).
- **Engine crashes mid-run** (unhandled error, browser crash): the engine should still attempt
  to return a best-effort `task-response` with `status: "failure"`, a populated
  `diagnostics.finishReason`, and any captures/screenshots gathered up to that point, rather
  than only a bare HTTP `500`. A `500` is reserved for cases where no response body could be
  constructed at all.

## 5. Authentication

`POST /v1/tasks` and `GET /v1/tasks/:runId` require a shared-secret bearer token
(`src/api/auth.ts`), resolving open decision #1 in `docs/v1-scope.md`. Configure it via the
`NAVIGATION_ENGINE_API_TOKEN` environment variable on the engine side, and have the n8n HTTP
Request node send the same value:

```
Authorization: Bearer <NAVIGATION_ENGINE_API_TOKEN>
```

In n8n, store the token as an n8n credential (or environment-backed expression), never as a
literal value pasted into the workflow JSON, and set that credential's header on both the
`POST /v1/tasks` and `GET /v1/tasks/:runId` HTTP Request nodes. `GET /v1/health` needs no
header.

Missing, malformed, or incorrect credentials get `401` — the comparison is constant-time and
the response body/logs never reveal whether a submitted token was close to correct. The engine
process itself refuses to start if `NAVIGATION_ENGINE_API_TOKEN` is unset outside its test
suite, so a misconfigured deployment fails at boot rather than serving a route nothing can
authenticate against.

**No credential of any kind is stored in this repository.** Both n8n and the engine read
`NAVIGATION_ENGINE_API_TOKEN`/`ANTHROPIC_API_KEY` from their own runtime environment — in a
real deployment, **from the hosting platform's own secret manager** (e.g. its
environment/secret store), never from a file baked into the Docker image or committed to
source. See `README.md` §"Docker" for how the token is passed into a container at run time.

## 6. What n8n is expected to own downstream of the engine

- Turning `captures.*` arrays into rows in Google Sheets / BigQuery tables.
- Turning `engineAssessment` (objective achieved, confidence, summary) into pass/fail signals
  for reporting or alerting.
- Retrying a task (the engine does not auto-retry a finished run; re-submission is a new
  `task-request`, typically with the same `taskId` semantics left to n8n's convention).
- Any human-in-the-loop review, e.g. surfacing a `blocked` or `failure` result for manual
  follow-up.
- Long-term storage/retention of screenshots and other artifact references returned in
  `captures` (the engine returns references, not binaries, per `docs/v1-scope.md` assumptions).

## 7. Versioning expectations

`schemaVersion` (request) and the response's `schemaVersion` are independent, exact-match
version strings (e.g. `"1.0.0"`). A breaking change to either contract bumps that version and
should be treated by n8n as a distinct integration to test, not an in-place upgrade. Additive,
backward-compatible fields (e.g. a new optional capture module) can ship under the same major
version once the project adopts semantic versioning conventions for the schemas — not yet
formalized in v1.

**Example (already applied):** adding `diagnostics.reasoningProvider` to the response bumped the
response contract's `schemaVersion` and the request's `outputSchemaVersion` from `"1.0.0"` to
`"1.1.0"` (both are still exact-match `const`s, not a range, so an n8n workflow pinned to
`"1.0.0"` must update the value it sends). The change itself is additive — no existing response
field was removed or renamed, and `diagnostics.reasoningProvider` is itself independently
versioned (see README "Reasoning provider usage diagnostics") so it can evolve again without
necessarily forcing another top-level `schemaVersion` bump.

**Example (already applied, again):** adding preflight domain discovery (see
`docs/architecture.md` "Preflight domain discovery") made the request's `allowedDomains` field
optional and added an optional `journeyType` field, bumping the request contract's own
`schemaVersion` from `"1.0.0"` to `"1.1.0"`. The additive `diagnostics.domainDiscovery`
structure on the response bumped the response contract's `schemaVersion` and the request's
`outputSchemaVersion` from `"1.1.0"` to `"1.2.0"`, the same way as the reasoningProvider example
above. An n8n workflow that already sends an explicit `allowedDomains` list keeps working
unchanged (it is still honored, unioned with whatever preflight discovery itself proposes) —
only the version strings themselves need updating.

**Example (already applied, again):** adding the `semantic_page_match` success-criteria type
(see §9 below) bumped the request contract's own `schemaVersion` from `"1.1.0"` to `"1.2.0"`.
The response contract and `outputSchemaVersion` are unaffected and stay at `"1.2.0"` — this
change only widened `successCriteria[].type`'s enum; it added no new field and changed no
existing one. An n8n workflow already sending `schemaVersion: "1.1.0"` continues to validate
exactly as before as long as it doesn't try to use `semantic_page_match` — but per this repo's
convention (every request-contract change bumps the const, even an additive one), the engine
now only accepts the literal string `"1.2.0"`, so every caller must update the value it sends,
whether or not it uses the new criterion type.

**Example (already applied, again): `"1.2.0"` → `"1.3.0"`.** Adding the generic
action-attributed analytics capture (§9d below) and widening observation evidence
(§"Observation evidence" in `docs/architecture.md`) added new, purely additive fields to the
**response** contract only: `captures.cta_clicks[].resultingTitle`/`actionAnalytics`, and
`observation.interactiveElements[].disabled`/`ariaState`/`observation.progressIndicatorText`.
No existing response field was removed, renamed, or had its meaning changed. Per this repo's own
stated convention above (every contract change bumps the const, additive or not), the response
contract's `schemaVersion` moved from `"1.2.0"` to `"1.3.0"`. The **request** contract's own
shape did not change at all — but the request's `outputSchemaVersion` field is defined to always
track the response contract's version (see its own schema description), so its required literal
value also moved to `"1.3.0"`, which in turn is itself a request-contract change under this
repo's convention, so the request contract's own `schemaVersion` moved from `"1.2.0"` to
`"1.3.0"` too, even though no other request field changed. An n8n workflow must update **both**
version strings it sends (`schemaVersion` and `outputSchemaVersion`) to `"1.3.0"` — see the
`examples/*.json` fixtures in this repo, all of which were updated the same way.

**Example (already applied, again): `"1.3.0"` → `"1.4.0"`.** Widening observation evidence
further (§"Observation evidence" in `docs/architecture.md`) added one new, purely additive field
to the **response** contract: `observation.interactiveElements[].covered`, true when another
element currently sits visually on top of a control so it cannot actually be clicked. No
existing response field was removed, renamed, or had its meaning changed. Per this repo's own
stated convention, the response contract's `schemaVersion` moved from `"1.3.0"` to `"1.4.0"`, and
— by the same chain as the previous bump — the request contract's `outputSchemaVersion` and its
own `schemaVersion` both moved to `"1.4.0"` too, even though no other request field changed. An
n8n workflow must update both version strings it sends to `"1.4.0"` — see the `examples/*.json`
fixtures in this repo, all of which were updated the same way.

**Example (already applied, again): `"1.4.0"` → `"1.5.0"`.** The blocker-recovery fix
(§"Blocker recovery" and §"Frame-aware observation" in `docs/architecture.md`) widened both
contracts:

- **Request** (additive, optional): `safety.consentInteractionPolicy` — one of
  `"reject_optional"` (the default when omitted — no existing n8n workflow needs to send this to
  keep its current behaviour), `"essential_only"`, `"accept_optional"`, or `"do_not_interact"`.
  Also additive to `captureModules`: the new opt-in `"host_context_snapshot"` module.
- **Response** (all additive): `observation.interactiveElements[].frameOrigin` and
  `observation.inaccessibleFrameOrigins` (generic, one-level same-origin iframe evidence);
  `actionResult.staleTarget` (a failed action's cause was mechanically classified as the target
  going stale, not a genuinely wrong decision); `steps[].reObservationAttempted` and
  `steps[].recoveryAttempts` (was the bounded pre-dispatch recovery loop used this step, and how
  many cycles); `errors[].category` gained the additive `"stale_target_recovery"` value; and the
  new `captures.host_context_snapshot[]` array (bounded, names-only cookie/storage footprint,
  populated only when the `host_context_snapshot` capture module is requested).

No existing field on either contract was removed, renamed, or had its meaning changed. Per this
repo's own stated convention, the response contract's `schemaVersion` moved from `"1.4.0"` to
`"1.5.0"`, and the request contract's `outputSchemaVersion` and its own `schemaVersion` both moved
to `"1.5.0"` too, even though `safety.consentInteractionPolicy` is the only other request-visible
change. **An n8n workflow must update both version strings it sends to `"1.5.0"`** — see the
`examples/*.json` fixtures in this repo, all of which were updated the same way. No other n8n-side
change is required: every new field on both contracts is optional/additive, so a workflow that
only bumps the two version strings continues to behave exactly as before. A workflow that wants
the new recovery behaviour's policy latitude explicitly configured should add
`safety.consentInteractionPolicy` to its request body; a workflow that wants the new cross-host
cookie/storage diagnostic should add `"host_context_snapshot"` to `captureModules`.

## 8. Task store and instance limitations

Runs are held in an in-memory `Map` (`src/api/taskStore.ts`) with **no persistence**:

- **All run state is lost when the process/container restarts.** A run n8n submitted and hasn't
  polled to completion yet disappears on restart; n8n sees `404` on the next poll and should
  treat that as "unknown/lost run", not retry the same `runId`.
- **Run one engine instance.** Because the store isn't shared, a second instance behind a load
  balancer would never see runs created on the first — `POST /v1/tasks` and the later
  `GET /v1/tasks/:runId` poll must land on the same instance.
- **Before scaling to multiple instances**, add a persistent or shared task store (e.g. a
  database or shared cache keyed by `runId`) that every instance reads and writes — this is a
  known, deliberate v1 gap, not an oversight, and out of scope for this phase (see
  `docs/v1-scope.md`).

n8n workflows built against this engine should assume runs are ephemeral: poll promptly after
submission, and design for an occasional lost run (engine restart, deploy) the same way they'd
handle any other transient infrastructure failure.

## 9. Generic success criteria

`successCriteria[].type` (`schemas/task-request.schema.json` `$defs/successCriterion`,
`src/core/successEvaluator.ts`) currently supports six values. Only three are actually
evaluated by the engine today — `data_layer_event`, `network_event`, and `custom` are reserved
enum values with no evaluator case yet (they always evaluate as not-satisfied; a future
change would need to add a matching `case` in `successEvaluator.ts`, which is additive and
does not require a schema bump):

| `type` | Evaluated by | Requires knowing the destination in advance? | Tests |
|---|---|---|---|
| `url_pattern` | `page.url()` matched against `config.pattern` (a `**`-wildcard glob, not a full regex) | **Yes** — a URL or URL shape on the destination site | `tests/integration/local-poc.test.ts`, `tests/integration/domainDiscovery.test.ts` |
| `element_present` | `page.locator(config.selector).count() > 0` | **Yes** — a CSS selector (often a `data-testid`/brand-specific attribute) that only exists on that site's markup | `tests/integration/local-poc.test.ts`, `tests/unit/successEvaluator.test.ts` |
| `semantic_page_match` | Generic objective-vocabulary overlap against the live page's title/headings/visible interactive-element text (see below) | **No** — needs only the task's own `objective` (plus this criterion's `description`) | `tests/unit/successEvaluator.test.ts`, `tests/integration/semanticSuccessCriteria.test.ts` |
| `element_text_match`, `data_layer_event`, `network_event`, `custom` | Not evaluated by the core engine (`evaluateSingle`'s `default` case returns `false`) — reserved for a capture module or a future, deliberately-added evaluator case | n/a | n/a |

**Why `url_pattern` and `element_present` alone cannot support a generic task.** Both require
the caller to already know something specific about the destination site — the exact shape of
its configurator URL, or a CSS selector that happens to exist in its markup (often a
`data-testid` a QA team added, which is inherently site-specific and not guaranteed to exist,
let alone be stable, on a different OEM's site). Given only `startUrl`, `journeyType`, and
`objective` — the fields an n8n Form Trigger can realistically supply for an arbitrary
automotive site it has never crawled before — the engine cannot construct either of these
without guessing brand-specific values, which is exactly the failure mode this document exists
to close.

**`semantic_page_match`** (added in request `schemaVersion` `"1.2.0"`) closes that gap. For each
step, it reads the same category of compact, already-rendered page signal the observation
builder exposes to the reasoning layer — the page `<title>`, the text of visible `h1`/`h2`/`h3`
headings, and the accessible names of visible interactive elements (`a`, `button`,
`[role="button"]`, `[role="link"]`) — and scores how much of the vocabulary in the task's
`objective` (concatenated with this criterion's own `description`) shows up in each of those
signal groups, using the same generic, stopword-filtered token-overlap approach
`src/discovery/relevance.ts` already uses to rank preflight domain-discovery candidates
(`objectiveTokenCoverage`, the recall-oriented counterpart of that file's existing
`objectiveRelevanceScore`). The criterion is satisfied once the best-scoring signal group
clears `config.minScore` (default `0.4`; override per criterion, `0`–`1`). `config.signals`
optionally restricts which of `"title"`, `"headings"`, `"interactiveElements"` are scored
(default: all three).

```json
{
  "id": "objective-state-reached",
  "type": "semantic_page_match",
  "description": "Vehicle selection or configuration controls are available on the page.",
  "config": { "minScore": 0.4, "signals": ["title", "headings", "interactiveElements"] },
  "required": true
}
```

Both `config.minScore` and `config.signals` are optional — the minimal form is just `id`,
`type`, and `description` (`description` is required by the schema for every criterion type
regardless, and here it doubles as extra matching vocabulary, so write it as a plain
description of the target state, not a selector or URL).

**What this is, and isn't.** This is literal-vocabulary overlap, not translation or
model-based semantic understanding — there is no call to Claude or any other model inside
`evaluateSuccessCriteria`, consistent with the engine's non-negotiable rule that criteria
evaluation stays deterministic and cheap to run every step. Concretely:

- It contains no brand, market, CTA-label, or hostname vocabulary of any kind — only the
  caller's own `objective`/`description` text and whatever the live page's own title/headings/
  controls say.
- It does not privilege English or any other language: an objective written in French scores
  against a French page exactly the same way an English objective scores against an English
  page (`tests/unit/successEvaluator.test.ts` covers both directions).
- On its own, it **will not** reliably recognise a page written in a different language than
  the objective, because there is no shared vocabulary for it to find (see the "translated page
  content" tests). An optional, opt-in fallback for exactly this case is described below in
  "Generic multilingual `semantic_page_match` verification" — but the deterministic evaluator
  itself never changes: if no verifier is configured (the default), an objective and a page in
  different languages behave exactly as described in this paragraph. If a target site's
  language is known in advance, writing the objective (and this criterion's `description`) in
  that language remains the cheapest, fully deterministic way to get a same-language match —
  this is exactly the same reason `brand`, `market`, and `language` remain optional reporting
  metadata rather than engine inputs (see §10): the engine has no use for them as configuration,
  but a human or an upstream step can still use them to author a better-targeted `objective`
  string per run.
- It does not attempt to detect "blocking" states (cookie walls, session-timeout banners,
  error pages) by pattern-matching against a list of such phrases — any such list would itself
  be exactly the kind of hardcoded, non-generic vocabulary this project's design rule forbids.
  A page carrying both the real target state and unrelated/conflicting content is expected to
  satisfy the criterion on the strength of the matching evidence alone.
- It never changes domain trust. `semantic_page_match` is evaluated only against pages the
  navigation loop has already been allowed onto by the safety layer and preflight domain
  discovery's frozen allowlist (§"Preflight domain discovery" in `docs/architecture.md` and
  `README.md`) — an untrusted domain is still blocked before any criterion, including this one,
  ever runs (`tests/integration/semanticSuccessCriteria.test.ts`).

**How `required` (and `successCriteria` generally) actually gates `stop_success`.**
`required: true`/`false` on a criterion is threaded into the reasoning layer's prompt
(`src/reasoning/promptBuilder.ts`) so Claude (or the mock provider) knows which criteria it
should treat as gating a `stop_success` decision — but that's only ever a *proposal*. The core
loop (`src/core/loop.ts`) is the sole authority: before a `stop_success` decision is honoured,
it independently re-checks `satisfiedCriteriaIds` against every criterion with
`required !== false` (the schema default is `true`, so an omitted `required` is required). If
any required criterion is still missing, `stop_success` is **rejected** — the run is not
terminated, the step is logged with `safetyFlags: ["required_criteria_unsatisfied"]`, and the
navigation loop continues under the same `maxSteps`/`maxBacktracks`/repeated-action ceilings as
any other step, exactly as if the reasoning layer had picked a different action. A task with no
required criteria at all (every entry explicitly `required: false`) is unaffected: there is
nothing to gate on, so `stop_success` is accepted the moment the reasoning layer selects it,
identical to the engine's behaviour before this check existed.

`TaskResponse.engineAssessment.objectiveAchieved` is now independently verified rather than
derived from `status` alone: it is `true` only when `status === "success"` **and** every
required criterion is present in the run's accumulated `satisfiedCriteriaIds` — which, given the
loop-level gate above, is guaranteed for every run that actually reaches `status: "success"`.
When a run ends any other way with required criteria still outstanding,
`TaskResponse.diagnostics.missingRequiredCriteriaIds` lists exactly which required criterion ids
were never satisfied. `satisfiedSuccessCriteriaIds` remains available on the final
step/response for callers who want the full positive evidence list (including satisfied
*optional* criteria), but n8n can now branch directly on `engineAssessment.objectiveAchieved`
for a strict pass/fail signal instead of cross-checking `satisfiedSuccessCriteriaIds` itself —
no change to the n8n Extract/parse node's field paths is required (`status`,
`engineAssessment.objectiveAchieved`, and `satisfiedSuccessCriteriaIds` all keep their existing
shapes and meaning), but a workflow that was working around the old advisory-only behaviour by
re-deriving pass/fail from `satisfiedSuccessCriteriaIds` itself can now simplify to read
`engineAssessment.objectiveAchieved` directly, and may optionally surface
`diagnostics.missingRequiredCriteriaIds` for a failed run's operator-facing message.

## 9a. Generic multilingual `semantic_page_match` verification

**The defect this fixes.** A caller can write `objective`/criterion `description` in one
language while the destination page (reached via automatic domain discovery, following whatever
links the site itself presents) is written in a different language — e.g. an English objective
against a French destination page. Deterministic lexical token overlap (§9 above) has no shared
vocabulary to find in that case and can never satisfy the criterion, no matter how strong the
real-world match is. Before this fix, that meant: `satisfiedCriteriaIds` stayed empty,
`diagnostics.missingRequiredCriteriaIds` listed the criterion, strict required-criteria
enforcement (§9's `required` section) correctly rejected `stop_success` every time the reasoning
layer proposed it, and the run eventually ended `blocked` with `finishReason: "repeated_action"`
once the generic repeated-action safety guard tripped — even though the reasoning layer had
correctly navigated to, and correctly recognised, the right page.
`tests/integration/semanticMultilingualEnforcement.test.ts` reproduces this exact scenario
end-to-end and documents both the pre-fix and post-fix behaviour permanently.

**What was actually implemented, precisely.** `semantic_page_match` stays a two-stage
evaluation:

1. **Deterministic lexical token overlap** (§9, unchanged) always runs first, on every
   evaluation, for every task. It is cheap (no network call, no added latency), fully
   repeatable, and correct whenever the objective and the page share vocabulary — same-language
   tasks (the overwhelming common case) are unaffected by anything below.
2. **Optional semantic verification fallback**
   (`src/reasoning/semanticCriterionVerifier.ts`, `SemanticCriterionVerifier` /
   `ClaudeSemanticCriterionVerifier`) is consulted **only** when step 1's score falls short of
   `minScore`, and **only** when a verifier was actually supplied to `runTask(...)`. It is a
   single, narrowly-scoped, structured-output model call — the same SDK-agnostic
   `ReasoningModelClient` boundary, bounded single-retry policy, and sanitised-error handling
   `ClaudeReasoningProvider` already uses for navigation decisions
   (`src/reasoning/anthropicReasoningModelClient.ts`), but with its own prompt and its own
   decision log: **navigation decisions and success-criterion verification are never the same
   model call.** The prompt sends only `objective`, the criterion's `description`, and the same
   compact page evidence (`title`, `headings`, visible interactive-element text) the
   deterministic evaluator already reads — never raw HTML, never cookies/storage/headers, and
   the model is explicitly instructed to compare *meaning*, not literal words, across whatever
   two languages are involved. This is genuinely cross-language semantic comparison (a real
   model call reasoning about meaning), not lexical matching, not a translation step, and not
   embeddings — see "Why not embeddings or translation" below for the alternatives considered.

   **Wiring (opt-in, zero new required configuration).** `runTask({ ..., semanticVerifier })`
   takes this as an optional parameter; when omitted, behaviour is byte-for-byte identical to
   before this change existed. The HTTP API (`src/api/runner.ts`) wires one in automatically,
   with zero new environment variables or task-JSON fields, exactly when
   `REASONING_PROVIDER=claude` — reusing the *same* `ANTHROPIC_API_KEY`/model/timeout
   configuration already required for navigation decisions. The mock provider (the default, and
   every existing test that doesn't set `REASONING_PROVIDER`) gets no verifier at all.

**Why this design, and not a fixed dictionary, embeddings, or translation.**

- **Not a fixed dictionary** (e.g. `configure = configurer = configurare = konfigurieren`).
  This engine's non-negotiable design rule (`CLAUDE.md`) forbids brand/language/market-specific
  logic in the core, and a finite dictionary can only ever cover the language pairs and
  vocabulary its author thought of — it would still fail the very first untranslated word,
  idiom, or language pair not on the list. Nothing in this fix contains a word list of any kind.
- **Not embeddings.** Embeddings would add a new external dependency (an embedding model/API
  this repository doesn't otherwise use), a new runtime cost axis, and a similarity-threshold
  calibration problem of its own (cosine-similarity thresholds don't transfer cleanly across
  language pairs or embedding models, and validating one would need its own false-positive
  corpus). A structured-output reasoning call reuses infrastructure and credentials this engine
  already depends on (`@anthropic-ai/sdk`, already a direct dependency; no new package was
  added) and gives an auditable, evidence-citing verdict rather than an opaque distance score.
- **Not translation.** Translating the objective (or the page) into a common language first
  would need a translation provider/dictionary of its own, plus its own failure/cost/latency
  handling, and would still ultimately need *something* to judge whether the translated text
  matches — i.e. it doesn't remove the need for a semantic comparison step, it just adds one
  more stage (and one more failure mode) in front of it.
- **Not globally lowering `minScore`.** This would trade a false-negative problem (real matches
  missed across languages) for a false-positive problem (irrelevant same-language pages wrongly
  accepted) — it does not "add" cross-language capability, it just makes the existing lexical
  check sloppier everywhere, including where it was already working correctly.

**Evidence, confidence, and false-positive protections.** The verifier never grants the
criterion from a bare boolean:

- It must return `satisfied: true`.
- **and** `confidence >= 0.7` (`DEFAULT_SEMANTIC_MIN_CONFIDENCE`) — deliberately stricter than
  `ClaudeReasoningProvider`'s navigation-decision `CLAUDE_MIN_CONFIDENCE` (default `0.5`): this
  gate grants a *required* success criterion, so a low-confidence "yes" must never quietly pass.
- **and** a non-empty `evidence` string (min length 1) quoting the specific page signal(s) that
  support the verdict — required for both a satisfied *and* an unsatisfied verdict, so the model
  must always ground its answer in the given text rather than asserting a bare boolean. A
  response missing any of these three, a malformed/unparseable response, or a provider error
  (after the single allowed retry, same hard cap as navigation decisions) is treated as **not
  satisfied** — the verifier fails closed; a criterion is never satisfied by an unsupported or
  failed assertion (`tests/unit/semanticCriterionVerifier.test.ts` covers every one of these
  cases, plus a full engine-loop test proving a persistently-erroring verifier can never
  silently turn a run into `status: "success"`). The system prompt also explicitly instructs the
  model that a single shared generic word (e.g. "vehicle", "continue") is not sufficient
  evidence by itself — see the false-positive tests in
  `tests/integration/semanticMultilingualEnforcement.test.ts` and
  `tests/unit/successEvaluator.test.ts` (unrelated pages, generic-word overlap, conflicting
  partial evidence).

**This never overrides any safety rule.** The verifier is only ever consulted for a page the
navigation loop has already been allowed onto — preflight domain discovery's frozen allowlist,
host-safety validation, redirect controls, `allowFormSubmission`/`allowPaymentOrPurchase`/
`allowPersonalDataEntry`, and `allowedActions` all run exactly as before and entirely
independently of this fallback; a "satisfied" verdict from the verifier can never expand
`allowedDomains` or rescue a run the safety layer has already blocked
(`tests/integration/semanticMultilingualEnforcement.test.ts`, "can never rescue a run blocked by
allowedDomains").

**Cost.** Deterministic evaluation (step 1) is always tried first and is free of any model call;
the verifier is consulted only as a fallback, and only ever once per unique
`(objective, criterion description, page evidence)` combination for the whole run — an in-memory
cache means an unchanged page is never re-verified, so repeated `stop_success` proposals against
the same page cost at most one call total, not one per proposal. In the reproduced regression
scenario, a full run (start page → French destination page → accepted `stop_success`) costs
exactly **two** real model calls: one correctly-negative call for the (irrelevant) start page and
one positive call for the destination page — every later evaluation of either page (including
the accepted `stop_success` step itself) is a cache hit. Aggregated, safe usage/cost metadata
(provider, model, real call count, cache-hit count, satisfied/rejected counts, token totals,
latency, retry count, and optionally a per-call summary with confidence and a short evidence
excerpt) is reported at `TaskResponse.diagnostics.semanticVerifier` whenever a verifier was
configured — never prompts, raw model responses, page content, request bodies, API keys,
headers, or credentials, matching `diagnostics.reasoningProvider`'s existing conventions.

**Known limitation.** Because the fallback triggers whenever the deterministic score falls short
of `minScore` — not only on the "close but wrong-language" case — a run that visits several
pages before reaching the true destination can trigger one verifier call per visited page that
doesn't already clear the lexical threshold, not just one call at the end. Caching bounds this to
one call per *unique* page evidence (never per step), but does not eliminate calls for genuinely
irrelevant intermediate pages. This is an inherent tradeoff of catching a real cross-language
match without being told in advance which page is the destination, not an implementation defect.

## 9b. Repeated-decision and cost control

Independent of language, a reasoning layer can propose `stop_success` again on a page whose
evidence hasn't changed at all since the last rejection — before this fix, that could only ever
be stopped by the generic repeated-action safety guard several steps later (by default, after 4
consecutive identical actions), spending a reasoning-provider call on each intervening attempt
for no new information.

`src/core/loop.ts` now detects this directly: each rejected `stop_success` is fingerprinted by
`(page URL, sorted satisfied required criteria ids, sorted missing required criteria ids)`. The
*first* rejection with a given fingerprint is always allowed to continue the run as before (the
reasoning layer gets one chance to receive updated `satisfiedCriteriaIds` and try something
else). If the *very next* `stop_success` proposal carries the **exact same** fingerprint — i.e.
nothing about the page or the criteria state changed between the two proposals — the run
terminates immediately with `status: "failure"` and
`diagnostics.finishReason: "no_progress_required_criteria_unmet"`, instead of waiting for
`maxSteps` or the repeated-action guard. The terminating step's `safetyFlags` includes
`"no_progress_detected"` alongside `"required_criteria_unsatisfied"`; the run's final
`diagnostics.missingRequiredCriteriaIds` still lists exactly what remained unsatisfied. Any
navigation, or any change to which criteria are satisfied/missing, resets the comparison — two
rejections with genuinely different evidence are never treated as no-progress
(`tests/integration/requiredSuccessCriteriaEnforcement.test.ts`, "changed evidence between two
rejected stop_success proposals is never treated as no-progress").

This bounds the worst case to exactly **two** `stop_success` proposals against unchanging
evidence, regardless of how large `maxSteps`/`maxRepeatedActions` are configured. In the
originally reported production run (five steps: one click, three rejected `stop_success`
proposals, then a repeated-action block), the equivalent scenario now ends after one click and
two rejected proposals — a reduction from 4 reasoning-provider calls after reaching the
destination page down to 2.

## 9c. Terminal-route success model: milestone vs. terminal criteria, and any journey

A journey with an intermediate state worth recording but not itself the goal (entering a
configurator, reaching a lead form) and a true terminal state that must be *reached by the right
route, not just landed on* (a configuration actually completed, not merely started) is expressed
entirely with the `successCriteria` structure that already exists — no new schema field, and the
exact same pattern works for any journey, not only a configurator:

```json
"successCriteria": [
  {
    "id": "configurator-entered",
    "type": "semantic_page_match",
    "description": "The vehicle configurator has been entered: configuration controls (e.g. trim, colour, options) are visible.",
    "required": false
  },
  {
    "id": "configuration-finished",
    "type": "semantic_page_match",
    "description": "The configuration process has been completed: the final completion control (for example a Summary or Continue button, or an equivalent control in the page's own language) was actually clicked, and the resulting page confirms the configuration is finished. Being on a right-looking page by itself is not enough; the completion control must have been the one clicked.",
    "required": true
  }
]
```

- The milestone (`required: false`) is satisfied early and, per PR #20's short-circuit
  (`alreadySatisfiedCriteriaIds`), never re-evaluated once satisfied — it never gates
  `stop_success` on its own, but is still reported in `satisfiedSuccessCriteriaIds` as positive
  evidence of progress.
- The terminal criterion (`required: true`, the schema default) is the only thing that gates
  `stop_success`. Its description asks for two things at once — the right resulting page **and**
  that the completion control specifically was what got clicked — because `SemanticCriterionVerifier`
  is given both the resulting page's evidence *and* `lastActionEvidence` (the accessible
  name/text/element type of the most recently clicked control — see §"SemanticCriterionVerifier"
  in `docs/architecture.md`), and judges the description's meaning against both. This is what
  stops a right-looking page reached some other way (a direct link, an unrelated CTA that happens
  to land nearby) from satisfying the criterion — verified by meaning, never by matching a
  literal word, translation, or brand label anywhere in the engine itself.
- This same two-criterion shape (an optional milestone plus a required, route-aware terminal
  criterion) is exactly how the Test Drive example in the next section expresses "reached the
  booking form" vs. "the booking was actually confirmed" — same mechanism, same fields, no
  per-journey code.

## 9d. Generic action-attributed analytics capture

For every click the engine dispatches, when a task requests `cta_clicks` together with
`data_layer_evidence` and/or `ga4_network_events`, the corresponding `captures.cta_clicks[]`
entry carries an additional `actionAnalytics` object — see `docs/architecture.md` "Generic
action-attributed analytics capture" for the full field-by-field rationale. Example, for a click
that both pushed to `dataLayer` and triggered a GA4 request, and that satisfied a success
criterion:

```json
{
  "stepIndex": 3,
  "timestamp": "2026-09-02T12:00:04.120Z",
  "sourcePageUrl": "https://configurator.example-automotive-oem.com/trim",
  "sourcePageTitle": "Choose Your Trim",
  "ctaText": "Continue",
  "accessibleName": "Continue to summary",
  "elementType": "button",
  "resultingUrl": "https://configurator.example-automotive-oem.com/summary",
  "resultingTitle": "Configuration Summary",
  "navigationSucceeded": true,
  "actionSucceeded": true,
  "actionAnalytics": {
    "dataLayerDelta": {
      "available": true,
      "replaced": true,
      "newEntries": [
        { "event": "page_view", "page": "summary" },
        { "event": "configuration_step", "step": "summary" }
      ]
    },
    "ga4RequestsObservedDuringActionWindow": [
      {
        "stepIndex": 3,
        "requestUrl": "https://configurator.example-automotive-oem.com/g/collect?v=2&en=page_view&dl=...",
        "timestamp": "2026-09-02T12:00:04.310Z",
        "params": { "en": "page_view", "dl": "https://configurator.example-automotive-oem.com/summary" }
      }
    ],
    "advancedJourney": true,
    "newlySatisfiedCriteriaIds": ["configuration-finished"],
    "verifierDecisions": [
      {
        "attempt": 0,
        "outcome": "satisfied",
        "confidence": 0.92,
        "evidence": "\"Configuration Summary\" heading, reached via the Continue control.",
        "inputTokens": 410,
        "outputTokens": 38,
        "latencyMs": 812
      }
    ]
  }
}
```

**The run's final interaction.** There is no separate `finalInteraction` field: the last entry
in `captures.cta_clicks[]` (or, for a run where the last click didn't reach a terminal state, the
last entry with `actionAnalytics.newlySatisfiedCriteriaIds` including a `required: true`
criterion) already *is* the run's final, decisive interaction, with the full
`actionAnalytics` evidence above attached — n8n's Extract/parse node can read
`captures.cta_clicks[captures.cta_clicks.length - 1]` for this rather than a new top-level field,
keeping the response shape additive (no field removed or renamed) and avoiding a second place the
same information could disagree with `captures.cta_clicks[]`.

## 10. taskId, and brand/market/language as reporting metadata only

**taskId.** With only `startUrl`, `journeyType`, and `objective` coming out of the Form
Trigger, n8n should derive `taskId` — never ask the operator to type one, and never derive it
from a brand or market the workflow hasn't been told. The recommended shape is a safe,
URL-derived hostname slug, plus `journeyType`, plus a timestamp, joined with `-`:

```
<hostname-slug>-<journeyType>-<ISO-8601 basic timestamp, UTC>
```

e.g. for `startUrl: "https://www.citroen.fr/collection.html"` and
`journeyType: "configurator_entry"`, submitted at `2026-08-25T12:00:00Z`:

```
www-citroen-fr-configurator_entry-20260825T120000Z
```

In an n8n Function/Code node:

```js
const host = new URL($json.startUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const journeyType = ($json.journeyType || "journey").replace(/[^a-zA-Z0-9_-]+/g, "-");
const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const taskId = `${host}-${journeyType}-${timestamp}`;
```

This needs no brand/market lookup, is unique per run (timestamp) without needing a database,
and stays within the schema's `taskId` bounds (`minLength: 1`, `maxLength: 200`).

**brand, market, language.** These are legitimate things to *report* about a run, but the
engine has no field for them as an input and must not be asked to derive navigation behaviour
from them (CLAUDE.md's non-negotiable design rule: no automotive/brand/market-specific
branching in `src/core`). n8n should never guess or prompt for them *before* a run — instead:

- If n8n already knows a value from its own context (e.g. a Sheets row that triggered this run
  also has a `brand`/`market` column), it may pass it through `metadata` — the schema's
  free-form, non-authoritative bag (`schemas/task-request.schema.json`
  `properties.metadata`) — for downstream reporting only. The engine never reads `metadata` to
  change behaviour.
- Otherwise, derive brand/market/language **after** the run, from evidence the run already
  collected — the landed hostname/registrable domain (`diagnostics.domainDiscovery
  .startRegistrableDomain`/`finalUrl`), the page's own `lang` attribute or `dataLayer` payload
  (`captures.page_metadata[].lang`, `captures.data_layer_evidence`, if those capture modules
  were requested), or the response's `captures`/`diagnostics` generally — and attach them in
  n8n's own post-processing step (Sheets/BigQuery row enrichment), not in the task request.

## 11. The n8n "Build Navigation Engine Task" node

The workflow this repo is built for has an n8n Form Trigger supplying exactly three fields —
`startUrl`, `journeyType`, `objective` — and a Build node that turns those into a full
`task-request.schema.json` body. A Build node that still falls back to hardcoded brand/market/
language/URL-pattern/hostname values for any field defeats the point of preflight domain
discovery and `semantic_page_match`: it means the workflow silently only works for the one
site those fallbacks were written against. Concretely, the Build node should:

1. **Never fall back to a brand-, market-, or site-specific literal** for `allowedDomains`, any
   `successCriteria[].config.pattern`/`config.selector`, or any other field — if a value isn't
   one of the three form fields, either omit it (letting the engine's own preflight discovery
   or a schema default fill it in) or derive it generically, as below.
2. **Leave `allowedDomains` unset.** Preflight domain discovery (`src/discovery`) determines
   the initial trusted set from `startUrl` itself; the frozen allowlist behaviour is
   unaffected by anything in this change (§ "Preflight domain discovery" in `docs/
   architecture.md`/`README.md`).
3. **Build `successCriteria` as a single generic `semantic_page_match` criterion** whose
   `description` restates the objective's target-state clause (or simply repeats `objective`
   verbatim — matching against `objective` twice is harmless, just redundant), with no
   `config` unless the operator has a specific reason to tune `minScore`/`signals`:
   ```js
   successCriteria: [{
     id: "objective-state-reached",
     type: "semantic_page_match",
     description: $json.objective,
     required: true,
   }]
   ```
   This is the same recipe for every `journeyType` — `configurator_entry`, `model_discovery`,
   `dealer_locator`, `test_drive`, `offers`, or any other free-text hint — because the
   objective text the operator wrote already carries whatever is journey-specific; the engine
   and this Build node stay generic. (An operator who does know a stable, site-specific
   selector or URL shape for a particular recurring target may still add `url_pattern`/
   `element_present` criteria alongside this one — both remain fully supported, unchanged,
   and can be combined with `semantic_page_match` in the same `successCriteria` array.)
4. **Derive `taskId` per §10** — hostname + `journeyType` + timestamp, no brand/market lookup.
5. **Leave `brand`/`market`/`language` out of the request entirely**, or pass them through
   `metadata` only when the workflow already has them from its own trigger context — never
   look them up or guess them before the run (§10).
6. **Send `schemaVersion: "1.3.0"` and `outputSchemaVersion: "1.3.0"`** (§7) — a Build node
   still pinned to `"1.2.0"` will have every request rejected at `POST /v1/tasks` with a `400`.

The minimal generic request this node should now produce (see
`examples/minimal-preflight-discovery-task.json` for the full, schema-valid worked example,
and `docs/architecture.md`/`README.md` "Preflight domain discovery" for what happens to
`allowedDomains` once the engine receives it):

```json
{
  "schemaVersion": "1.3.0",
  "taskId": "www-citroen-fr-configurator_entry-20260825T120000Z",
  "objective": "Navigate to the official consumer vehicle configurator and stop when vehicle selection or configuration controls are available.",
  "startUrl": "https://www.citroen.fr/collection.html",
  "journeyType": "configurator_entry",
  "successCriteria": [
    {
      "id": "objective-state-reached",
      "type": "semantic_page_match",
      "description": "Navigate to the official consumer vehicle configurator and stop when vehicle selection or configuration controls are available.",
      "required": true
    }
  ],
  "captureModules": ["page_visits", "journey_path", "screenshots", "errors"],
  "limits": { "maxSteps": 60, "maxBacktracks": 5, "maxDurationSeconds": 900, "maxRepeatedActions": 3 },
  "safety": {
    "allowedActions": ["click", "scroll", "wait", "go_back", "navigate", "capture", "stop_success", "stop_blocked", "stop_failure"],
    "allowFormSubmission": false,
    "allowPaymentOrPurchase": false,
    "allowPersonalDataEntry": false,
    "requireDomainConfirmationOnRedirect": true
  },
  "outputSchemaVersion": "1.3.0"
}
```

No `brand`, `market`, `language`, `allowedDomains`, destination hostname, CSS selector, or
success URL pattern appears anywhere in this request — every field is either one of the three
form fields, a fixed operational default (`limits`/`safety`/`captureModules`, the same for
every run regardless of target site), or derived generically (`taskId`, `successCriteria`).

### Four worked examples, across journey types, using the terminal-route success model (§9c)

Each of the four Form Trigger submissions below (form fields, then the exact `POST /v1/tasks`
body the Build node should produce) uses the **same** two-criterion pattern from §9c — an
optional milestone plus a required, route-verified terminal criterion — and the **same**
`captureModules`/`limits`/`safety` shape, proving the Build node needs no per-journey branching.
`captureModules` adds `cta_clicks`, `data_layer_evidence`, and `ga4_network_events` so the
generic action-attributed analytics capture (§9d) is populated.

**1. Configurator (`journeyType: "configurator_entry"`)** — form fields:
`startUrl = https://www.example-automotive-oem.com/`,
`journeyType = configurator_entry`,
`objective = Find and enter the vehicle configurator, proceed through the configuration steps, click the final completion control (a Summary, Continue, or equivalent control -- whatever label the site itself uses), and stop once the resulting page confirms the configuration is finished.`

```json
{
  "schemaVersion": "1.3.0",
  "taskId": "www-example-automotive-oem-com-configurator_entry-20260902T120000Z",
  "objective": "Find and enter the vehicle configurator, proceed through the configuration steps, click the final completion control (a Summary, Continue, or equivalent control -- whatever label the site itself uses), and stop once the resulting page confirms the configuration is finished.",
  "startUrl": "https://www.example-automotive-oem.com/",
  "journeyType": "configurator_entry",
  "successCriteria": [
    {
      "id": "configurator-entered",
      "type": "semantic_page_match",
      "description": "The vehicle configurator has been entered: configuration controls (e.g. trim, colour, options) are visible.",
      "required": false
    },
    {
      "id": "configuration-finished",
      "type": "semantic_page_match",
      "description": "The configuration process has been completed: the final completion control (for example a Summary or Continue button, or an equivalent control in the page's own language) was actually clicked, and the resulting page confirms the configuration is finished. Being on a right-looking page by itself is not enough; the completion control must have been the one clicked.",
      "required": true
    }
  ],
  "captureModules": ["page_visits", "cta_clicks", "journey_path", "data_layer_evidence", "ga4_network_events", "screenshots", "errors"],
  "limits": { "maxSteps": 60, "maxBacktracks": 5, "maxDurationSeconds": 900, "maxRepeatedActions": 3 },
  "safety": {
    "allowedActions": ["click", "scroll", "wait", "go_back", "navigate", "capture", "stop_success", "stop_blocked", "stop_failure"],
    "allowFormSubmission": false,
    "allowPaymentOrPurchase": false,
    "allowPersonalDataEntry": false,
    "requireDomainConfirmationOnRedirect": true
  },
  "outputSchemaVersion": "1.3.0"
}
```

**2. Test drive booking (`journeyType: "test_drive"`)** — form fields:
`startUrl = https://www.example-automotive-oem.com/`,
`journeyType = test_drive`,
`objective = Reach the test drive booking form and stop as soon as it is displayed. Do not enter any personal information -- only reaching the form matters.`

This is the second, non-configurator journey proving the same mechanism generalises: no fill/
type action exists anywhere in the engine's action vocabulary (`src/types/actions.ts`), so this
run can never enter personal data regardless of what any reasoning provider proposes
(`tests/integration/noPersonalDataEntry.test.ts`).

```json
{
  "schemaVersion": "1.3.0",
  "taskId": "www-example-automotive-oem-com-test_drive-20260902T120000Z",
  "objective": "Reach the test drive booking form and stop as soon as it is displayed. Do not enter any personal information -- only reaching the form matters.",
  "startUrl": "https://www.example-automotive-oem.com/",
  "journeyType": "test_drive",
  "successCriteria": [
    {
      "id": "test-drive-section-entered",
      "type": "semantic_page_match",
      "description": "A test drive / book a test drive section has been reached.",
      "required": false
    },
    {
      "id": "booking-form-displayed",
      "type": "semantic_page_match",
      "description": "A form to book a test drive (fields for contact details) is visible on the page.",
      "required": true
    }
  ],
  "captureModules": ["page_visits", "cta_clicks", "journey_path", "data_layer_evidence", "ga4_network_events", "screenshots", "errors"],
  "limits": { "maxSteps": 60, "maxBacktracks": 5, "maxDurationSeconds": 900, "maxRepeatedActions": 3 },
  "safety": {
    "allowedActions": ["click", "scroll", "wait", "go_back", "navigate", "capture", "stop_success", "stop_blocked", "stop_failure"],
    "allowFormSubmission": false,
    "allowPaymentOrPurchase": false,
    "allowPersonalDataEntry": false,
    "requireDomainConfirmationOnRedirect": true
  },
  "outputSchemaVersion": "1.3.0"
}
```

**3. Dealer locator (`journeyType: "dealer_locator"`)** — form fields:
`startUrl = https://www.example-automotive-oem.com/`,
`journeyType = dealer_locator`,
`objective = Find the dealer locator and stop once a list or map of nearby dealers is displayed.`

```json
{
  "schemaVersion": "1.3.0",
  "taskId": "www-example-automotive-oem-com-dealer_locator-20260902T120000Z",
  "objective": "Find the dealer locator and stop once a list or map of nearby dealers is displayed.",
  "startUrl": "https://www.example-automotive-oem.com/",
  "journeyType": "dealer_locator",
  "successCriteria": [
    {
      "id": "dealer-locator-entered",
      "type": "semantic_page_match",
      "description": "A dealer locator / find a dealer page has been reached.",
      "required": false
    },
    {
      "id": "dealer-results-shown",
      "type": "semantic_page_match",
      "description": "A list or map of nearby dealers is displayed on the page.",
      "required": true
    }
  ],
  "captureModules": ["page_visits", "cta_clicks", "journey_path", "data_layer_evidence", "ga4_network_events", "screenshots", "errors"],
  "limits": { "maxSteps": 60, "maxBacktracks": 5, "maxDurationSeconds": 900, "maxRepeatedActions": 3 },
  "safety": {
    "allowedActions": ["click", "scroll", "wait", "go_back", "navigate", "capture", "stop_success", "stop_blocked", "stop_failure"],
    "allowFormSubmission": false,
    "allowPaymentOrPurchase": false,
    "allowPersonalDataEntry": false,
    "requireDomainConfirmationOnRedirect": true
  },
  "outputSchemaVersion": "1.3.0"
}
```

**4. Brochure / offers (`journeyType: "offers"`)** — form fields:
`startUrl = https://www.example-automotive-oem.com/`,
`journeyType = offers`,
`objective = Find the current offers and incentives page and stop once vehicle offers or a downloadable brochure link are shown.`

```json
{
  "schemaVersion": "1.3.0",
  "taskId": "www-example-automotive-oem-com-offers-20260902T120000Z",
  "objective": "Find the current offers and incentives page and stop once vehicle offers or a downloadable brochure link are shown.",
  "startUrl": "https://www.example-automotive-oem.com/",
  "journeyType": "offers",
  "successCriteria": [
    {
      "id": "offers-section-entered",
      "type": "semantic_page_match",
      "description": "An offers / incentives section has been reached.",
      "required": false
    },
    {
      "id": "offers-or-brochure-shown",
      "type": "semantic_page_match",
      "description": "Vehicle offers are listed, or a downloadable brochure link is shown, on the page.",
      "required": true
    }
  ],
  "captureModules": ["page_visits", "cta_clicks", "journey_path", "data_layer_evidence", "ga4_network_events", "screenshots", "errors"],
  "limits": { "maxSteps": 60, "maxBacktracks": 5, "maxDurationSeconds": 900, "maxRepeatedActions": 3 },
  "safety": {
    "allowedActions": ["click", "scroll", "wait", "go_back", "navigate", "capture", "stop_success", "stop_blocked", "stop_failure"],
    "allowFormSubmission": false,
    "allowPaymentOrPurchase": false,
    "allowPersonalDataEntry": false,
    "requireDomainConfirmationOnRedirect": true
  },
  "outputSchemaVersion": "1.3.0"
}
```
