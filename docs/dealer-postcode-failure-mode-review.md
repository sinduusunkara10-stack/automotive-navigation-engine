# Dealer postcode workflow: failure-mode review

Scope: the lead-form `dealer_search` path in `src/actions/dealerLookup.ts`,
`src/actions/dealerLookupNetwork.ts`, `src/actions/dealerLookupProbe.ts` and `src/actions/fillForm.ts`.
Written for response schema `1.50.0` (request `1.48.0`). Everything here is generic. It has no brand,
market, URL, field-name or selector dependency (Phase 8 grep: no hits outside the central
multilingual vocabularies).

## 1. Confirmed root cause of the repeated live failures

The live traces could not tell us whether a lookup request was ever sent. The reason is that
`dealerLookupNetwork.ts` kept only the first 5 requests. Those 5 slots filled up with tracking
and configuration requests within about 412 ms of the capture starting, and every later request
was dropped. So "no request after 412 ms" was an artifact of the cap. It was never an observation
about the page. Every fix in PRs #88 to #90 was therefore made without seeing the one request that
mattered.

Five behavioural gaps were also proven from the code. Any one of them can leave a real widget
unresolved:

1. **Synthetic input.** The keydown/keyup events had no `key`, and `blur()` ran straight after
   `fill()`. A debounced autocomplete that keys off real keystrokes, or that cancels on blur, never
   fired.
2. **Trigger first.** When a trigger existed, it was clicked before any keyboard activation. The
   live trigger is a textless, type-less `<button>` (default `type=submit`), which matches the
   shape of a locate-me control. Clicking it cannot search for the typed value. It can also
   implicitly submit the lead form, and so can pressing Enter.
3. **Commit by text.** Text changes were accepted as a commit in the stage 1, stage 3 and
   auto-populate branches. PR #90 closed only one of these.
4. **Hidden-field comparison by position.** Inserting any hidden input shifted every index after
   it, so a commit was misattributed or missed.
5. **Discovery holes.** These were:
   - hidden pre-rendered options that were marked as baseline and so never matched later;
   - plain div/span portal results that were never found;
   - stage-1 sibling results that were re-clicked as "dealer results", replacing the verified choice;
   - an unlabelled field in a CSS-less layout that lost the textless trigger to a visually nearer
     field (`TRIGGER_FIELD_ANCESTOR_HOP_WEIGHT` too small), so the postcode was typed into
     "First name";
   - retries that never ran: the field already held the value, so the re-plan classified it as
     "prefilled" and `rerunDealerSearch` returned without doing anything.

## 2. Postcode-to-submission sequence (as implemented)

1. **Input.** `focus` → `fill("")` → `pressSequentially` (35 ms per key) → the probe verifies the
   value was retained → `fill()` fallback only if it was not. No blur.
2. **Activation ladder.** Each rung is recorded as a `DealerActivationStepRecord`:
   - `observe_auto_lookup`
   - `press_arrowdown`
   - `press_enter`
   - `press_tab`
   - `click_trigger`. This step is skipped when the trigger's own name, title, id or class matches
     the geolocation vocabulary.

   The ladder stops climbing as soon as any of these is seen: a lookup-like request, a busy state,
   `aria-expanded=true`, or a result. It never climbs while a lookup request is still pending.
   Throughout the lookup, a window-capture submit guard swallows implicit lead-form submission
   (from Enter or a type-less button). The lookup never re-enters the value.
3. **Network.** Every xhr, fetch, script, ping, image, other and eventsource request is
   classified, up to 80 internally. The output lists non-tracking requests first and at most 3
   tracking requests. Each entry records:
   - endpoint pattern, method, status, content type and duration;
   - XML root, recurring element names and record count;
   - result category and purpose;
   - the activation step it followed, and whether an observable DOM change came after it.

   No request or response body is kept.
4. **Discovery tiers** for location suggestions, in order:
   1. in-scope ARIA or native results;
   2. in-scope generic new elements (never dismiss or clear controls, links or editable fields);
   3. page-wide new ARIA results, including open shadow DOM;
   4. the field-anchored probe: `aria-controls` / `aria-owns` / `list` targets, mutated portal
      roots within 450 px, and hidden-then-visible elements;
   5. same-origin child frames.
5. **Location selection.** Siblings are retired before the click. Commit is
   `waitForSelectionCommit`, which polls for up to 1.5 s for either the element's own
   checked / selected / pressed state or a keyed hidden-identifier commit.
6. **Confirm control.** An optional distinct confirm control, then dealer results get their own
   bounded wait.
7. **Dealer selection** uses the same commit rule. Auto-populate is accepted only when a hidden
   dealer or location identifier is committed.
8. **Readiness gate (unchanged).** Every required field, the dealer dependency and the consent
   groups must be resolved, or Submit is never clicked.
