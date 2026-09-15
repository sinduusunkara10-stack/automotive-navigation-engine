# Phase 2 Design: Drawer/Modal Recovery, Alternative Route Exploration, Truthful Milestones

Status: **design only — no implementation in this document's commit.** This is the design and
implementation plan requested for Phase 2 (PR 1C, PR 1D), grounded in the actual mechanisms
already in `src/core`, `src/actions`, `src/observation`, `src/reasoning`, and `src/safety`
(see `docs/architecture.md` §5, §6, §16, §17, §18) and in the proven Nissan investigation
findings below. Per `docs/v1-scope.md`'s working discipline, this deliberately proposes the
narrowest change that fixes the diagnosed generic weakness — it does not redesign systems that
the investigation already cleared.

## 0. Grounding: what the investigation actually proved

- No regression between PR45 and current main; PR1A (target-attributable click evidence) and
  PR1B (safe replanning/go_back) are cleared as causes.
- Milestone evaluation behaved correctly for this run.
- Failure path: `View Offer Details` (click) → `low_confidence` → `go_back` → `go_back` →
  `stop_blocked`.
- Branch Exploration (`docs/architecture.md` §17) and Route Memory (§16) never activated.

Mapping this onto the current code:

- `low_confidence` is `validateClaudeDecision.ts`'s rejection when `payload.confidence <
  minConfidence`. `ClaudeReasoningProvider` (`src/reasoning/claudeReasoningProvider.ts`) gives
  **one** corrective retry (`CORRECTIVE_RETRY_CATEGORIES`) against the **same** observation, then
  falls back to a `stop_blocked` `Decision` (`FALLBACK_ACTION_TYPE`) if the retry is also
  rejected.
- That `stop_blocked` decision reaches `src/core/loop.ts`'s bounded journey-replanning check
  (`MAX_JOURNEY_REPLANNING_ATTEMPTS = 2`), which substitutes `go_back` for it, up to twice, before
  finally honouring `stop_blocked`. This is exactly the two `go_back`s observed before `stop_blocked`.
- Branch Exploration never activated because its entry condition
  (`isAmbiguousMultiCandidateDecisionPoint`, `src/core/branchExploration.ts`) only fires
  **pre-dispatch**, on an ambiguous *choice* between visible candidates. It has no mechanism for
  the case here: a candidate was clicked, something happened, and the reasoning layer could not
  confidently characterise the *result* — because the observation it was reasoning over gave it
  no signal that a new surface had just appeared.
- Route Memory never activated because it only ever informs a *later* visit to the same
  decision-point fingerprint; a run that dies within its first `go_back`/`go_back`/`stop_blocked`
  sequence never revisits anything.

Most likely cause, and the concrete generic weakness this phase targets: **the engine has no
generic, ARIA-independent way to recognise that a click just opened a new interactive surface,
and no recovery path that (a) gets the reasoning layer a fresh, surface-aware observation before
giving up, or (b) tries a different, sibling candidate instead of only retreating.**

---

# PR 1C ARCHITECTURE

## Problem

1. Drawer/modal/half-window detection today (`Observation.activeDialog`,
   `src/observation/observationBuilder.ts` §18) is standards-based only:
   `role="dialog"`/`aria-modal="true"`/native `<dialog>`. A real drawer/side-panel/half-window
   built with plain `<div>`s and CSS (no ARIA authoring) is invisible to this signal.
2. Post-click timing is a fixed `PAGE_SETTLE_DELAY_MS = 250` wait
   (`src/core/robustNavigation.ts`, used by `src/actions/click.ts`) applied unconditionally,
   whether or not anything actually changed, and regardless of whether a slower-rendering
   drawer animation needs longer.
3. `low_confidence` recovery is a single same-observation corrective retry, then an immediate
   fallback to `stop_blocked` → bounded `go_back`. No re-observation ever happens before giving
   up on the current candidate.
4. `go_back` never leads to trying a different, sibling candidate at the same decision point —
   only to retreating further or eventually stopping.

## Design

### 1. Surface detection beyond `role="dialog"`/`aria-modal`

The engine already has the right primitive, just scoped too narrowly: `InteractionSnapshot` and
`detectTargetAttributableSideEffect` (`src/observation/observationBuilder.ts`, §18) compare a
pre/post-click snapshot generically — dialog markup, a bounded count of newly-appeared visible
interactive elements, and target-attribution signals (`aria-expanded`, `covered`, disappearance).
Today this only runs (a) as part of intercepted-click recovery, and (b) as a single post-success
snapshot feeding route-progress classification. It does not yet feed observation or the prompt.

**Extend, don't replace.** Add one more detection signal to the existing comparison, still
générique and DOM-structural, still no vendor/brand vocabulary:

- **Layer/panel heuristic**: after a successful click, scan for any element that (a) appeared or
  became visible since the pre-click snapshot, (b) has `position: fixed | absolute | sticky` with
  a computed stacking context above the page's baseline content, and (c) occupies at least a
  fixed minimum fraction of the viewport (`MIN_PANEL_VIEWPORT_COVERAGE`, e.g. 25%) **or** spans a
  full viewport edge (a slide-in drawer's classic shape — full height, partial width, or vice
  versa). This is the same class of `elementFromPoint`/computed-style read the existing `covered`
  hit-test already performs, extended to a "did a new large layer arrive" question instead of "is
  this specific element obscured."
- This heuristic is **never** trusted alone — exactly like the existing
  `MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE` (2) rule, it must co-occur with at least one
  newly-appeared visible interactive element, so a sticky promo bar or cookie strip with no new
  controls doesn't register as a drawer.
- Result: `classifySurfaceChange(before, after, targetBefore, targetAfter)` — a generalisation of
  today's `detectTargetAttributableSideEffect` — returns one of `"dialog_appeared"`,
  `"layer_panel_appeared"`, `"elements_appeared"`, `"none"`, plus bounded metadata (new element
  count, approx. viewport coverage). No new dependency, no per-site selector, no brand wordlist.

### 2. Post-click surface awareness

Run `classifySurfaceChange` **unconditionally after every successful click** (not only on an
`"intercepted"` Playwright error, as today). When it returns anything other than `"none"`:

- Wait for stabilisation (see readiness strategy, next).
- The next `buildObservation()` call (already happening every step) gets a new optional field,
  `Observation.surfaceChangeContext: { type, newElementCount, viewportCoveragePercent }`.
- `promptBuilder.ts` renders one additional system-prompt clause, only when this field is
  present: *"This observation follows a click that appears to have opened a new panel, drawer, or
  overlay. Prioritise elements newly introduced by that action over background page controls, and
  treat the previous page's content as no longer the primary context."* This is the direct fix
  for "the engine did not confidently understand the newly opened surface" — the model is
  explicitly told a surface just opened, instead of inferring it (or failing to) from raw element
  diffs alone.
- The prompt's existing element-selection budget (already `activeDialog`-aware per §18) is
  extended to also de-prioritise `covered`/background elements when `surfaceChangeContext` is
  present but `activeDialog` is not — i.e. the non-ARIA drawer case gets the same prompt-budget
  treatment the ARIA modal case already gets.

### 3. Replace fixed timing with readiness detection

Current: `click → waitForTimeout(250ms) → observe`, unconditionally
(`src/actions/click.ts` lines ~694/743, `PAGE_SETTLE_DELAY_MS`).

**Readiness strategy**: generalise the existing bounded, polling
`waitForInteractionSideEffect` (today invoked only inside the `"intercepted"`-error recovery
path, polling every 100ms up to `CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS = 1000ms`) into the *normal*
post-click path for every click:

```
click dispatched
  -> poll every ~75-100ms, up to a fixed ceiling (reuse 1000ms, same constant already proven safe)
       exit early the moment classifySurfaceChange(...) != "none"   (fast path: surface confirmed)
       exit early once a MutationObserver-based mutation-quiet window elapses
           (no DOM mutation for 2 consecutive polls -> "settled", generic, no selector)
       exit on navigation (frame "framenavigated"/"load" event) -> defer to existing robustGoto handling
  -> hard ceiling reached -> proceed anyway (never an unbounded wait)
  -> floor: never less than today's 250ms for a click that produces no detectable change at all,
     so a plain, no-side-effect click's timing is unchanged from today
