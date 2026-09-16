# LangSmith Phase 1 Instrumentation — Data Inventory

**Status:** Read-only inventory. No code was changed to produce this document, no PR was
opened, and nothing about the engine's runtime behavior was modified. This document only
records what data already exists in the codebase today, where it lives, and where it would
have to be tapped from if LangSmith tracing is added later.

**Note on scope:** no pre-existing `docs/observability/langsmith-phase1-inventory.md` (or any
file with placeholder/TBD rows for this exercise) was found anywhere in the repository or its
git history at the time of this inventory (verified via a full-tree file listing and a
history search for `observability`/`langsmith`). This document was therefore built from
scratch, using the standard set of fields a "Phase 1" LangSmith LLM-run trace needs (run
identity/correlation, timing, model/provider metadata, prompt input, model output, token
usage, outcome/error/retry data, and session-level correlation), and evaluating each one
against what this codebase actually produces today. No field below was invented to fit
LangSmith's schema; every field is one this engine already has a reason to track for its own
diagnostics, or a gap in an area LangSmith Phase 1 would need.

**Methodology:** every source file under `src/` that participates in a reasoning-provider
(Claude) call, the semantic-verifier (Claude) call, the core navigate/observe/decide/act
loop, or the HTTP API run lifecycle was read in full: `src/reasoning/*`, `src/core/engine.ts`,
`src/core/loop.ts`, `src/core/state.ts`, `src/api/server.ts`, `src/api/runner.ts`,
`src/api/auth.ts`, `src/api/taskStore.ts`, `src/types/task-request.ts`,
`src/types/task-response.ts`, `src/types/actions.ts`, `.env.example`, and
`docs/architecture.md` (particularly §6 "Reasoning layer" and §13 "Memory stability and run
persistence", which already document most of this ground truth in prose). No field's status
below is guessed; every YES/PARTIAL/NO cites the exact line(s) that produce or fail to
produce the value.

---

## 1. Summary table

| # | Field | Status | Primary file | Primary function/class |
|---|---|---|---|---|
| A1 | Per-LLM-call unique ID | NO | — | — |
| A2 | Run-level unique ID (`runId`) | YES | `src/api/server.ts` | `handleCreateTask` |
| A3 | Caller-supplied task identifier (`taskId`) | YES | `src/types/task-request.ts` | `TaskRequest` |
| A4 | `runId` correlation into LLM decision data | NO | — | — |
| A5 | `taskId` correlation into LLM decision data | PARTIAL | `src/core/engine.ts` | `buildTerminalResponse` |
| A6 | Parent/child run relationship (task run → per-step LLM calls) | PARTIAL | `src/reasoning/claudeReasoningProvider.ts` | `ClaudeReasoningProvider` |
| A7 | Step index per decision | YES | `src/reasoning/claudeReasoningProvider.ts` | `decide` |
| B1 | Run start timestamp | YES | `src/api/taskStore.ts`, `src/core/state.ts` | `RunRecord.createdAt`, `RunState` |
| B2 | Run end timestamp / duration | YES | `src/core/engine.ts` | `buildTerminalResponse` |
| B3 | Per-decision timestamp | PARTIAL | `src/reasoning/claudeReasoningProvider.ts` | `log` |
| B4 | Per-decision latency (ms) | YES | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce` |
| B5 | Aggregate total LLM latency per run | YES | `src/reasoning/claudeReasoningProvider.ts` | `getUsageDiagnostics` |
| C1 | Model name | YES | `src/reasoning/config.ts` | `readClaudeReasoningConfig` |
| C2 | Provider name | YES | `src/reasoning/claudeReasoningProvider.ts` | `getUsageDiagnostics` |
| C3 | Model invocation params (max tokens, timeout, effort) | PARTIAL | `src/reasoning/config.ts`, `anthropicReasoningModelClient.ts` | `readClaudeReasoningConfig` |
| C4 | SDK/library version | NO | — | — |
| D1 | System prompt text | NO (by design) | `src/reasoning/promptBuilder.ts` | `buildReasoningPrompt` |
| D2 | User prompt / observation payload | NO (by design) | `src/reasoning/promptBuilder.ts` | `buildReasoningPrompt` |
| D3 | Prompt-element-selection diagnostic (proxy for prompt content) | YES | `src/reasoning/promptBuilder.ts` | `selectPromptInteractiveElements` |
| E1 | Raw model output (full parsed JSON) | NO (by design) | `src/reasoning/anthropicReasoningModelClient.ts` | `createAnthropicReasoningModelClient` |
| E2 | Selected action / decision rationale | YES | `src/core/loop.ts` | `buildStepLog` |
| E3 | Confidence score | YES | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce` |
| E4 | Consent classification (`consentControlIntent`) | YES | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce` |
| E5 | Consent policy compliance flag | YES | `src/safety/consentPolicyGuard.ts` | `isConsentIntentCompliant` |
| E6 | SDK `stop_reason` (e.g. `"refusal"`) | PARTIAL | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce` |
| F1 | Input tokens per call | YES | `src/reasoning/anthropicReasoningModelClient.ts` | `createAnthropicReasoningModelClient` |
| F2 | Output tokens per call | YES | `src/reasoning/anthropicReasoningModelClient.ts` | `createAnthropicReasoningModelClient` |
| F3 | Aggregate token totals per run | YES | `src/reasoning/claudeReasoningProvider.ts` | `getUsageDiagnostics` |
| F4 | Monetary cost | NO (deliberate) | `docs/architecture.md` §6 | — |
| G1 | Decision outcome (`accepted`/`rejected`/`error`/`fallback`) | YES | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce` |
| G2 | Error/rejection reason code | PARTIAL | `src/reasoning/claudeReasoningProvider.ts` | `attemptOnce`, `toDecisionSummary` |
| G3 | Retry count (aggregate) | YES | `src/reasoning/claudeReasoningProvider.ts` | `getUsageDiagnostics` |
| G4 | Corrective-retry flag per attempt | PARTIAL | `src/reasoning/claudeReasoningProvider.ts` | `ClaudeDecisionLogEntry` |
| G5 | Sanitized SDK error category | PARTIAL | `src/reasoning/anthropicReasoningModelClient.ts` | `sanitizeError` |
| G6 | Semantic-verifier decision outcome (second LLM call type) | YES | `src/reasoning/semanticCriterionVerifier.ts` | `getUsageDiagnostics` |
| H1 | Engine version | YES | `src/core/engine.ts` | `buildTerminalResponse` |
| H2 | Deployed commit SHA | YES (health endpoint only) | `src/api/server.ts` | `handleHealth` |
| H3 | API caller identity | NO | `src/api/auth.ts` | `isAuthorized` |
| H4 | Environment/deployment tag (prod/staging) | NO | — | — |
| H5 | Worker/process identity | YES (TaskStore only) | `src/api/workerIdentity.ts`, `src/api/taskStore.ts` | `RunRecord.workerId` |
| I1 | `onDecisionLogged` passive-capture hook | PARTIAL (exists, unwired) | `src/reasoning/claudeReasoningProvider.ts` | `ClaudeReasoningProviderOptions` |

Sections 2–10 below give full evidence, flow, and recommendation detail for every row.
Section 11 lists the security/compliance/retention decisions this inventory surfaced.

---

## 2. Run/trace identity & correlation

### A1 — Per-LLM-call unique ID — **NO**

- **What was checked:** `ClaudeDecisionLogEntry` (`src/reasoning/claudeReasoningProvider.ts:25-65`)
  and `ReasoningProviderDecisionSummary` (`src/types/task-response.ts:536-558`) — the two
  structures that record one entry per model call.
- **Evidence:** Neither type has an `id`/`uuid` field. A decision is identified only by the
  tuple `(stepIndex, attempt)` within one run's `decisionLog` array
  (`claudeReasoningProvider.ts:177`, `189-191`). There is no call to `randomUUID()` (or
  equivalent) anywhere in `src/reasoning/`.
- **Recommended capture location:** `ClaudeReasoningProvider.log()`
  (`src/reasoning/claudeReasoningProvider.ts:402-411`) is the single choke point every
  decision (accepted, rejected, error, fallback) already passes through before being pushed
  onto `decisionLog`. Generating an id there (e.g. `randomUUID()`) is the smallest, most
  passive change: it touches one function, adds one field, and every existing caller of
  `getDecisionLog()`/`getUsageDiagnostics()` is unaffected by an additive field.
- **Why that location:** it is the only place in the codebase where every outcome variant
  (including the `fallback()` path at line 394-400, which calls `log()` directly) already
  converges before serialization; adding an id anywhere else (e.g. in `attemptOnce`) would
  miss the `fallback` case.

### A2 — Run-level unique ID (`runId`) — **YES**

- **File:** `src/api/server.ts`
- **Function:** `handleCreateTask`
- **Field name:** `runId` (local variable), persisted as `RunRecord.runId`
  (`src/api/taskStore.ts:15`)
- **Example object path:** `GET /v1/tasks/:runId` response → `runId`; Redis key
  `nav-engine:run:<runId>` (`src/api/redisTaskStore.ts`, per `docs/architecture.md` §13)
- **Evidence:** `const runId = \`run_${randomUUID()}\`;` (`src/api/server.ts:139`), passed to
  `store.createRun(runId, task.taskId)` (line 140) and to `executeTaskAsync(runId, task,
  store, ...)` (line 142).
- **Flow:** generated once per `POST /v1/tasks` call, used as the `TaskStore` record key for
  the lifetime of the run (`RunRecord.runId`, heartbeats, `GET /v1/tasks/:runId` lookups —
  `src/api/taskStore.ts:14-32`), and returned to the caller in the `202 Accepted` body
  (`{taskId, runId, status: "accepted"}`, `server.ts:146`). **It never travels past the API
  boundary into `runTask()`, the reasoning layer, or `TaskResponse` itself** — see A4 below.

### A3 — Caller-supplied task identifier (`taskId`) — **YES**

- **File:** `src/types/task-request.ts`
- **Function/type:** `TaskRequest.taskId` (line 77)
- **Object path:** `TaskResponse.taskId` (`src/types/task-response.ts:866`, echoed verbatim
  in `src/core/engine.ts:431`)
- **Evidence:** required string field on the request schema; the engine copies it unchanged
  into every terminal response, including early-exit blocked/failure paths
  (`buildTerminalResponse`, `engine.ts:429-453`).
- **Flow:** caller supplies it in the request body → validated by
  `src/api/validation.ts` → stored as `RunRecord.taskId` → echoed into every `TaskResponse`.
  **Caveat relevant to correlation (see A5 and §11):** nothing in the schema or the engine
  enforces `taskId` uniqueness across runs — a caller may reuse the same `taskId` for
  multiple executions (e.g. a recurring n8n job), so `taskId` alone cannot be trusted as a
  1:1 run key the way `runId` can.

### A4 — `runId` correlation into LLM decision data — **NO**

- **What was checked:** `runTask()`'s parameter list (`src/core/engine.ts:82-113`),
  `executeTaskAsync()`'s call into it (`src/api/runner.ts:146-154`), `ReasoningContext`
  (`src/reasoning/reasoningProvider.ts:40-77`), and every field on
  `ReasoningProviderDiagnostics`/`ReasoningProviderDecisionSummary`
  (`src/types/task-response.ts:568-588`, `536-558`).
- **Evidence:** `executeTaskAsync(runId, task, store, ...)` has `runId` in scope
  (`src/api/runner.ts:82-90`) but its call to `runTask({ page, task, reasoning, ... })`
  (lines 146-154) never passes `runId` through. `runTask()`'s own parameter object has no
  `runId` field. `ReasoningContext` and every reasoning-layer type were grepped for `runId`
  and found in none of them (confirmed: `grep -rn "runId" src/` only matches files under
  `src/api/`).
- **Recommended capture location:** do **not** thread `runId` into `src/core` or
  `src/reasoning` — per `CLAUDE.md`'s non-negotiable design rule, the core loop and reasoning
  layer must stay free of concerns that exist only to serve one caller/integration (here,
  observability plumbing). The correct point is `src/api/runner.ts`'s `executeTaskAsync`
  (`src/api/runner.ts:82`), which already has `runId` and `task` in scope and is the one
  place that wraps a whole `runTask()` execution — a LangSmith parent/root run should be
  opened there (tagged with `runId` and `task.taskId`) and closed when `executeTaskAsync`
  resolves, wrapping the existing `runTask()` call without modifying it.
- **Why that location:** it is the outermost boundary that already owns the run's full
  lifecycle (heartbeat interval, memory sampling, browser launch/cleanup — see
  `runner.ts:82-183`) and is explicitly an API/application concern already
  (`docs/architecture.md` §6: "This is wired in at the API boundary
  (`src/api/runner.ts`), not in `src/core/loop.ts`").

### A5 — `taskId` correlation into LLM decision data — **PARTIAL**

- **Existing data:** `TaskResponse.taskId` and `TaskResponse.diagnostics.reasoningProvider`
  are sibling fields on the same `TaskResponse` object
  (`src/types/task-response.ts:864-875`), so a consumer holding the whole JSON blob can
  trivially associate the two.
- **Missing data:** `taskId` is not itself copied onto
  `ReasoningProviderDiagnostics`/`ReasoningProviderDecisionSummary`
  (`src/types/task-response.ts:568-588`, `536-558`) or onto `ClaudeDecisionLogEntry`
  (`claudeReasoningProvider.ts:25-65`). If per-decision records are ever exported
  individually (e.g. one LangSmith run per model call, sent as it happens rather than
  batched at the end), there is currently no field on that record to join it back to its
  task without also carrying the whole `TaskResponse`.
- **Required enhancement:** either (a) pass `task.taskId` into
  `ClaudeReasoningProvider`'s constructor/`decide()` call and stamp it onto each
  `ClaudeDecisionLogEntry`, or (b) — preferred, consistent with A4's core/plugin boundary
  reasoning — attach it only at the `src/api/runner.ts` boundary when emitting each decision
  to LangSmith, leaving the internal decision log untouched.

### A6 — Parent/child run relationship (task run → per-step LLM calls) — **PARTIAL**

- **Existing data:** every decision belongs to exactly one `ClaudeReasoningProvider`
  instance, and `src/core/engine.ts:124` resolves exactly one `ReasoningProvider` per
  `runTask()` call specifically so `getUsageDiagnostics()` aggregates "reflect the whole run"
  (`docs/architecture.md` §6, confirmed at `engine.ts:121-124`). So the parent/child
  relationship exists *structurally* (one provider instance = one run = many decisions).
- **Missing data:** there is no explicit `parentRunId`/`traceId` field anywhere connecting a
  `ClaudeDecisionLogEntry` back to the run that produced it — the relationship is implicit in
  object lifetime, not a serializable field. This matters once decisions are emitted as
  LangSmith runs, which need an explicit `parent_run_id`/`trace_id` per event rather than
  relying on which object emitted them.
- **Required enhancement:** same fix as A4/A5 — stamp a run identifier at the
  `src/api/runner.ts` boundary (or via `onDecisionLogged`, see I1) when translating each
  `ClaudeDecisionLogEntry` into a LangSmith run.

### A7 — Step index per decision — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `decide` (line 194: `const stepIndex = context.limits.stepsUsed;`)
- **Field name:** `ClaudeDecisionLogEntry.stepIndex` → `ReasoningProviderDecisionSummary.stepIndex`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].stepIndex`
- **Evidence:** `stepIndex` is computed once per `decide()` call from `context.limits.stepsUsed`
  and threaded through `attemptOnce`/`log`/`toDecisionSummary`
  (`claudeReasoningProvider.ts:149-162`).
- **Flow:** `src/core/loop.ts`'s `runStep` sets `const stepIndex = state.stepCount;` (line 88)
  and passes it via `ReasoningContext.limits.stepsUsed`; every decision this step logs
  inherits that same index, including the retry/corrective-retry attempts within the step —
  correlating a specific `StepLog` entry (`src/types/task-response.ts:217-241`, which also
  carries its own `stepIndex`) to the LLM decisions that produced it.

---

## 3. Timing & latency

### B1 — Run start timestamp — **YES**

- **File:** `src/api/taskStore.ts` (`RunRecord.createdAt`, line 18); `src/core/state.ts`
  (`RunState.startedAtMs`, referenced at `src/core/engine.ts:442`)
- **Function:** `TaskStore.createRun` (interface, implemented in
  `src/api/inMemoryTaskStore.ts`/`redisTaskStore.ts`)
- **Example object path:** `RunRecord.createdAt` (ISO string, not part of `TaskResponse`
  itself — it lives in the store record returned by `GET /v1/tasks/:runId`'s wrapper, not
  inside `result`)
- **Evidence:** `RunRecord` interface requires `createdAt: string`
  (`src/api/taskStore.ts:18`); `RunState` (referenced, not shown above) is constructed at the
  top of `runTask()` (`engine.ts:115`) and `state.startedAtMs` is read at
  `engine.ts:442` to compute `totalDurationMs`.

### B2 — Run end timestamp / duration — **YES**

- **File:** `src/core/engine.ts`
- **Function:** `buildTerminalResponse`
- **Field name:** `Diagnostics.totalDurationMs`
- **Example object path:** `TaskResponse.diagnostics.totalDurationMs`
- **Evidence:** `totalDurationMs: Date.now() - state.startedAtMs` (`engine.ts:442`). There is
  no absolute end-timestamp field on `TaskResponse` itself (only the derived duration), but
  `RunRecord.updatedAt` (`src/api/taskStore.ts:19`) is refreshed by `completeRun`
  (`src/api/runner.ts:175`), giving an absolute end time at the store layer.

### B3 — Per-decision timestamp — **PARTIAL**

- **Existing data:** `ClaudeDecisionLogEntry.timestamp` is set on every log call —
  `timestamp: new Date().toISOString()` (`src/reasoning/claudeReasoningProvider.ts:404`,
  inside `log()`).
- **Missing data:** `toDecisionSummary()` (`claudeReasoningProvider.ts:149-162`), the function
  that converts an internal `ClaudeDecisionLogEntry` into the externally-visible
  `ReasoningProviderDecisionSummary`, does not copy `timestamp` across. Cross-checked against
  the type definition (`src/types/task-response.ts:536-558`): `ReasoningProviderDecisionSummary`
  has no `timestamp` field at all. So every decision has an absolute wall-clock time
  internally, but it never reaches `TaskResponse.diagnostics.reasoningProvider.decisions[]`.
- **Required enhancement:** add `timestamp` to `ReasoningProviderDecisionSummary`
  (`src/types/task-response.ts:536`) and to `toDecisionSummary()`'s return object
  (`claudeReasoningProvider.ts:149-162`); this is additive only and would need
  `REASONING_PROVIDER_DIAGNOSTICS_VERSION` bumped per the existing versioning convention
  (`src/reasoning/reasoningProvider.ts:18`, and the precedent set each time a field was added
  to this structure — see the version-history comment there).

### B4 — Per-decision latency (ms) — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `attemptOnce`
- **Field name:** `latencyMs`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].latencyMs`
- **Evidence:** `const startedAt = Date.now();` at the top of `attemptOnce`
  (line 281), `const latencyMs = Date.now() - startedAt;` immediately after the model call
  resolves or throws (lines 291, 349) — measured around exactly
  `this.modelClient.createDecision(...)`, i.e. the real Anthropic SDK round trip, excluding
  prompt-build time (which happens earlier, in `decide()`, and is not separately measured).

### B5 — Aggregate total LLM latency per run — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `getUsageDiagnostics`
- **Field name:** `totalLatencyMs`
- **Example object path:** `diagnostics.reasoningProvider.totalLatencyMs`
- **Evidence:** `totalLatencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0)`
  (line 387) — sums every logged attempt's `latencyMs`, including retries and the
  zero-cost `fallback()` entry (which logs `latencyMs: 0`, line 395).

---

## 4. Model & provider metadata

### C1 — Model name — **YES**

- **File:** `src/reasoning/config.ts`
- **Function:** `readClaudeReasoningConfig`
- **Field name:** `ClaudeReasoningConfig.model` → `ReasoningProviderDiagnostics.model`
- **Example object path:** `diagnostics.reasoningProvider.model`
- **Evidence:** `model: env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL` (`config.ts:57`,
  default `"claude-sonnet-5"` at line 17); surfaced via
  `model: this.config.model` in `getUsageDiagnostics()` (`claudeReasoningProvider.ts:379`).
  Constant for the whole run (the model cannot change mid-run), so it is correctly reported
  once at the run level rather than per decision.

### C2 — Provider name — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts` (and `mockReasoningProvider.ts`)
- **Function:** `getUsageDiagnostics`
- **Field name:** `provider`
- **Example object path:** `diagnostics.reasoningProvider.provider` (`"claude"` or `"mock"`)
- **Evidence:** `provider: "claude"` (`claudeReasoningProvider.ts:378`); `provider: "mock"`
  (`mockReasoningProvider.ts:16`) — `MockReasoningProvider` always reports zeroed counts and
  `provider: "mock"` specifically so "mock runs can never be mistaken for real Claude API
  usage" (`docs/architecture.md` §6, confirmed in code).

### C3 — Model invocation params (max tokens, timeout, effort) — **PARTIAL**

- **Existing data:** `ClaudeReasoningConfig` carries `maxOutputTokens`, `timeoutMs`,
  `maxRetries`, `minConfidence` (`src/reasoning/config.ts:4-11`), all read from env vars with
  documented defaults/hard caps. `anthropicReasoningModelClient.ts:75` also sets a fixed
  `effort: "low"` on every call (`output_config.format ... effort: "low"`).
- **Missing data:** none of these invocation parameters are surfaced on
  `ReasoningProviderDiagnostics` or per-decision summaries — they exist only as
  process-level config, not as per-run or per-call trace data. A LangSmith trace normally
  wants the actual invocation params attached to each LLM run (this is standard
  `extra.invocation_params` in LangSmith's run schema) so a later config change is visible in
  historical traces rather than only in current env vars.
- **Required enhancement:** none needed in the engine itself if LangSmith tracing is added at
  the `src/api/runner.ts`/`anthropicReasoningModelClient.ts` boundary, since
  `ClaudeReasoningConfig` is already fully resolved and in scope there — the enhancement is
  in the *tracing wrapper*, not the engine's own data model.

### C4 — SDK/library version — **NO**

- **What was checked:** `package.json` (`"@anthropic-ai/sdk": "^0.120.0"`),
  `anthropicReasoningModelClient.ts`.
- **Evidence:** the SDK version is pinned in `package.json` but never read at runtime or
  surfaced anywhere in diagnostics.
- **Recommended capture location:** if needed, read
  `require("@anthropic-ai/sdk/package.json").version` (or equivalent) once at process start
  in `src/api/main.ts`, alongside the existing commit-SHA diagnostic
  (`readDeployedCommitSha`, see H2) — never per-run, since it cannot change within a process
  lifetime.
- **Why that location:** `main.ts` already reads and logs deployment-identity information
  once at startup (`console.log` calls at lines 11, 26 per the earlier grep), so this is
  consistent with the existing pattern rather than a new mechanism.

---

## 5. Prompt / input capture

### D1 — System prompt text — **NO (by design)**

- **File:** `src/reasoning/promptBuilder.ts`
- **Function:** `buildReasoningPrompt` (builds `system`, `~90` lines of plain-language
  instruction, lines 427-507)
- **Evidence this is intentional, not an oversight:** `docs/architecture.md` §6 states
  explicitly: "Per-decision usage metadata ... is recorded on an in-memory decision log ...
  It never carries prompts, raw model responses, page content, request bodies, API keys,
  headers, or credentials." `ClaudeReasoningProviderOptions.onDecisionLogged`'s doc comment
  (`claudeReasoningProvider.ts:137-144`) and `ReasoningProviderDiagnostics`'s own doc comment
  (`src/types/task-response.ts:560-567`) repeat the same constraint. This is a repo-wide,
  deliberate non-negotiable, not a missing feature.
- **Recommended capture location, if this decision is ever revisited:**
  `ClaudeReasoningProvider.attemptOnce` (`claudeReasoningProvider.ts:270-362`) already has
  `systemPrompt`/`userPrompt` in its parameter list before the SDK call — it is the single
  narrowest point where the full prompt exists in memory for every attempt, including
  corrective retries. **This requires an explicit product/security decision before any code
  change — see §11.**

### D2 — User prompt / observation payload sent to model — **NO (by design)**

- **File:** `src/reasoning/promptBuilder.ts`
- **Function:** `buildReasoningPrompt` (builds `user` as `JSON.stringify(payload)`, lines
  516-583)
- **Evidence:** same as D1. The `user` payload embeds `objective`, `successCriteria`,
  `currentPage` (url/title/notableText/interactiveElements), `recentActions`, and optionally
  `routeMemory`/`milestones`/`branch` — i.e., a compact but real slice of **third-party page
  content and the caller's own objective text**, which is exactly the kind of payload a
  security/compliance review needs to see before it is allowed to leave the process boundary
  toward a third-party SaaS product. See §11.
- **Recommended capture location:** same as D1 (`attemptOnce`'s `userPrompt` parameter).

### D3 — Prompt-element-selection diagnostic (proxy for prompt content) — **YES**

- **File:** `src/reasoning/promptBuilder.ts`
- **Function:** `selectPromptInteractiveElements`
- **Field name:** `PromptElementSelectionDiagnostic` → `ReasoningProviderDecisionSummary.elementSelection`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].elementSelection`
- **Evidence:** returns `{candidateCount, selectedCount, relevantSelectedCount,
  structuralSelectedCount, excludedRelevantCount, selected: [{id, accessibleName, reason}]}`
  (`src/types/task-response.ts:527-534`) — deliberately bounded (never the full observation,
  never unselected elements beyond a count) specifically so it is safe to carry without
  reconstructing D1/D2's concern. This is the one piece of "what did the model actually see"
  evidence that already exists without carrying raw prompt text, and is exactly the kind of
  proxy signal a LangSmith trace could use in place of the full prompt if D1/D2 are decided
  against.

---

## 6. Output / decision capture

### E1 — Raw model output (full parsed JSON) — **NO (by design)**

- **File:** `src/reasoning/anthropicReasoningModelClient.ts`
- **Function:** `createAnthropicReasoningModelClient`
- **Evidence:** `response.parsed_output` (line 81) is returned to the caller
  (`ClaudeReasoningProvider.attemptOnce`) but only specific fields are ever pulled out of it
  for logging (`confidence`, `consentControlIntent` — see E3/E4); the full
  `ClaudeDecisionPayload` object (`action`, `targetElementId`, `navigateUrl`, `reason`,
  `confidence`, `consentControlIntent`, `params` — `src/reasoning/claudeDecisionSchema.ts:26-37`)
  is never serialized verbatim into the decision log or diagnostics. Same "never raw model
  responses" constraint as D1/D2.
- **Recommended capture location, if revisited:** `attemptOnce`'s `result.parsedOutput`
  (`claudeReasoningProvider.ts:293-347`), same call site that already destructures individual
  fields from it today.

### E2 — Selected action / decision rationale — **YES**

- **File:** `src/core/loop.ts`
- **Function:** `buildStepLog` (via the `decision` parameter, sourced from `decision.rationale`)
- **Field name:** `StepLog.decision` (free text), `StepLog.selectedAction`
- **Example object path:** `steps[].decision`, `steps[].selectedAction`
- **Evidence:** `Decision.rationale` is produced by `ClaudeReasoningProvider.attemptOnce`
  (line 344: `` rationale: `${validation.reason} (Claude confidence
  ${validation.confidence.toFixed(2)})` ``) and threaded into `buildStepLog`'s `decision`
  parameter at `loop.ts:1003` (`decision.rationale` in the ternary's final branch).
  `effectiveAction` (a `SelectedAction`, `src/types/actions.ts:15-19`) is stored as
  `StepLog.selectedAction`. This is a *reconstructed, partial* proxy for the model's output —
  not the raw JSON (see E1) — but is the actual decision the engine acted on, which is the
  most decision-relevant part of "output" for most trace consumers.

### E3 — Confidence score — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `attemptOnce`
- **Field name:** `confidence`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].confidence`
- **Evidence:** `confidence: validation.confidence` on acceptance (line 332),
  `confidence: result.parsedOutput.confidence` on a schema-valid-but-rejected decision
  (line 317) — present whenever the model produced a parseable response, absent for a
  transport-level `error` outcome (no response to read a confidence from).

### E4 — Consent classification (`consentControlIntent`) — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `attemptOnce`
- **Field name:** `consentControlIntent`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].consentControlIntent`
- **Evidence:** `const consentControlIntent = result.parsedOutput.consentControlIntent;`
  (line 309), logged on both acceptance and `consent_policy_violation` rejection (lines
  321, 336) "so the full attempt-by-attempt consent history is auditable even when nothing
  was ultimately dispatched" (doc comment, lines 52-57).

### E5 — Consent policy compliance flag — **YES**

- **File:** `src/safety/consentPolicyGuard.ts`
- **Function:** `isConsentIntentCompliant`
- **Field name:** `consentPolicyCompliant`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].consentPolicyCompliant`
- **Evidence:** computed at `claudeReasoningProvider.ts:310` and logged alongside
  `consentControlIntent` (lines 322, 337); also independently re-checked at the safety layer
  (`src/safety/index.ts`'s `validateDecision`, per `docs/architecture.md` §6's "This check
  runs twice" note) as a hard guardrail, not merely a diagnostic.

### E6 — SDK `stop_reason` (e.g. `"refusal"`) — **PARTIAL**

- **Existing data:** `ReasoningModelResult.stopReason` (`src/reasoning/reasoningModelClient.ts:33-37`)
  is populated from `response.stop_reason ?? "unknown"`
  (`anthropicReasoningModelClient.ts:82`) and used internally in `attemptOnce` to
  distinguish `"refusal"` from `"malformed_output"` as the logged `reason`
  (`claudeReasoningProvider.ts:294`).
- **Missing data:** the raw `stopReason` value itself is discarded after that one
  if/else — only the derived `reason` string (`"refusal"` or `"malformed_output"`) is
  logged, and (per G2 below) even that derived reason is not serialized to
  `ReasoningProviderDecisionSummary`. Every other possible `stop_reason` the SDK could return
  (e.g. `"end_turn"`, `"max_tokens"`) is never distinguished at all once `parsedOutput` is
  present, since the check only runs in the `!result.parsedOutput` branch.
- **Required enhancement:** would need a schema/type decision (is `stop_reason` worth a
  first-class field on `ReasoningProviderDecisionSummary`?) rather than a pure bug fix, since
  today's collapsing of stop reasons into a two-way `reason` string is intentional
  simplification, not an oversight.

---

## 7. Token usage & cost

### F1 — Input tokens per call — **YES**

- **File:** `src/reasoning/anthropicReasoningModelClient.ts`
- **Function:** `createAnthropicReasoningModelClient`
- **Field name:** `usage.inputTokens`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].inputTokens`
- **Evidence:** `inputTokens: response.usage?.input_tokens` (line 84), read straight from the
  Anthropic SDK's own `response.usage` object — never estimated or computed by this engine.

### F2 — Output tokens per call — **YES**

- **File:** `src/reasoning/anthropicReasoningModelClient.ts`
- **Function:** `createAnthropicReasoningModelClient`
- **Field name:** `usage.outputTokens`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].outputTokens`
- **Evidence:** `outputTokens: response.usage?.output_tokens` (line 85), same source as F1.

### F3 — Aggregate token totals per run — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `getUsageDiagnostics`
- **Field name:** `totalInputTokens`, `totalOutputTokens`
- **Example object path:** `diagnostics.reasoningProvider.totalInputTokens` /
  `.totalOutputTokens`
- **Evidence:** `entries.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0)`
  and the output-token equivalent (lines 385-386) — summed across every logged attempt in
  the run, including retries.

### F4 — Monetary cost — **NO (deliberate)**

- **What was checked:** `ReasoningProviderDiagnostics` type definition and its doc comment
  (`src/types/task-response.ts:560-567`); `docs/architecture.md` §11.
- **Evidence it is a deliberate, documented exclusion, not a gap:** "`diagnostics.reasoningProvider`
  reports raw token counts (see §6) so cost can be computed downstream against whatever
  pricing applies at query time; the engine deliberately never hardcodes a per-token price."
  (`docs/architecture.md` §11, "What the v1 scaffold does and does not include").
- **Recommendation:** no engine change needed. LangSmith itself computes cost from
  `(model, input tokens, output tokens)` for known models once a trace is ingested, using its
  own pricing table — this is a downstream/platform concern the token counts (F1-F3) already
  fully support, not something this engine should duplicate.

---

## 8. Outcome, errors & retries

### G1 — Decision outcome (`accepted`/`rejected`/`error`/`fallback`) — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `attemptOnce` / `fallback`
- **Field name:** `outcome`
- **Example object path:** `diagnostics.reasoningProvider.decisions[].outcome`
- **Evidence:** all four outcome values are explicitly set at their respective call sites:
  `"rejected"` (lines 298, 313), `"accepted"` (line 331), `"error"` (line 354, in the `catch`
  block), `"fallback"` (line 395, `fallback()`'s own `log()` call).

### G2 — Error/rejection reason code — **PARTIAL**

- **Existing data:** `ClaudeDecisionLogEntry.reason` (internal, in-memory) is populated with
  a specific machine-readable string for every non-accepted outcome: `"refusal"` /
  `"malformed_output"` (line 294), any `ClaudeDecisionRejectionReason` from
  `validateClaudeDecision` (`action_not_allowed`, `low_confidence`,
  `missing_target_element_id`, `unknown_target_element_id`, `navigate_not_allowed`,
  `consent_policy_violation` — `src/reasoning/validateClaudeDecision.ts:7-13`), or a
  sanitized SDK error category from `sanitizeError` (see G5) on a thrown error.
- **Missing data:** `toDecisionSummary()` (`claudeReasoningProvider.ts:149-162`) never maps
  `entry.reason` onto the returned `ReasoningProviderDecisionSummary` object, and
  `ReasoningProviderDecisionSummary`'s own type definition
  (`src/types/task-response.ts:536-558`) has no `reason` field at all. So the single most
  useful piece of "why did this call fail/get rejected" data that the engine already computes
  internally, on every attempt, never reaches `TaskResponse` or any diagnostics a caller
  (or a future LangSmith exporter reading only the finished `TaskResponse`) can see.
- **Required enhancement:** add `reason?: string` to `ReasoningProviderDecisionSummary`
  (`src/types/task-response.ts:536`) and to `toDecisionSummary()`'s object literal
  (`claudeReasoningProvider.ts:149-162`), gated behind the same additive-versioning
  discipline used for every other field added to this structure
  (`REASONING_PROVIDER_DIAGNOSTICS_VERSION`, `src/reasoning/reasoningProvider.ts:18`). This
  is the single highest-value, lowest-risk gap found in this inventory — it requires no new
  data collection, only forwarding data that is already computed and already in memory.

### G3 — Retry count (aggregate) — **YES**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function:** `getUsageDiagnostics`
- **Field name:** `retryCount`
- **Example object path:** `diagnostics.reasoningProvider.retryCount`
- **Evidence:** `const retries = entries.filter((entry) => entry.attempt >= 1);` then
  `retryCount: retries.length` (lines 374, 388) — counts every attempt beyond the first
  (`attempt === 0`) within a `decide()` call, across the whole run.

### G4 — Corrective-retry flag per attempt — **PARTIAL**

- **Existing data:** `ClaudeDecisionLogEntry.correctiveRetry` is set `true` specifically for
  the one bounded corrective retry issued after a `response_schema_invalid` /
  `response_parse_failed` / `consent_policy_violation` failure (line 51 doc comment,
  set at call sites `claudeReasoningProvider.ts:238-252`).
- **Missing data:** the field's own doc comment states explicitly: "Internal-only -- never
  forwarded to ReasoningProviderDecisionSummary/the response schema" (lines 43-49) — this is
  a **deliberate**, documented exclusion, distinct from G2's undocumented gap. Confirmed by
  checking `toDecisionSummary()` (lines 149-162), which indeed omits it.
- **Required enhancement (if this decision is revisited):** same mechanical change as G2 —
  add the field to the summary type and mapping function. Flagged as PARTIAL rather than NO
  because, unlike D1/D2/E1 (privacy/payload-size driven exclusions), this one has no stated
  *reason* beyond "the caller doesn't currently need it" in the comment — it is a much lower-
  friction candidate to simply add.

### G5 — Sanitized SDK error category — **PARTIAL**

- **Existing data:** `sanitizeError` (`src/reasoning/anthropicReasoningModelClient.ts:37-52`)
  maps every real Anthropic SDK exception to one of a small, fixed vocabulary:
  `authentication_failed`, `permission_denied`, `not_found`, `rate_limited`, `timeout`,
  `connection_error`, `bad_request`, `api_error_<status>`, `response_parse_failed`,
  `response_schema_invalid`, or the catch-all `provider_error` — explicitly never forwarding
  `error.message` itself, "since the real Anthropic client is constructed with the
  caller-supplied API key, and SDK error messages are not a place this code chooses to trust
  not to echo request/response details" (lines 32-36).
- **Missing data:** this category becomes `ClaudeDecisionLogEntry.reason` for an `"error"`
  outcome (`claudeReasoningProvider.ts:350`), which — per G2 — is never propagated to
  `ReasoningProviderDecisionSummary`. So today, an `"error"` outcome in
  `diagnostics.reasoningProvider.decisions[]` tells a caller *that* a call errored but not
  *which* sanitized category (rate limit vs. auth failure vs. timeout, etc.).
- **Required enhancement:** identical fix to G2 (they share the same `reason` field and the
  same `toDecisionSummary()` gap) — this is not a second, separate change.

### G6 — Semantic-verifier decision outcome (second LLM call type) — **YES**

- **File:** `src/reasoning/semanticCriterionVerifier.ts`
- **Function:** `getUsageDiagnostics`
- **Field name:** `SemanticVerifierDecisionSummary` (`outcome`: `"satisfied"` /
  `"not_satisfied"` / `"error"` / `"cache_hit"`)
- **Example object path:** `diagnostics.semanticVerifier.decisions[].outcome`
- **Evidence:** structurally near-identical to the navigation-decision log
  (`ClaudeSemanticCriterionVerifier.log`, lines 256-258; aggregated at lines 234-254). This
  is a **separate model call type** from navigation decisions — it never selects an action,
  only adjudicates a `semantic_page_match` success criterion
  (`docs/architecture.md` §6, "SemanticCriterionVerifier" section) — and carries its own
  `callCount`, `cacheHitCount`, `satisfiedCount`, `rejectedCount`, token/latency totals, and
  `retryCount`, versioned independently via `SEMANTIC_VERIFIER_DIAGNOSTICS_VERSION`
  (`semanticCriterionVerifier.ts:7`). **Any LangSmith Phase 1 plan must account for this as a
  second, distinct LLM-run type**, not fold it into the navigation-decision instrumentation —
  it has its own prompt (`buildPrompt`, lines 89-122), its own schema
  (`semanticVerificationSchema.ts`), and its own cache (so a `cache_hit` outcome should
  probably not be traced as a fresh LLM run at all, since no API call was made — see the
  `attempt: -1, latencyMs: 0` cache-hit log at line 183).
- **Note:** this verifier's decision log has the exact same G2-style gap — its
  `DecisionLogEntry` has no analog to `reason`/`stopReason` at all (its outcomes are just the
  four listed above, no separate error-category field), so there is nothing to forward here
  beyond what already is.

---

## 9. Session / task correlation & environment metadata

### H1 — Engine version — **YES**

- **File:** `src/core/engine.ts`
- **Function:** `buildTerminalResponse` (constant `ENGINE_VERSION`, line 35)
- **Field name:** `Diagnostics.engineVersion`
- **Example object path:** `diagnostics.engineVersion` (currently `"0.1.0-poc"`)
- **Evidence:** `engineVersion: ENGINE_VERSION` (line 444) — a hardcoded string constant, not
  read from `package.json` or git metadata.

### H2 — Deployed commit SHA — **YES (health endpoint only)**

- **File:** `src/api/server.ts`
- **Function:** `handleHealth`
- **Field name:** `commit` (from `readDeployedCommitSha()`, `src/config/deploymentInfo.ts`)
- **Example object path:** `GET /v1/health` response → `commit` — **not** present on
  `TaskResponse` or any per-run diagnostics.
- **Evidence:** `const commit = readDeployedCommitSha();` then conditionally spread into the
  health response (`server.ts:72-78`); reads `RENDER_GIT_COMMIT` or `GIT_COMMIT_SHA`
  (`.env.example` lines 149-156). If LangSmith traces need to be correlated to a specific
  deployed commit (useful for regression triage), this would need to be threaded into the
  per-run tracing metadata at the `src/api/runner.ts` boundary, since it is not on the
  response object today.

### H3 — API caller identity — **NO**

- **File:** `src/api/auth.ts`
- **Function:** `isAuthorized`
- **Evidence:** authorization is a single shared bearer token compared via
  `safeCompare`/`timingSafeEqual` (lines 55-70) — there is no per-caller identity, API key
  scoping, or client name anywhere in the auth model. `isAuthorized` returns a boolean only;
  nothing about *which* caller made the request is retained anywhere (not in `RunRecord`, not
  in `TaskResponse`).
- **Recommended capture location:** none exists without a design change to the auth model
  itself (e.g. moving from one shared token to per-client tokens/API keys). This is a
  pre-existing product decision independent of LangSmith and out of scope for a passive
  capture point — flagged here only because "who initiated this run" is a field a LangSmith
  Phase 1 rollout would normally want and currently cannot get from this codebase at all.

### H4 — Environment/deployment tag (prod/staging) — **NO**

- **What was checked:** `.env.example`, `src/config/*`.
- **Evidence:** `NODE_ENV` exists (`development`/`production`/`test`,
  `.env.example` lines 4-9) and gates `src/api/auth.ts`'s test-mode bypass, but it is never
  surfaced in any response, diagnostic, or log line — it is a pure runtime behavior switch,
  not an observability tag.
- **Recommended capture location:** `src/api/runner.ts`'s `executeTaskAsync` (same boundary
  as A4) already runs in the process that has `process.env.NODE_ENV` in scope; a LangSmith
  tracing wrapper there could tag each trace with it without any engine change.

### H5 — Worker/process identity — **YES (TaskStore only)**

- **File:** `src/api/workerIdentity.ts`, `src/api/taskStore.ts`
- **Function:** (module-level `WORKER_ID` generation, per `docs/architecture.md` §13)
- **Field name:** `RunRecord.workerId`
- **Example object path:** `RunRecord.workerId` (store-internal; not part of `TaskResponse`)
- **Evidence:** "one random-token-plus-PID identity per process instance ... guaranteed to
  differ after a restart even if the OS reuses the PID" (`docs/architecture.md` §13,
  confirmed by `RunRecord.workerId: string` at `src/api/taskStore.ts:24`); used by
  `src/api/staleDetection.ts` to distinguish `"worker_lost"` from `"run_stale"`. Useful
  correlation data for tracing a run to the specific process instance that executed it
  (relevant after a restart/OOM incident), but currently confined to the `TaskStore` record
  and never surfaced in `TaskResponse` or any caller-visible field.

