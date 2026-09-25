# Persistent Cross-Run Journey Memory

Cross-run, Redis-backed memory of verified route/recovery evidence, complementary to (never a
replacement for) the existing single-run, in-process `RouteMemory`/Goal-Directed Bounded Branch
Exploration (`docs/architecture.md` §16-17, discarded at the end of every run). See
`docs/architecture.md` §29 for where this fits in the engine's own architecture.

## Why

A prior run's `decision_point_restore_failed` failure happened because `RouteMemory`/
`BranchExploration` are strictly single-run/in-process -- a related earlier run's verified
route segments (e.g. reaching a configurator, clicking Continue, reaching a finance step) were
unavailable to inform a later, unfamiliar decision point's recovery. This feature makes that
evidence available across runs, safely and boundedly.

## Design summary

- **Storage**: Redis, keyspace `nav-engine:journey-memory:*` (separate from the existing
  `nav-engine:run:*` run-record keyspace, `src/api/redisTaskStore.ts`). No new datastore is
  provisioned -- it reuses the same `REDIS_URL`/`ioredis` dependency, under `TASK_STORE`'s
  existing Redis connection pattern. See `src/core/journeyMemory/store.ts`.
- **Atomicity**: each record lives at its own key; a single `SET key value EX ttl` is itself
  an atomic Redis operation, so concurrent writers producing *different* record ids never
  race with each other, and even a same-id race only ever produces one complete, internally
  consistent JSON value (last-write-wins, never a partial write). The per-domain index (a
  Redis `SET`, via `SADD`) is a separate, idempotent operation: a lost race on it repeats
  harmlessly, never causing data loss.
- **Fail-safe, never fail-fast**: unlike `TASK_STORE=redis` (which fails startup fast, since
  run-record persistence is load-bearing), an unavailable/misconfigured Redis here never
  blocks startup or a run -- cross-run memory is simply absent, recorded in
  `diagnostics.journeyMemory.unavailableReason` (`storage_unavailable`/`timeout`/`no_match`).
  See `src/core/journeyMemory/storeFactory.ts`.
- **Retrieval**: deterministic, zero-Claude-call, tiered (Tier1 same-domain+same-market ->
  Tier2 same-domain+different-market -> Tier3 different-domain+same-market -> Tier4
  different-domain+different-market), stopping once sufficient Tier1 evidence is found or the
  time budget is exhausted. Only Tier1 ever carries a raw URL/CTA text/element identity into
  planning; Tier2+ carry only structural/semantic guidance (`src/core/journeyMemory/tiering.ts`).
- **Matching**: multiple weighted deterministic signals (objective/milestone/journey-type
  meaning, semantic page identity, action meaning, historical outcome, recency, confidence),
  never word-overlap alone -- `src/core/journeyMemory/scoring.ts`. Thresholds are labelled
  unvalidated/env-configurable, the same convention `src/core/surfaceRelevance.ts` already
  uses for its own (different) thresholds.
- **Injection**: only into the *next* existing reasoning prompt, only when an existing
  detection signal (historically-known-bad branch, recovery beginning, decision-point
  restoration, no milestone progress after a bound) fires -- never a standing per-step field.
  Bounded: at most `JOURNEY_MEMORY_MAX_PROMPT_RECORDS` records, deduplicated, hard character
  AND estimated-token caps. `src/core/journeyMemory/promptSummary.ts`.
- **Extra reasoning call**: at most one bounded "recovery-focused" call per recovery episode,
  capped per run by `JOURNEY_MEMORY_MAX_RECOVERY_CALLS` (default 2), only fired when the
  memory-augmented ordinary call still could not resolve recovery. Identical call shape to
  every other decision -- never bypasses the fixed action vocabulary or sees raw page HTML.
- **Write-back**: at run end, from the run's own `steps[]`/`recoveryAttemptDiagnostics` --
  fine-grained forward and recovery segments, sanitized, never a whole-run summary. A
  partially successful run still writes every independently-verified segment it produced.