```

This keeps the same bounded philosophy as `MAX_STALE_TARGET_RECOVERY_ATTEMPTS`/
`CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS`: a hard ceiling, never a hidden/unbounded wait,
env-non-configurable (matching `PAGE_SETTLE_DELAY_MS`'s own documented rationale). `navigate`,
`scroll`, and `wait` actions are explicitly **out of scope** — they keep `PAGE_SETTLE_DELAY_MS`
unchanged; only the `click` path (where a drawer/modal is actually triggered) changes.

### 4. Low confidence recovery

Today: `low_confidence` → one same-observation corrective retry → `stop_blocked` fallback
→ bounded `go_back` (journey replanning).

**New, narrowly-scoped recovery step, inserted before falling to `stop_blocked`:**

- `ClaudeReasoningProvider` marks a fallback `stop_blocked` decision with *why* it fell back
  (new internal field, not wire-schema: `Decision.fallbackReason?: "low_confidence" | ...`) —
  today this information exists transiently as `outcome.reason` but is discarded once the
  fallback decision is constructed.
- `src/core/loop.ts`: when a `low_confidence`-caused fallback occurs **and** the immediately
  preceding step detected a surface change (`surfaceChangeContext` was set), this is diagnosed
  as exactly the Nissan failure mode — do **one** additional bounded recovery cycle instead of
  immediately treating it as `stop_blocked`:
  1. Re-run the readiness wait (in case the drawer was still animating/settling).
  2. Force a fresh `buildObservation()`.
  3. Ask the reasoning layer again, against this new observation — not a retry of the same
     stale prompt, a genuinely new one.
- This is capped at **once per decision-point fingerprint**
  (`RunState.lowConfidenceRetriedFingerprints: Set<string>`, keyed by the existing
  `computeDecisionPointFingerprint`) — prevents a low-confidence loop from spending unbounded
  extra reasoning calls if the same ambiguous surface keeps recurring.
- If the fresh-observation retry is *also* `low_confidence`, or the trigger condition doesn't
  apply (no surface change was detected), fall through to the existing `stop_blocked` → journey
  replanning path, unchanged.
- `RunState.consecutiveLowConfidenceCount` (mirrors `consecutiveStaleTargetFailures`) is tracked
  for diagnostics and reset on any accepted decision, so a run that oscillates in and out of low
  confidence is visible in `captures.errors` without needing a new ceiling — `maxSteps` and the
  existing journey-replanning ceiling remain the actual hard stops.

### 5. Alternative route exploration

This is the reactive counterpart Branch Exploration doesn't cover. Branch Exploration (§17) is
**forward-looking**: it activates *before* a click, when the decision point is ambiguous. What's
missing is **backward-looking**: after retreating (`go_back`) from a failed/low-confidence
candidate, try a *different* sibling candidate at that same decision point instead of only
retreating further or stopping.

Design, built entirely on existing mechanisms (Route Memory's fingerprint/candidate identity,
journey replanning's `go_back` substitution and ceiling — no new memory, no new action):

- When the existing journey-replanning substitution (`stop_blocked` → `go_back`) fires, and the
  substituted `go_back` lands back at the *same* decision-point fingerprint the failing candidate
  was chosen from (verified via `computeDecisionPointFingerprint`, the same fingerprint-verify
  technique Branch Exploration's own multi-hop return already uses), record
  `RunState.pendingAlternativeExploration = { originFingerprint, exhaustedCandidateIds: [...] }`.
- On the next `obtainDecision` call at that fingerprint:
  - The existing Route Memory prompt context (`routeMemory` field, already showing tried
    candidates + `lastOutcome`) gets one additional, situational system-prompt clause specific to
    this state: *"The candidate you just tried did not lead to progress. Do not re-select it —
    choose a different visible control that could plausibly serve the same objective (e.g. a
    sibling call-to-action), before considering the objective unreachable from this page."* This
    is advisory, consistent with Route Memory's existing observe-and-inform design.
  - **One new, narrowly-scoped hard rule** (the only non-advisory addition in PR 1C):
    `validateClaudeDecision.ts` rejects a `click` decision whose `computeCandidateIdentity` exactly
    matches an id in `pendingAlternativeExploration.exhaustedCandidateIds` at the *same*
    fingerprint, with a new reason `repeated_exhausted_candidate`. This is added to
    `CORRECTIVE_RETRY_CATEGORIES` (one corrective retry, exactly like `low_confidence` and
    `consent_policy_violation` get today) before falling through. This directly enforces
    "bounded exploration" per the requirement — advisory guidance alone is what the Nissan
    investigation shows was insufficient to change behaviour reliably.
  - `pendingAlternativeExploration` is a **one-shot** state: it clears the instant a *different*
    candidate is dispatched from that fingerprint (success or failure), or the instant the
    fingerprint is left. It is never a persistent blacklist beyond that single recovery window.
- **Bounded by construction, no new ceiling**: this reuses `MAX_JOURNEY_REPLANNING_ATTEMPTS` (2)
  exactly as-is — the same budget that already gates every `stop_blocked`→`go_back` substitution.
  A sibling-candidate attempt consumes one of those two attempts, same as a plain retreat would
  have. This avoids introducing a second, independently-tunable "give the model more chances"
  budget that could combine with the existing one to quietly exceed what a task's
  `maxSteps`/`maxBacktracks` were sized for.
- If the newly-chosen sibling candidate is itself ambiguous or leads several steps deep, it enters
  Branch Exploration's own existing entry condition and bounded depth/return machinery completely
  unmodified (see "Relationship with existing systems" below) — PR 1C does not duplicate that
  logic.

### 6. Relationship with existing systems

| System | Treatment in PR 1C |
|---|---|
| **Branch Exploration** (§17) | **Reused unchanged.** Its entry condition, depth/candidate-budget math, and fingerprint-verified return are pre-dispatch/forward-looking and orthogonal to this PR's reactive, post-failure sibling-candidate nudge. A sibling candidate chosen via §5 above is dispatched as an ordinary candidate and can itself trigger branch entry through the exact same code path any other candidate would. |
| **Route Memory** (§16) | **Reused, extended from purely advisory to one narrowly-scoped enforced check** (`repeated_exhausted_candidate`, §5). `getTriedCandidates`/fingerprint/candidate-identity machinery is used as-is; no new memory structure. |
| **Journey Replanning** (§"Bounded journey replanning") | **Reused and given a second responsibility.** The same `stop_blocked`→`go_back` substitution and `MAX_JOURNEY_REPLANNING_ATTEMPTS` ceiling now also carries the alternative-route nudge/guard, rather than a separate budget. |
| **Safety Layer** | **Unchanged hard guardrails** (domain, maxSteps/maxBacktracks, payment/personal-data/form-submission locks). Gains exactly one new decision-level rejection reason (`repeated_exhausted_candidate`), validated the same way `consent_policy_violation` already is — not a new category of guardrail. |

## Flow Diagram

```
click dispatched
   |
   v