---

## 10. Existing extension point relevant to Phase 1 wiring

### I1 — `onDecisionLogged` passive-capture hook — **PARTIAL (exists, unwired)**

- **File:** `src/reasoning/claudeReasoningProvider.ts`
- **Function/field:** `ClaudeReasoningProviderOptions.onDecisionLogged`
  (lines 134-145), invoked at the end of `log()`: `this.onDecisionLogged?.(full);` (line 410)
- **Existing data:** this is a ready-made, already-shipped synchronous callback invoked with
  the *full* `ClaudeDecisionLogEntry` (including `timestamp`, `reason`, and
  `correctiveRetry` — i.e., every field flagged as PARTIAL/missing-from-the-summary above,
  since this hook taps the internal log entry *before* `toDecisionSummary()`'s lossy
  conversion) every single time a decision is logged, for every outcome including
  `fallback`.
- **Missing data:** it is never passed by any production code path. Confirmed by
  `grep -rn "onDecisionLogged" src/`: the only two matches are the field's own definition
  (`claudeReasoningProvider.ts`) and its use in a unit test
  (`tests/unit/claudeReasoningProvider.test.ts`). `src/reasoning/providerFactory.ts:39`
  constructs `new ClaudeReasoningProvider({ config: readClaudeReasoningConfig(env) })` with
  no `onDecisionLogged` — the sole production call site never wires this hook up.
