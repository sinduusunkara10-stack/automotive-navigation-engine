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

## Journey Memory remediation pass (2026-09-28)

A second, production `decision_point_restore_failed` run
(`run_b3743f06-1667-443e-b9fa-e804aa5caecf`) traced to two bugs distinct from the "Why" above,
both now fixed:

1. **`src/actions/goBack.ts`** used a hardcoded 5000ms `page.goBack()` timeout waiting for
   Playwright's default `waitUntil: "load"`, and reported hard failure on timeout without
   ever checking `page.url()` first -- so a slow-settling SPA that had genuinely reached its
   target URL after 5s was misclassified as a restore failure. It now uses the same
   configurable `actionNavigationTimeoutMs` mechanism click/navigate already use, and
   `waitUntil: "commit"`, with explicit outcome states (`no_navigation`,
   `navigation_committed_restoration_unverified`, `restoration_verified`,
   `blank_or_unusable_page`, `restoration_failed` -- see `GoBackOutcome`). A genuinely
   committed, non-blank URL is now handed to the engine's existing per-step re-observation
   (`src/core/loop.ts`'s fingerprint check) for live verification, rather than being reported
   as a hard failure on the strength of a Playwright-level timeout alone.
2. **`buildRecoverySegments`** (`src/core/journeyMemory/segmentBuilder.ts`) only read
   `RunState.recoveryAttemptDiagnostics` (the anchor-hop recovery path) -- but the
   branch-return-hop path that actually throws `decision_point_restore_failed` writes to
   `RunState.routeAttemptDiagnostics`/`alternativeCandidateDiagnostics` instead, so those
   restore-failure events were never captured as journey-memory recovery segments at all.
   `buildRecoverySegments` now normalizes and consumes all three sources (tagged
   `segmentSource: "recovery_attempt" | "route_attempt" | "alternative_candidate"`, deduped
   across sources), still through the same Tier1-4 abstraction/retention pipeline unchanged.

This pass also added a small, bounded, **in-process-RAM-only** decision-point checkpoint
(`src/core/decisionPointCheckpoint.ts`) captured just before entering a bounded branch --
guidance/recognition only, alongside `RouteMemory`/`branchHistory` inside the same single-run
`RunState`, never persisted, never a second memory system, and never itself independently
verifying a milestone. It is discarded when its branch completes or the run ends.

`diagnostics.journeyMemory` was re-verified end to end (flag parsing through the GET-result
endpoint) and confirmed already correctly attached whenever `enabled` resolves true; no bug
was found in that path. Observability was still added: a safe startup log of resolved flags,
a safe run-completion log independent of the HTTP response, and new additive
`diagnostics.journeyMemory` fields -- `lookupAttempted`, `forwardSegmentsBuilt`,
`recoverySegmentsBuilt`, `segmentsWriteAttempted`, `writeFailureReason`, `diagnosticsAttached`,
`persistenceConfirmed` (see `$defs/journeyMemoryDiagnostics`, version `1.1.0`).

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
  time budget is exhausted. See "The Tier1-4 hard boundary, precisely" below for exactly what
  crosses a domain boundary and what never does.
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

## The Tier1-4 hard boundary, precisely

The domain hard boundary gates only **literal/executable identifiers**: raw URLs, CTA/
accessible-name text, element ids/selectors, product/model names, and locale-specific
control text. These never cross from a different registrable domain into another domain's
guidance, at any tier other than Tier1 -- only Tier1 (the exact same site the current run is
on) may carry them verbatim.

The boundary does **not** block sanitized, abstract structural guidance from crossing at
Tier3/4: generic structural concepts ("a page matching semantic pattern X led to a page
matching semantic pattern Y", "this action-role/meaning category preceded milestone-intent
Z", "this structural branch shape was unproductive") remain retrievable, scoreable, and can
still reach guidance -- just abstracted of any brand-specific literal content, and only when
they clear a strictly higher semantic-compatibility bar than Tier1/2 requires (see below).
"Hard boundary" in this document, and in the original PR description, means the literal-
identifier boundary above -- never a blanket ban on all cross-domain learning.

Implementation: `src/core/journeyMemory/abstraction.ts` is the single choke point that
enforces this at the *content-field* level (which fields of an out-of-domain candidate are
allowed into the guidance record), not as a retrieval-time reject of the whole tier --
`src/core/journeyMemory/scoring.ts` still retrieves and scores every tier, but for any
candidate scored as Tier2/3/4 it substitutes an abstracted projection (path/action/milestone
text reduced to the intersection with a closed, hand-picked generic-vocabulary allowlist,
never a brand/product word) before that candidate is ever returned to a caller or reaches
`promptSummary.ts`/the reasoning prompt.

Confidence/influence decreases monotonically Tier1 > Tier2 > Tier3 > Tier4
(`TIER_CONFIDENCE_MULTIPLIER`). Independently, Tier3/4 require a strictly higher raw
semantic-compatibility score than Tier1/2 before being accepted at all
(`JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD` = 0.75 vs `JOURNEY_MEMORY_ACCEPT_THRESHOLD` =
0.55; reject bar 0.4 vs 0.2, in `scoring.ts`) -- so only genuinely strong structural
alignment ever crosses a domain boundary, and even then its confidence is still bounded well
below an equivalent Tier1/2 candidate's. Live-page re-observation and semantic rematching
remain mandatory regardless of tier: journey memory only ever informs which action a
decision *proposes*; it never substitutes for the engine's own live observation, matching,
execution, or milestone verification (see "What's verified where" below). Cross-domain
memory (any tier other than Tier1) can therefore never itself complete a milestone -- only
current-run evidence can, exactly like Tier1.

See `tests/unit/journeyMemoryCrossDomain.test.ts` for the unit proof (literal content
stripped for Tier2+, abstract-only content still reaches "accept", and confidence orders
correctly) and `tests/integration/journeyMemoryFullEngineRecovery.test.ts` for the
full-engine proof that memory alone never verifies a milestone.

## Feature flags

| Env var | Default | Effect |
|---|---|---|
| `JOURNEY_MEMORY_ENABLED` | unset (off) | Master switch. Off is a complete rollback -- no journey-memory code path is ever touched. |
| `JOURNEY_MEMORY_READ_ENABLED` | `true` (once `ENABLED=true`) | `false` = collect without using (write-only). |
| `JOURNEY_MEMORY_WRITE_ENABLED` | `true` (once `ENABLED=true`) | `false` = validate stored memory without adding new writes (read-only). |

**Minimum config for full behaviour: `JOURNEY_MEMORY_ENABLED=true` alone** (plus `REDIS_URL`,
already required for `TASK_STORE=redis`). Leaving `JOURNEY_MEMORY_READ_ENABLED`/
`JOURNEY_MEMORY_WRITE_ENABLED` unset is not a partial/inert state -- both default to `true`
the moment `ENABLED=true`, so this single variable is enough for the full read+write
behaviour described throughout this document.

The full truth table (every case below is covered by
`tests/unit/journeyMemoryConfig.test.ts`, one test per row):

| ENABLED | READ | WRITE | Behaviour |
|---|---|---|---|
| unset/`false` | any | any | Fully inert -- no reads, no writes, zero journey-memory code path touches navigation, regardless of READ/WRITE. |
| `true` | unset | unset | Both default to enabled -- full behaviour. |
| `true` | `false` | `true` | Write-only: collect but never inject into navigation. |
| `true` | `true` | `false` | Read-only: use existing memory, never persist new/updated records. |
| `true` | `true` (explicit) | `true` (explicit) | Full behaviour. |
| any invalid/unparseable value (e.g. `"yes"`, an empty-looking non-empty token) | -- | -- | That one flag fails safe to disabled, never silently enabled. A `console.warn` diagnostic names the offending variable and its value (see `readBoolEnv` in `src/config/journeyMemoryConfig.ts`). |

Read-only mode validates stored memory (it can still be retrieved, scored, and surfaced in
diagnostics) without ever adding new writes. Write-only mode collects/writes segments from
every run without ever injecting guidance into navigation -- useful for building up a corpus
before switching a service over to full read+write. Disabling never deletes existing data --
only the Redis TTL ages it out.

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

## Render owner checklist

This session has no access to Render's dashboard or billing and cannot verify any of the
items below -- they are listed here **only** as things the project owner must confirm
themselves, never as claims already verified by this repo's own tests.

- [ ] The existing Render Key Value instance is provisioned as **persistent** storage, not an
      ephemeral/dev-mode instance that can be wiped on restart or redeploy.
- [ ] The engine service and the Key Value instance point at the **same** intended
      `REDIS_URL` (no stale/duplicate instance, no environment mismatch between staging and
      production).
- [ ] The instance's **region** matches the engine service's own region (latency, and
      Render's own same-region networking requirements for private connections).
- [ ] There is adequate **available memory/capacity headroom** on the instance for this
      feature's bounded footprint (500 records/domain x however many domains x a small
      sanitized JSON object per record) on top of whatever `TASK_STORE=redis` already uses.
- [ ] The instance's **eviction policy** does not evict journey-memory keys prematurely -- an
      LRU/LFU eviction policy on an instance shared with other keyspaces could evict
      `nav-engine:journey-memory:*` keys before their own 90-day TTL, silently defeating this
      feature's own retention design. Prefer `noeviction` (with monitored memory headroom) or
      confirm the shared instance's eviction policy is acceptable for this keyspace.
- [ ] The **expected incremental cost** of this feature's storage footprint on the existing
      plan (or a plan upgrade, if headroom is insufficient) has been reviewed and accepted.
- [ ] Persistence **survives a controlled Render service restart/redeploy** (verify records
      written before a restart are still readable after it -- see "Production smoke test"
      below).
- [ ] `nav-engine:journey-memory:*` keys are actually **visible via `redis-cli --scan`** (or
      Render's own Key Value browser) after a run with `JOURNEY_MEMORY_ENABLED=true`.
- [ ] The **90-day TTL is actually observed** on a sampled key (`redis-cli TTL <key>` returns
      a positive value at or below 90 days' worth of seconds, not -1/no-expiry).
- [ ] No raw URLs, query strings, tokens, cookies, or PII appear in any stored value -- the
      owner can eyeball a few keys' JSON values directly (sanitizer.ts's own design intends
      this to always be true; this checklist item is the owner's own independent visual
      confirmation, not a substitute for it).

## Production smoke test

A short, owner-run procedure for verifying this feature end to end against the real Render
Redis instance, once the checklist above is satisfied. This repo's own tests already prove
the code paths below work against a Redis test-double (see "What's verified where"); this
procedure is what additionally confirms them against the real, deployed Redis. **Write-only
mode (step 1) stays the recommended state until every step below has been confirmed once --
do not enable read mode (step 6) before then.**

1. Set `JOURNEY_MEMORY_ENABLED=true`, `JOURNEY_MEMORY_READ_ENABLED=false`,
   `JOURNEY_MEMORY_WRITE_ENABLED=true` (write-only mode) on the service.
2. Run one controlled navigation task against a real or staging target, ideally one that
   exercises at least one bounded branch/recovery so a recovery segment (not only a forward
   one) is produced.
3. Confirm `diagnostics.journeyMemory.storageAvailable === true` on that run's response.
4. Confirm `diagnostics.journeyMemory.segmentsWriteAttempted > 0` where eligible (i.e. the
   run produced at least one forward or recovery segment -- `forwardSegmentsBuilt +
   recoverySegmentsBuilt > 0`).
5. Confirm `diagnostics.journeyMemory.segmentsWritten > 0` (and, if it is ever less than
   `segmentsWriteAttempted`, note `writeFailureReason` -- a partial/failed write never fails
   the run itself, but should not be silently ignored here).
6. Check the real Redis instance directly and confirm the **only** keyspace touched is
   `nav-engine:journey-memory:*` (`redis-cli --scan --pattern 'nav-engine:journey-memory:*'`
   or Render's own Key Value browser) -- no other keyspace should have been written to.
7. Confirm the TTL on a sampled key (`redis-cli TTL <key>`) is a positive value at or below
   `JOURNEY_MEMORY_RETENTION_DAYS` worth of seconds (default 90 days), not -1/no-expiry.
8. Restart/redeploy the service, on a Render plan the owner has confirmed supports it (this
   repo makes no claim about which plan is active -- that stays owner-only, see the
   checklist above). Confirm the records written in steps 3-5 are still present and readable
   after the restart, where the plan supports persistence across restarts.
9. Confirm, by eyeballing a few of those Redis values directly, that only sanitized content
   is present -- no raw URLs, query strings, tokens, cookies, or PII (sanitizer.ts's own
   design intends this to always be true; this step is the owner's own independent visual
   confirmation).
10. **Only once steps 1-9 have all been confirmed**, switch the service to full read+write
    (`JOURNEY_MEMORY_READ_ENABLED`/`JOURNEY_MEMORY_WRITE_ENABLED` unset, or both explicitly
    `true`).
11. Run a second, related navigation task.
12. Confirm that run's response carries `diagnostics.journeyMemory` showing retrieval
    actually happened (`lookupAttempted: true`, `lookupCompleted: true`,
    `candidatesConsidered > 0`) and, if the escalation signal fired, `guidanceUsed: true`.
13. Confirm, via that same response's normal `steps[]`/`engineAssessment.
    satisfiedSuccessCriteriaIds` evidence (never from `diagnostics.journeyMemory` alone), that
    the second run genuinely re-executed and re-verified the live journey rather than
    short-circuiting from memory -- e.g. its own `steps[]` show real navigation/clicks, and
    every satisfied criterion has a corresponding live step where it was actually observed.

## What's verified where

- **Verified by this repo's own automated tests** (run with `npm test`, no live network
  Redis): the domain-partitioning/tiering logic (`tests/unit/journeyMemoryTiering.test.ts`),
  the Tier1-4 literal-vs-abstract content boundary and stricter Tier3/4 acceptance bar
  (`tests/unit/journeyMemoryCrossDomain.test.ts`), scoring
  (`tests/unit/journeyMemoryScoring.test.ts`), sanitization
  (`tests/unit/journeyMemorySanitizer.test.ts`), retention/precedence
  (`tests/unit/journeyMemoryRetention.test.ts`), prompt-summary bounding
  (`tests/unit/journeyMemoryPromptSummary.test.ts`), segment building
  (`tests/unit/journeyMemorySegmentBuilder.test.ts`), the retrieval/write-back service
  (`tests/unit/journeyMemoryService.test.ts`), the feature-flag truth table
  (`tests/unit/journeyMemoryConfig.test.ts`), and end-to-end behaviour against a real
  `runTask()` -> `loop.ts` -> `reasoningProvider.ts` -> `actions/*` call, including a
  genuine recovery escalation and a proof that memory alone never verifies a milestone
  (`tests/integration/journeyMemoryFullEngineRecovery.test.ts`), plus the pre-existing
  rollback/flags/cross-run tests (`tests/integration/journeyMemoryFeatureFlags.test.ts`,
  `tests/integration/journeyMemoryCrossRun.test.ts`).
- **Tested locally against a Redis test-double, but never a live network Redis**: every
  persistence property in `tests/unit/journeyMemoryStore.test.ts` (round-trip, visibility
  across independent store instances, disconnect/reconnect survival, TTL actually being set,
  concurrent writers not corrupting each other's records, process-restart survival) and the
  `createJourneyMemoryStore` fail-safe construction path -- all against `ioredis-mock`, an
  in-process Redis test-double that mimics the real protocol's semantics closely but is not
  the real Redis network/process/eviction behaviour.
- **Only the project owner can confirm, on Render** (this session has no dashboard/billing
  access): every item in the "Render owner checklist" above -- instance persistence mode,
  `REDIS_URL` alignment, region, capacity headroom, eviction policy, incremental cost, real
  restart-survival, real key visibility via `redis-cli --scan`, real observed TTL, and a
  real eyeballed absence of PII/raw URLs in stored values.

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