readiness poll (bounded, mutation/dialog/panel-aware; replaces fixed 250ms)
   |
   v
classifySurfaceChange(before, after, target)
   |
   +-- "none" --------------------------------------> buildObservation() (unchanged path)
   |
   +-- dialog_appeared / layer_panel_appeared / elements_appeared
         |
         v
   buildObservation() with surfaceChangeContext set
         |
         v
   reasoning layer decide() -- prompt now says "a new surface just opened, prioritise it"
         |
         +-- confident decision --------------------------------> dispatch as normal
         |
         +-- low_confidence (validateClaudeDecision)
               |
               v
         ClaudeReasoningProvider corrective retry (same observation, existing behaviour)
               |
               +-- now confident -----------------------------> dispatch as normal
               |
               +-- still low_confidence, fallback stop_blocked, fallbackReason="low_confidence"
                     |
                     v
               was surfaceChangeContext set AND fingerprint not yet retried?
                     |
                     +-- yes --> re-poll readiness --> fresh buildObservation() --> decide() again
                     |              |
                     |              +-- confident -----------------> dispatch as normal
                     |              +-- still low_confidence --------v
                     |
                     +-- no ----------------------------------------v
                                                                     |
                                                                     v
                                                    existing journey-replanning check
                                                    (MAX_JOURNEY_REPLANNING_ATTEMPTS)
                                                                     |
                                                    +-- attempts remaining --> substitute go_back
                                                    |         |
                                                    |         v
                                                    |   land back at origin fingerprint?
                                                    |         |
                                                    |         v
                                                    |   set pendingAlternativeExploration
                                                    |   (exhaustedCandidateIds += failed candidate)
                                                    |         |
                                                    |         v
                                                    |   next decide() at this fingerprint:
                                                    |     - prompt nudges toward a sibling candidate
                                                    |     - re-selecting exhausted candidate is
                                                    |       rejected (repeated_exhausted_candidate,
                                                    |       one corrective retry)
                                                    |         |
                                                    |         +-- sibling candidate chosen --> dispatch
                                                    |         |     (may itself enter Branch Exploration)
                                                    |         +-- no valid alternative found -->
                                                    |               loop back to journey-replanning check
                                                    |
                                                    +-- attempts exhausted --> honour stop_blocked (terminal)