- **Required enhancement (this is the most direct passive-capture point for Phase 1):**
  `providerFactory.ts`'s `createReasoningProvider` (line 38-39) would need to pass an
  `onDecisionLogged` callback that forwards each entry to a LangSmith run (tagged with
  `runId`/`taskId` per A4/A5, since this hook itself still doesn't have those in scope
  either — `createReasoningProvider(env)` has no `runId`/`taskId` parameter today). This
  sidesteps G2/G4/B3's "missing from the summary" problem entirely, since the hook receives
  the pre-lossy `ClaudeDecisionLogEntry`, not the exported summary — **but it still requires
  the D1/D2 prompt-capture decision (§11) to be resolved first**, since `onDecisionLogged`'s
  payload does not include the prompt either (prompts never enter `ClaudeDecisionLogEntry` in
  the first place — see D1/D2).
- **Note:** `ClaudeSemanticCriterionVerifier` (`semanticCriterionVerifier.ts`) has **no**
  equivalent hook — its `log()` (lines 256-258) only pushes to its own private
  `decisionLog` array with no callback option. A Phase 1 rollout covering the semantic
  verifier (see G6) would need this hook added there first, or would have to read
  `getUsageDiagnostics()` only after the fact (batched, not passive/real-time).

---

## 11. Security, compliance & retention decisions required

