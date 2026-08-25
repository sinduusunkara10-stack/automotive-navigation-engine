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
- It **will not** reliably recognise a page written in a different language than the
  objective, because there is no shared vocabulary for it to find (see the "translated page
  content" tests). If a target site's language is known in advance, write the objective (and
  this criterion's `description`) in that language — this is exactly the same reason `brand`,
  `market`, and `language` remain optional reporting metadata rather than engine inputs (see
  §10): the engine has no use for them as configuration, but a human or an upstream step can
  still use them to author a better-targeted `objective` string per run.
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
6. **Send `schemaVersion: "1.2.0"` and `outputSchemaVersion: "1.2.0"`** (§7) — required for
   `semantic_page_match` to validate; a Build node still pinned to `"1.1.0"` will have every
   request using the new criterion type rejected at `POST /v1/tasks` with a `400`.

The minimal generic request this node should now produce (see
`examples/minimal-preflight-discovery-task.json` for the full, schema-valid worked example,
and `docs/architecture.md`/`README.md` "Preflight domain discovery" for what happens to
`allowedDomains` once the engine receives it):

```json
{
  "schemaVersion": "1.2.0",
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
  "outputSchemaVersion": "1.2.0"
}
```

No `brand`, `market`, `language`, `allowedDomains`, destination hostname, CSS selector, or
success URL pattern appears anywhere in this request — every field is either one of the three
form fields, a fixed operational default (`limits`/`safety`/`captureModules`, the same for
every run regardless of target site), or derived generically (`taskId`, `successCriteria`).