```

## Files Impacted

- `src/observation/observationBuilder.ts` — `classifySurfaceChange` (extends
  `detectTargetAttributableSideEffect`), layer/panel heuristic, `Observation.surfaceChangeContext`.
- `src/actions/click.ts` — readiness polling replaces unconditional `PAGE_SETTLE_DELAY_MS` on the
  click path; runs `classifySurfaceChange` on every successful click, not only intercepted ones.
- `src/core/robustNavigation.ts` — unchanged; `PAGE_SETTLE_DELAY_MS` remains as-is for
  `navigate`/goto.
- `src/reasoning/promptBuilder.ts` — surface-change prompt clause; sibling-candidate nudge clause.
- `src/reasoning/reasoningProvider.ts` — `ReasoningContext` gains optional
  `surfaceChangeContext`/`pendingAlternativeExploration` fields (internal boundary type, no wire
  schema impact, matching Route Memory's own precedent in §16).
- `src/reasoning/validateClaudeDecision.ts` — new `repeated_exhausted_candidate` rejection reason.
- `src/reasoning/claudeReasoningProvider.ts` — `CORRECTIVE_RETRY_CATEGORIES` gains
  `repeated_exhausted_candidate`; fallback decisions carry `fallbackReason`.
- `src/core/loop.ts` — wiring for all of the above: post-click surface handling, low-confidence
  fresh-observation recovery, `pendingAlternativeExploration` bookkeeping.
- `src/core/state.ts` — new `RunState` fields: `consecutiveLowConfidenceCount`,
  `lowConfidenceRetriedFingerprints`, `pendingAlternativeExploration`.
- `src/core/routeMemory.ts` / `src/core/branchExploration.ts` — reused as-is; at most a small
  helper to query "tried candidates at fingerprint excluding id X" if not already expressible via
  `getTriedCandidates`.
- `schemas/task-response.schema.json` — additive: `Observation.surfaceChangeContext`,
  `ActionResult`/`StepLog` diagnostics for the new safety-flag values
  (`surface_change_detected`, `low_confidence_reobservation`, `alternative_route_attempted`,
  `repeated_exhausted_candidate`) via the existing free-form `safetyFlags`/`decision` fields
  (no new enum needed there, matching §"Bounded journey replanning"'s own precedent) —
  `schemaVersion` bump (additive only, e.g. `1.13.0` → `1.14.0`).
- `docs/architecture.md` — new `§19` documenting this mechanism, per this repo's existing
  convention of documenting every new mechanism in the same change that ships it.
- Tests (see Test Strategy below).

## Risk Assessment

- **Readiness-polling false-early-exit**: a page with continuous ad/analytics-driven DOM churn
  could never reach a "mutation-quiet" state. Mitigated by the same bounded-ceiling philosophy as
  `CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS` — capped at 1000ms regardless, never unbounded, and a
  detected dialog/panel still exits early and correctly regardless of ongoing unrelated churn.
- **Layer/panel heuristic false positives**: a wide sticky promo bar or cookie banner could be
  misclassified as a drawer. Mitigated by requiring co-occurrence with ≥1 newly-appeared
  interactive element (never a CSS-only signal alone) — same guard `elements_appeared` already
  uses.
- **New hard rule (`repeated_exhausted_candidate`) is the one non-advisory change** in an
  otherwise advisory-only phase. Risk: a candidate that failed for a transient, genuinely
  retriable reason (e.g. a one-off network blip) gets permanently excluded within that recovery
  window. Mitigated by scoping the exclusion strictly to the one-shot
  `pendingAlternativeExploration` window (cleared the instant any other candidate is dispatched
  from that fingerprint), never a run-wide blacklist, and by giving the model one corrective retry
  before the rejection becomes a `stop_blocked` fallback.
- **Cost/latency**: one extra bounded reasoning-provider call in the low-confidence recovery path,
  strictly capped once per fingerprint. No change to steady-state cost for runs that never hit a
  surface change or low confidence.
- **Schema churn**: another additive `schemaVersion` bump, consistent with 13 prior additive
  bumps in this repo; requires the `ajv-cli` revalidation step in `CLAUDE.md` after editing
  examples.
- **Interaction with existing overlay-click detection (§18)**: `classifySurfaceChange` generalises
  `detectTargetAttributableSideEffect` rather than replacing it — the existing
  `fallbackVerified`/`clickSideEffectDetected` semantics and the target-attribution requirement
  (never a bare whole-page mutation) must be preserved exactly for the intercepted-click recovery
  path that already depends on them; this needs explicit regression coverage (see Test Strategy).

---

# PR 1D ARCHITECTURE

## Problem

Milestone evaluation (`src/core/successEvaluator.ts`, `docs/architecture.md` §17's objective
milestone rollup, `MilestoneEvidenceRecord`) is already evidence-based in shape —
`evidenceSource`, `score`, `matchedValue` are all recorded per satisfied criterion — but:

1. There is no explicit, enforced distinction between a **mechanically observed** fact
   (`url_pattern`, `element_present`, a `dataLayer`/network event) and an **inferred** judgement
   (`semantic_page_match`, especially its `SemanticCriterionVerifier` sub-path, which is an LLM
   call). Both currently look the same to a caller reading `diagnostics.milestoneEvidence`.
2. Nothing formalises or tests the invariant that a milestone can *never* be satisfied by mere
   model self-report/confidence with no independent corroborating evidence (an "assumed" tier) —
   this happens to be true today by construction, but it is not stated or enforced anywhere, so a
   future change (including PR 1C's own new recovery paths) could accidentally introduce exactly
   that failure mode without anyone noticing.
3. A `semantic_page_match` criterion evaluated immediately after PR 1C's new surface-change
   detection has no way to scope its evidence to the *newly-appeared* surface specifically — it
   could be satisfied by leftover background-page vocabulary that was never actually inside the
   drawer/panel that (allegedly) opened, producing a false milestone completion that looks
   identical, in the response, to a real one.
4. `score` is populated only for the semantic path today; there's no uniform confidence signal
   across all evidence types for a caller to audit.

## Design

All changes below are additive to `MilestoneEvidenceRecord`/`EngineAssessment` and, in the first
shipped increment, **observability-only** — no criterion that would have been satisfied before is
withheld, and no criterion that would not have been satisfied before newly satisfies. Tightening
actual satisfaction behaviour (item below marked "follow-up") is deliberately deferred to a
separate, later change once production evidence justifies the stricter bar — matching this repo's
established deliberate-deferral discipline (§16/§17/§18).

1. **`MilestoneEvidenceRecord.evidenceTier: "observed" | "inferred" | "assumed"`** — computed
   deterministically from the already-existing `evidenceSource` string, not a new judgement call:
   - `"observed"`: `url_pattern`, `element_present`, `data_layer_event`, `network_event` — a
     direct mechanical DOM/URL/event read, no LLM in the loop at all.
   - `"inferred"`: `semantic_page_match:deterministic` (lexical vocabulary-overlap — a
     deterministic algorithm, but over fuzzy textual similarity, not a literal fact) and
     `semantic_page_match:verifier` (an actual model judgement call, `SemanticCriterionVerifier`).
   - `"assumed"`: reserved, structurally unused today — see the invariant test below.
2. **Enforced invariant, not just documentation**: a new test
   (`tests/unit/milestoneEvidenceTiers.test.ts`) asserts that `RunState.satisfiedCriteriaIds`
   never gains an entry without a corresponding `MilestoneEvidenceRecord` whose `evidenceTier` is
   `"observed"` or `"inferred"` — i.e. "a milestone is never satisfied on assumption alone" becomes
   a codified, CI-enforced property of `evaluateSuccessCriteria`, not merely a convention.
3. **Uniform confidence score across tiers**: `MilestoneEvidenceRecord.score` is populated for
   every satisfied criterion, not only semantic ones — `1.0` for every `"observed"` entry (a
   mechanical match is unambiguous), and the existing deterministic-overlap/verifier-confidence
   value for `"inferred"` entries. This lets a caller sort/filter `diagnostics.milestoneEvidence`
   by confidence uniformly.
4. **Surface-scoped semantic evidence (depends on PR 1C)**: when a `semantic_page_match`
   criterion is evaluated in the same step as a detected `surfaceChangeContext` (PR 1C), its
   candidate evidence pool (`gatherSemanticPageSignals`, `src/core/semanticPageMatch.ts`) is
   scoped to the newly-appeared element set from that surface change, not the whole page — mirror
   of the existing `activeDialog`-aware exclusion of persistent nav chrome (§17's ordering fix),
   applied here to drawers/panels that don't carry `role="dialog"`. This directly prevents a
   milestone being "satisfied" by leftover background-page text when the drawer that was supposed
   to satisfy it never actually rendered the relevant content.
5. **`EngineAssessment.evidenceTierSummary: { observedCount, inferredCount, assumedCount }`** —
   an additive rollup so a caller can audit, at a glance, whether a run's success rests on hard
   observed facts or partly on inferred semantic judgement, without walking
   `diagnostics.milestoneEvidence` by hand. `assumedCount` is always `0` today (enforced by the
   invariant above) — its presence in the schema is what makes that absence auditable rather than
   merely asserted in a doc comment.
6. **Follow-up, explicitly out of scope for this PR**: introducing a stricter
   `MIN_SEMANTIC_MILESTONE_SCORE_FOR_REQUIRED` threshold (a required milestone needing a higher
   overlap/confidence score than an optional one before being marked satisfied — mirroring the
   existing `MIN_DOMINANT_RELEVANCE_SCORE` = 0.5 pattern already used for branch-entry ambiguity
   in `src/discovery/relevance.ts`). Deferred until the observability shipped here surfaces real
   production evidence of where false-positive semantic matches actually cluster, so the
   threshold is tuned against data rather than guessed — the same discipline that shaped
   `MIN_DOMINANT_RELEVANCE_SCORE` itself (§17's own iteration history).

## Flow Diagram

```
evaluateSuccessCriteria() called (pre_action / post_action phase)
   |
   v