These are called out separately, as requested, because they are not engineering gaps to be
"fixed" — each requires an explicit decision from whoever owns data-handling policy for this
engine before any Phase 1 instrumentation touches them.

1. **Sending prompts/observations to a third-party SaaS (LangSmith) at all (D1, D2, E1).**
   The engine's own non-negotiable design rule (`docs/architecture.md` §6,
   `CLAUDE.md`) currently keeps prompts, raw model output, and page content out of every
   diagnostic surface specifically because the observation payload embeds **scraped
   third-party website content** (page titles, headings, interactive-element accessible
   names, notable text) and the **caller's own objective/success-criteria text**, which may
   describe a customer's non-public business process. Sending this to LangSmith is a new
   data-egress path that does not exist today and needs sign-off on: what data classification
   this content falls under, whether the target websites' own terms of use permit forwarding
   scraped content to a third party, and whether the objective text itself could contain
   anything sensitive a caller wouldn't expect to leave the process. **Decision owner:**
   whoever approves new third-party data processors for this system.

2. **New secret to manage: a LangSmith API key.** The engine's existing discipline
   (`ANTHROPIC_API_KEY` read only from env, never logged — `src/reasoning/config.ts:1-2`;
   `NAVIGATION_ENGINE_API_TOKEN` handled the same way — `src/api/auth.ts`) would need to be
   extended to whatever `LANGCHAIN_API_KEY`/`LANGSMITH_API_KEY` LangSmith's SDK requires.
   **Decision needed:** where this secret is provisioned (same `.env`/secret-manager path as
   the existing two, presumably) and confirmation it is added to `.env.example` as a
   placeholder only, per this repo's existing "Secrets" convention in `CLAUDE.md`.