- **Sanitization**: normalized registrable domain + normalized path only; no raw query
  string/fragment/cookies/tokens/PII ever persisted. A query/fragment param may be extracted
  into a separate sanitized field only via an explicit allowlist
  (`src/core/journeyMemory/sanitizer.ts`'s `ALLOWLISTED_PARAM_NAMES`), never a passthrough.
- **Retention/dedup/precedence**: max 500 records/registrable domain (lazy eviction on write,
  lowest-confidence-then-oldest first), 90-day Redis TTL. A newer verified success supersedes
  older equivalent successes (deduped). A newer failure never deletes/overwrites an older
  equivalent success; confidence only decays once several (>=3) comparable recent failures
  accumulate, and a later verified success restores it. All confidence changes are recorded
  in `diagnostics.journeyMemory.confidenceChanges`. See `src/core/journeyMemory/retention.ts`.

## Feature flags

| Env var | Default | Effect |
|---|---|---|
| `JOURNEY_MEMORY_ENABLED` | unset (off) | Master switch. Off is a complete rollback -- no journey-memory code path is ever touched. |
| `JOURNEY_MEMORY_READ_ENABLED` | `true` (once `ENABLED=true`) | `false` = collect without using (write-only). |
| `JOURNEY_MEMORY_WRITE_ENABLED` | `true` (once `ENABLED=true`) | `false` = validate stored memory without adding new writes (read-only). |

The four supported combinations: both off (rollback), read-off+write-on (collect without
using), read-on+write-off (validate without new writes), both on (full). Disabling never
deletes existing data -- only the Redis TTL ages it out.

Timing/retention knobs (all optional, hard-ceilinged): `JOURNEY_MEMORY_LOOKUP_TIMEOUT_MS`
(default 1000), `JOURNEY_MEMORY_RECOVERY_TIMEOUT_MS` (default 1500),
`JOURNEY_MEMORY_MAX_RECOVERY_CALLS` (default 2), `JOURNEY_MEMORY_MAX_RECORDS_PER_DOMAIN`
(default 500), `JOURNEY_MEMORY_RETENTION_DAYS` (default 90),
`JOURNEY_MEMORY_MAX_PROMPT_RECORDS` (default 5), `JOURNEY_MEMORY_PROMPT_CHAR_CAP` (default
1600), `JOURNEY_MEMORY_PROMPT_TOKEN_CAP` (default 400),
`JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND` (default 6). See
`src/config/journeyMemoryConfig.ts` for exact ceilings.

## Deployment (Render)

1. Set `JOURNEY_MEMORY_ENABLED=true` (and, if not already set for `TASK_STORE=redis`,
   `REDIS_URL`) as environment variables on the Render service.
2. No other setup needed -- the feature reuses the existing Redis connection/dependency, under
   its own keyspace prefix. If `REDIS_URL` is unset or unreachable, the run still proceeds
   normally, with cross-run memory simply absent (`storage_unavailable` in diagnostics).
3. **Render Key Value plan/capacity sizing is something only the project owner can confirm
   from their Render dashboard** -- this session cannot query Render's plan/billing. Storage
   footprint is bounded by the caps above (500 records/domain, 90-day retention, each record a
   small sanitized JSON object with no raw page content), so the owner can size their plan
   from those bounds rather than from a guess.

## Rollback

Set `JOURNEY_MEMORY_ENABLED=false` (or unset it). No manual cleanup is required -- existing
records simply age out via their Redis TTL over the following `JOURNEY_MEMORY_RETENTION_DAYS`.

## Measured overhead (from this PR's tests)

- Pre-run lookup (empty store, ioredis-mock): sub-millisecond in this test environment; hard
  ceiling enforced at `JOURNEY_MEMORY_LOOKUP_TIMEOUT_MS` (default 1000ms) regardless.
- No extra reasoning call fires by default: it only fires when memory-augmented ordinary
  reasoning still cannot resolve a recovery episode, capped at `JOURNEY_MEMORY_MAX_RECOVERY_CALLS`
  (default 2) per run. A normal run performs zero additional Claude calls.
- Prompt injection is bounded to at most 5 records, ~1600 characters, ~400 estimated tokens
  (all env-configurable) -- see `tests/unit/journeyMemoryPromptSummary.test.ts`.

These are synthetic/local-fixture measurements (ioredis-mock, local Chromium fixture pages),
not production-network numbers; real Redis round-trip latency will differ, still bounded by the
same hard ceilings.