for each eligible criterion (ordered milestone constraint unchanged, §17):
   |
   +-- url_pattern / element_present / data_layer_event / network_event
   |        |
   |        v
   |   satisfied? --yes--> MilestoneEvidenceRecord { evidenceTier: "observed", score: 1.0 }
   |
   +-- semantic_page_match
            |
            v
       was a surfaceChangeContext set this step? (PR 1C)
            |
            +-- yes --> scope gatherSemanticPageSignals() to newly-appeared elements only
            +-- no  --> scope to whole page (unchanged behaviour)
            |
            v
       deterministic lexical overlap score computed
            |
            +-- clears threshold --> MilestoneEvidenceRecord
            |                          { evidenceTier: "inferred",
            |                            evidenceSource: "semantic_page_match:deterministic",
            |                            score: <overlap> }
            |
            +-- does not clear, semanticVerifier configured -->
                     |
                     v
               SemanticCriterionVerifier.verify() (existing, unchanged)
                     |
                     +-- satisfied --> MilestoneEvidenceRecord
                     |                   { evidenceTier: "inferred",
                     |                     evidenceSource: "semantic_page_match:verifier",
                     |                     score: <verifier confidence> }
                     +-- not satisfied --> criterion remains unsatisfied (unchanged)

run ends
   |
   v