3. **`host_context_snapshot` cookie/storage *names* (not values).** This capture module
   (`src/capture-modules/hostContext.ts`, `HostContextSnapshotCapture` type) is deliberately
   names-only by design specifically to avoid exposing state content
   (`src/types/task-response.ts:380-391`). If this capture module's output is ever included
   in what gets forwarded to LangSmith (it currently is not part of the reasoning-layer data
   at all, only `captures.*`), confirm the names-only guarantee is preserved end-to-end — a
   cookie/localStorage *key name* can itself sometimes indicate a specific third-party vendor
   or an internal system name even without its value, which may still be more than
   necessary for an LLM-observability trace.

4. **`taskId` is not guaranteed unique (A3, A5).** If LangSmith sessions/traces are keyed by
   `taskId` rather than `runId` (e.g. for easier human-readable grouping in the LangSmith UI),
   a caller reusing the same `taskId` across repeated executions (nothing in the schema
   prevents this) would conflate unrelated runs into one LangSmith session. **Decision
   needed:** confirm the LangSmith keying strategy uses `runId` (guaranteed unique,
   `randomUUID()`-derived) as the primary trace/session key, with `taskId` only as a
   secondary/tag field for human grouping.

5. **Retention alignment.** `TASK_RECORD_TTL_SECONDS` (default 86400s / 24h,
   `.env.example` lines 70-74) governs how long this engine's own `TaskStore` record
   (including the full `TaskResponse`) survives. LangSmith has its own, separate retention
   policy for ingested traces. **Decision needed:** whether LangSmith's retention should be
   configured to match, exceed, or intentionally diverge from this engine's own 24h default,
   and whether that decision differs for a "success" run vs. a "blocked"/"failure" run kept
   for incident investigation.