9. **Submit.**
   - A disabled control gets one final blur and up to 1.5 s, and is never clicked while it stays
     disabled.
   - The confirmation-marker baseline is taken before the click.
   - The click has a 10 s cap.
   - The outcome is classified as one of: `succeeded`, `validation_failed`, `server_rejected`,
     `blocked_or_rate_limited`, `server_error`, `unconfirmed`, `cancelled_unknown_cause` or
     `cancelled_before_request`.
10. **Retry.** This happens only when `retryRecommendation` is `await_pending_lookup`, meaning a
    lookup request was still in flight. The retry re-polls without re-typing and without
    re-triggering. Every other unresolved lookup stops with `lookupFailureClassification` and
    `lookupFailureExplanation`.

## 3. Pre-mortem: every predicted failure mode

The Status column uses three values:

- **Fixed:** a code change in this PR.
- **Diagnosed:** the engine now names it precisely but cannot resolve it.
- **Unsupported:** stops safely but undiagnosed beyond a generic classification.

| # | Failure mode | Existing protection (before) | Missing protection | Test coverage | Change made | Residual risk | Status |
|---|---|---|---|---|---|---|---|
| 1 | Lookup request crowded out of evidence by tracking | first-5 cap | everything after slot 5 | XML records test (8 beacons + config) | 80 internal, non-tracking first, tracking capped at 3 in output | >80 requests in one lookup | Fixed |
| 2 | Debounced autocomplete cancelled by blur / keyless events | none | real typing, keep focus | German portal fixture | `pressSequentially`, no blur, observe step | widget needing paste/IME events | Fixed |
| 3 | Field value rejected or reformatted by mask | none | retention check | `fieldValueRetainedAfterInput` asserted | probe retention check → `fill()` fallback → `field_value_not_retained` | mask that reformats to a different but valid value reads as not retained | Fixed |
| 4 | Lookup needs Enter / ArrowDown / Tab | Enter only, without a trigger | ordered keyboard ladder | Dutch Enter fixture | ladder with per-step evidence | widget needing a different key | Fixed |
| 5 | Enter or type-less trigger implicitly submits the lead form mid-lookup | none | submit guard | Dutch + geolocation fixtures (`__prematureSubmits`/`__formSubmitted` = 0) | probe window-capture submit/click guard, `implicitSubmitBlockedCount` | site JS submitting via `form.submit()` from a keydown handler (bypasses the event) | Fixed |
| 6 | Trigger is a locate-me control | none | classification | geolocation fixtures (textless and hinted) | geolocation vocabulary skip; runtime `getCurrentPosition` counter; `trigger_requested_geolocation_and_nothing_else_reacted` | textless control with no hint is still clicked once (needed for textless search icons); its effect is then recorded | Fixed + Diagnosed |
| 7 | Trigger associated with the wrong field | combined hop+pixel score | DOM structure priority | XML fixture (unlabelled field, nearer "First name") | `TRIGGER_FIELD_ANCESTOR_HOP_WEIGHT = TRIGGER_FIELD_MAX_PIXEL_DISTANCE` (hops dominate, pixels tie-break) | trigger nested deeper than an unrelated field in the same wrapper | Fixed |
| 8 | Lookup request fails (4xx/5xx/network) | none | classification | 500 test | `lookup_request_failed` | none beyond reporting | Diagnosed |
| 9 | Lookup returns empty / error XML with HTTP 200 | none | structure classification | empty + error XML tests | `empty_results` / `validation_error` purpose → `lookup_request_returned_empty_results`, not retried | JSON bodies only get key-name structure | Diagnosed |
| 10 | Lookup returns records but nothing renders | none | correlation | unit tests on record counts | `lookup_request_returned_records_but_no_result_rendered` | renderer in cross-origin frame / closed shadow root | Diagnosed |
| 11 | Lookup still in flight at the bounded wait | single extension | deterministic retry that does not reset | 11 s slow-request test (`__lookupRequests` = 1) | `await_pending_lookup` mode; retry plan falls back to original decision | request slower than ~2 retries × 9 s | Fixed |
| 12 | Retries reset the widget / re-run identical input | always re-ran | correction check | no-results + uncommitted tests (`formRetriesUsed` 0) | retry only on `await_pending_lookup` | none | Fixed |
| 13 | Results in a body portal as plain divs | none | portal discovery | German + Polish fixtures | probe mutated-root + proximity tier | portal >450 px from field | Fixed |
| 14 | Pre-rendered hidden listbox becomes visible | baseline excluded it forever | ARIA-linked tier | Spanish fixture | probe `aria-controls`/`list` tier | listbox not ARIA-linked and far away | Fixed |
| 15 | Results in a child frame | none | frame tier | iframe fixture | same-origin frame tier with frame baseline | cross-origin frames: unreachable by design | Fixed / Unsupported (x-origin) |
| 16 | Results in shadow DOM | none | piercing | (Playwright CSS pierces open roots) | page-wide tier | closed shadow roots; generic tier inside shadow roots | Unsupported (closed) |
| 17 | Next stage re-clicks a sibling of the selected result | none | sibling retirement | XML radios fixture (no `click_dealer_result`) | `retireVisibleStageResults` before stage-1 click | sibling rendered lazily after the click | Fixed |
| 18 | Selection only rewrites visible text | PR #90 (one branch only) | all branches | text-only fixture (submit never clicked) | element state or keyed hidden commit only | widget committing to JS memory with no DOM signal → stops safely | Fixed |
| 19 | Hidden input inserted on selection breaks positional diff | none | keyed state | unit `detectHiddenCommit` | keyed state + purpose classes; unrelated tokens never count | hidden identifier with no dealer/location token, inserted already populated → not a commit (safe) | Fixed |
| 20 | Location chosen, dealer list never appears | timeout only | classification | Polish fixture (success path) | `location_selected_but_no_dealer_result_or_commit` | none beyond reporting | Diagnosed |
| 21 | Field reports invalid | `aria-invalid` read | classification order | existing tests | `field_reported_invalid` | none | Diagnosed |
| 22 | Nothing reacts to anything | generic reason | per-step evidence | hinted geolocation test | `no_reaction_to_any_activation` with every step's counters | requires the reasoning fallback (deferred) | Diagnosed |
| 23 | Submit disabled until final blur/change | none (30 s click hang) | final commit event | final-blur fixture | blur + 1.5 s poll | control enabled by a different event | Fixed |
| 24 | Submit permanently disabled | none (30 s hang then throw) | prompt stop | permanently-disabled fixture (< 20 s) | `submitBlockedBeforeClick`, never clicked, never retried | none | Fixed |
| 25 | Client-side cancellation | PR #90 outcome | — | PR #90 tests | unchanged | — | Diagnosed |
| 26 | Server rejection (400/409/422) | grouped as cancelled | category | 422 test | `server_rejected` | none | Diagnosed |
| 27 | Anti-bot / rate limit (401/403/429) | grouped | category | 429 test | `blocked_or_rate_limited`; never retried | challenge served as 200 HTML | Diagnosed |
| 28 | Server error (5xx) | grouped | category | 503 test | `server_error` | none | Diagnosed |
| 29 | Success with no navigation / confirmation in modal, toast, portal | confirmation text anywhere | baseline | accepted-no-confirmation test | marker must newly appear (main + same-origin frames); otherwise `unconfirmed` | confirmation that uses no known vocabulary → `unconfirmed`, not failure | Fixed |
| 30 | Virtual page change, no URL change | URL only | new-marker check | as #29 | as #29 | as #29 | Fixed |
| 31 | Ambiguous consent group with empty question text | left unresolved | — | existing tests | none (no guessed consent) | a required group the page enforces silently | Unsupported |
| 32 | Multi-step / wizard form | Phase-1 limitation | — | — | none (deferred by owner) | — | Unsupported |
| 33a | ARIA result inserted between discovery tiers is reported as generic (outcome depends on poll timing) | none | tier-independent classification | delayed role="radio" test (failed under full-suite load before the fix) | generic tier re-checks the element against the ARIA/native selector | none | Fixed |
| 33b | Retry re-plan drops the dealer decision because the field is already "prefilled" (retries silently did nothing) | none | original decision reuse | 11 s slow-request test | `rerunDealerSearch` falls back to the original `dealer_search` decision | none | Fixed |
| 33c | Single-widget result clicked but never committed is reported as a location step | — | correct attribution | uncommitted-selection test | authoritative stage-1 result with no further stage → `selectable_result_found_but_commit_state_never_verified` | none | Fixed |
| 33 | PII in diagnostics | sanitiser | new fields | privacy test (postcode, names, hidden values, records) | names/counts/categories only; endpoint without query; no bodies | none known | Fixed |

## 4. Reasoning fallback decision

**Deferred, explicitly.** A reasoning step that picks a lookup control or result when the generic
ladder finds nothing would need one of two things:

- page text near the widget, which can include the typed postcode and dealer names that must
  never leave the page; or
- a new action outside the fixed vocabulary.

Neither is acceptable. The deterministic ladder plus a precise failure classification covers the
same ground safely. If a live run ends in `no_reaction_to_any_activation` with zero lookup-like
requests, that is the evidence needed to design a constrained fallback, with an observation built
from roles and counts only.

## 5. Remaining unsupported scenarios

- Cross-origin iframes.
- Closed shadow roots.
- Generic (non-ARIA) discovery inside open shadow roots.
- Site JS that submits via `form.submit()` from its own key handler.
- Widgets that commit only to JS memory with no DOM signal. These stop safely as uncommitted.
- Ambiguous consent with empty question text.
- Multi-step wizards.