EngineAssessment.evidenceTierSummary = rollup of milestoneEvidence[].evidenceTier
   (assumedCount structurally always 0 -- enforced by tests/unit/milestoneEvidenceTiers.test.ts)
```

## Files Impacted

- `src/core/successEvaluator.ts` — `evidenceTier` computation from `evidenceSource`; uniform
  `score` population; surface-scoped evidence pool wiring (soft dependency on PR 1C's
  `surfaceChangeContext` — degrades gracefully to whole-page scoping if absent).
- `src/core/semanticPageMatch.ts` — optional "scope to these elements only" parameter to
  `gatherSemanticPageSignals`.
- `src/types/task-response.ts` — `MilestoneEvidenceRecord.evidenceTier`; `EngineAssessment.
  evidenceTierSummary`.
- `schemas/task-response.schema.json` — additive fields; `schemaVersion` bump.
- `docs/n8n-integration.md` §9f/§9g — caller-facing guidance update: how to read `evidenceTier`
  and `evidenceTierSummary`.
- `docs/architecture.md` — new subsection under §17 (or a new §20) documenting this.
- `tests/unit/milestoneEvidenceTiers.test.ts` (new) — the enforced invariant described above.
- `tests/integration/orderedMilestoneEnforcement.test.ts`,
  `tests/integration/requiredSuccessCriteriaEnforcement.test.ts`,
  `tests/integration/semanticSuccessCriteria.test.ts`,
  `tests/integration/semanticMultilingualEnforcement.test.ts` — extended, not replaced, to assert
  `evidenceTier`/`score` on existing fixtures without changing existing satisfaction assertions.

## Risk Assessment

- **Behaviour-change risk is deliberately deferred**: shipping evidence-tiering as
  observability-only (no new satisfaction gate) means this PR cannot regress any currently-passing
  run's success/failure outcome. The stricter-threshold follow-up (item 6) is where that risk
  would actually be taken on, explicitly later and separately.
- **Sequencing dependency on PR 1C**: surface-scoped evidence (item 4) needs PR 1C's
  `surfaceChangeContext`. Designed to degrade gracefully (whole-page scoping, today's behaviour)
  if PR 1C hasn't landed yet, so PR 1D is not hard-blocked on PR 1C, but is recommended to ship
  after it (see Implementation Order) so the surface-scoping behaviour can be validated together
  against the drawer fixture PR 1C introduces.
- **Schema churn**: another additive bump; re-run the `ajv-cli` validation from `CLAUDE.md` after
  updating examples.
- **False sense of rigor**: `evidenceTier` must not be mistaken for a guarantee that "inferred"
  evidence is reliable — it only classifies *how* evidence was obtained, not its correctness. The
  doc/schema description must say this plainly so callers don't over-trust an `"inferred"` entry
  simply because it now has a formal label.

---

# PHASE 2 IMPLEMENTATION ORDER

## Recommended sequence

1. **PR 1C-a — Post-click readiness + surface-change classification.**
   `classifySurfaceChange` (extends `detectTargetAttributableSideEffect`), readiness polling
   replacing `PAGE_SETTLE_DELAY_MS` on the click path, `Observation.surfaceChangeContext`, prompt
   clause. Pure observation/timing improvement — no decision-making behaviour change yet. Lowest
   risk, independently testable against the existing overlay/modal fixtures
   (`tests/integration/overlayClickDetection.test.ts`, `modalAwareScroll.test.ts`), ship first.
2. **PR 1C-b — Low-confidence fresh-observation recovery.** Depends on 1C-a's
   `surfaceChangeContext` signal to decide when the extra recovery cycle is warranted. Small,
   strictly bounded (once per fingerprint).
3. **PR 1C-c — Alternative route exploration / sibling-candidate guard.** Depends on 1C-a/b's
   context. Introduces the phase's one non-advisory rule (`repeated_exhausted_candidate`) — ships
   last within PR 1C, with the richest test coverage, since it's the highest-behavioural-impact
   piece.
4. **PR 1D-a — Evidence-tier classification (observability-only).** Soft dependency on PR 1C's
   surface-change signal (degrades gracefully without it); recommended after PR 1C so surface-
   scoped evidence can be validated against the same drawer fixture.
5. **PR 1D-b (explicit future work, not this phase)** — tightening the required-milestone
   semantic threshold using production data gathered from 1D-a. Not scheduled; flagged so it
   isn't silently assumed to be included in Phase 2.

## Test strategy

- **New unit tests**: `classifySurfaceChange` (dialog/panel/elements/none classification against
  synthetic before/after snapshots, including the "sticky bar with no new controls" negative
  case), the readiness-polling bound (fixture page with controlled mutation timing), fresh-
  observation low-confidence recovery bookkeeping (`RunState.lowConfidenceRetriedFingerprints`
  one-shot behaviour), `repeated_exhausted_candidate` rejection in `validateClaudeDecision.ts`,
  and `tests/unit/milestoneEvidenceTiers.test.ts` (the "never assumed" invariant).
- **New integration fixture**: a local HTML fixture page with a plain CSS/JS drawer (no
  `role="dialog"`/`aria-modal`) triggered by a click, alongside a sibling CTA that leads to the
  actual objective — mirroring how existing fixtures already model the ARIA-modal case
  (`overlayClickDetection.test.ts`) and the ambiguous-candidate case (`branchExploration.test.ts`).
  This is the fixture that directly exercises the Nissan-shaped failure path end-to-end.
- **Regression suites to re-run in full after every sub-PR** (these are the systems being
  extended, not replaced): `tests/integration/journeyReplanning.test.ts`,
  `tests/integration/branchExploration.test.ts` + `tests/unit/branchExploration.test.ts`,
  `tests/integration/routeMemory.test.ts`, `tests/integration/routeProgressClassification.test.ts`,
  `tests/integration/overlayClickDetection.test.ts`, `tests/integration/fallbackVerification.test.ts`,
  `tests/integration/modalAwareScroll.test.ts`, `tests/integration/orderedMilestoneEnforcement.test.ts`,
  `tests/integration/requiredSuccessCriteriaEnforcement.test.ts`,
  `tests/integration/semanticSuccessCriteria.test.ts`,
  `tests/integration/semanticMultilingualEnforcement.test.ts`, `tests/unit/consentPolicyGuard.test.ts`
  (confirms the new `CORRECTIVE_RETRY_CATEGORIES` entry doesn't disturb the existing
  `consent_policy_violation` retry path), `tests/unit/claudeReasoningProvider.test.ts`.
- **Schema validation**: re-run the `ajv-cli` command from `CLAUDE.md` after each `schemaVersion`
  bump, against every file in `/examples`.
- **Manual/production-shaped validation**: the repo's existing
  `.github/workflows/manual-claude-full-local-journey.yml` smoke workflow, run against the new
  drawer fixture and, if available in a safe non-production form, a Nissan-shaped page — the
  concrete acceptance bar is that the originally observed sequence (`View Offer Details` →
  `low_confidence` → `go_back` → `go_back` → `stop_blocked`) no longer reproduces, and instead
  either succeeds via the reopened surface or via a sibling CTA, or fails with a materially
  different, evidence-rich `stop_blocked`/`stop_failure` reason.

## Regression validation plan

- Every sub-PR must leave all pre-existing tests green with **zero** assertion changes to tests
  that don't touch the new mechanisms — any pre-existing test needing a change is a signal the
  new code path is not as narrowly scoped as designed above, and should be re-examined before
  merging rather than the test being "fixed" to match.
- Because PR 1C-c is the only sub-PR introducing a hard (non-advisory) rule, it gets a dedicated
  false-positive check: run the full existing test suite plus the new drawer fixture, and confirm
  no existing ambiguous-candidate scenario (`branchExploration.test.ts`'s tie-detection regression
  case, in particular) is newly affected by `repeated_exhausted_candidate` — that guard must only
  ever fire inside an active `pendingAlternativeExploration` window, never in ordinary branch
  exploration.
- PR 1D-a's invariant test (`milestoneEvidenceTiers.test.ts`) should be added and passing
  **before** PR 1C ships, not after — it protects PR 1C's own new recovery paths (which touch
  decision-making, not milestone evaluation directly, but are exactly the kind of change that
  could accidentally introduce an "assumed" satisfaction path if a future iteration got sloppy)
  from ever regressing this guarantee.
- Final Phase 2 sign-off: confirm `schemas/task-request.schema.json` needs no change at all (every
  change in this phase is response-side/internal), and that `schemas/task-response.schema.json`'s
  cumulative `schemaVersion` bumps across PR 1C/1D are each independently additive per this repo's
  established convention (documented in the schema's own `schemaVersion` description field, per
  existing precedent).