6. **Screenshots and other file-backed evidence are out of scope for today's reasoning-layer
   diagnostics, but worth flagging pre-emptively.** `captures.screenshots` stores only a file
   path string in memory (`docs/architecture.md` §13's "Confirmed memory-risk findings");
   the PNG files themselves are never read into any diagnostic structure. Nothing in this
   codebase today would forward image bytes to LangSmith. If a future phase adds multimodal
   tracing (e.g. attaching the screenshot at the step a `stop_failure` occurred), that is a
   new, currently-nonexistent data flow needing its own review — flagged here only so it is
   not silently introduced later under the umbrella of "Phase 1 LangSmith work."

---

## 12. What would need to change to close the identified gaps

Ordered roughly by value-to-effort ratio, for a future (separate, code-writing) task — not
acted on here:

1. **G2/G4/G5 (single fix):** add `reason?: string` and `correctiveRetry?: boolean` to
   `ReasoningProviderDecisionSummary` (`src/types/task-response.ts:536-558`) and to
   `toDecisionSummary()` (`src/reasoning/claudeReasoningProvider.ts:149-162`). Zero new data
   collection — purely forwarding what already exists in `ClaudeDecisionLogEntry`.
2. **B3:** add `timestamp?: string` the same way, from the same source object.
3. **A1:** generate and attach a per-decision id inside `ClaudeReasoningProvider.log()`
   (`claudeReasoningProvider.ts:402-411`).
4. **I1:** wire `onDecisionLogged` at the one production call site
   (`src/reasoning/providerFactory.ts:38-39`), and add an equivalent hook to
   `ClaudeSemanticCriterionVerifier` (`src/reasoning/semanticCriterionVerifier.ts`), which has
   none today.
5. **A4/A5/A6/H3/H4:** thread `runId` (and optionally `NODE_ENV`) into the tracing wrapper at
   `src/api/runner.ts`'s `executeTaskAsync` — deliberately *not* into `src/core`/`src/reasoning`,
   per `CLAUDE.md`'s core/plugin boundary rule; this keeps LangSmith wiring an application
   concern, consistent with how `REASONING_PROVIDER` selection itself is already kept out of
   the core loop (`docs/architecture.md` §6).
6. **D1/D2/E1:** blocked on the §11 security/compliance decision — no code should be written
   here until that decision is made.

---

*This document reflects the state of the repository at the time it was written. No source
file was modified to produce it.*
