import type { Locator, Page } from "playwright";

/** Same attribute tagAndReadFields (fillForm.ts) writes on every input/select/textarea it tags. */
export const FIELD_INDEX_ATTR = "data-nav-engine-field-index";
export const TRIGGER_INDEX_ATTR = "data-nav-engine-trigger-index";
/** Written on the smallest ancestor that contains both a field and its adjacent lookup trigger -- lets resolveDealerLookup scope its before/after text comparison to the dealer widget itself rather than the whole form or the whole page. */
export const DEALER_SCOPE_ATTR = "data-nav-engine-dealer-scope";

/** Generic, accessibility-based dealer-result candidates -- never a brand-specific selector. Used for both a location-suggestion list and a final selectable dealer list; resolveDealerLookup tells them apart by whether a selection ever verifiably commits. This is the authoritative, tried-first signal -- a real ARIA role or native radio always wins over the generic fallback below when both are present. */
export const DEALER_RESULT_SELECTOR = '[role="radio"], input[type="radio"], [role="option"]';

/**
 * Role/tag-agnostic fallback candidates for a results list that carries no ARIA semantics at all
 * (a plain <li><a>, a card <div> with a click handler, a <button> inside a dropdown) -- never
 * selected by tag identity alone. Used only as a "something new and clickable appeared" growth
 * signal, scoped to the dealer widget itself (never the whole page), so an unrelated page-wide
 * change elsewhere can't produce a false positive.
 */
const GENERIC_RESULT_CANDIDATE_SELECTOR = 'a, button, li, [role], [onclick], [tabindex]';
/** Marks every candidate already present before the trigger is activated, so the first
 * unmarked, visible candidate afterward is provably new -- avoids racy before/after count
 * diffing and never depends on DOM order staying stable. */
const DEALER_BASELINE_CANDIDATE_ATTR = "data-nav-engine-dealer-baseline-candidate";

/** Bounded, not unbounded -- a live production lookup can legitimately take longer than a fixed
 * 3s (confirmed by a live run where it never resolved in 3s+600ms at all), but this still caps
 * total wait rather than polling forever. */
export const DEALER_RESULT_WAIT_TIMEOUT_MS = 6000;
export const DEALER_RESULT_POLL_INTERVAL_MS = 250;

/**
 * Generic, language-agnostic vocabulary for a lookup/selection trigger -- "search"/"find"/"go"/
 * "ok" (the original Phase-1 vocabulary) plus "select"/"choose" and their per-language
 * equivalents, confirmed necessary by a live production page whose trigger read "Sélectionnez un
 * Point de Vente" ("Select a Point of Sale"). Matched after accent/case normalization, never as a
 * brand-specific string.
 */
const LOOKUP_TRIGGER_MARKERS = [
  "search",
  "go",
  "find",
  "ok",
  "select",
  "choose",
  "zoeken",
  "selecteren",
  "kiezen",
  "suchen",
  "auswahlen",
  "wahlen",
  "rechercher",
  "choisir",
  "selectionner",
  "cercar",
  "selezionare",
  "scegliere",
  "buscar",
  "seleccionar",
  "elegir",
  "szukaj",
  "wybierz",
  "wybrac",
  "pesquisar",
  "selecionar",
  "escolher",
];

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function matchesLookupTriggerVocabulary(text: string): boolean {
  const normalized = normalizeText(text);
  return LOOKUP_TRIGGER_MARKERS.some((marker) => normalized.includes(marker));
}

export interface RawLookupTriggerCandidate {
  triggerIndex: string;
  text: string;
  /**
   * The FIELD_INDEX_ATTR id of the field this trigger is associated with, if any -- resolved by
   * combining three independent signals (see tagAndFindLookupTriggers), never by DOM sibling
   * order alone. Never "any field sharing a distant common ancestor" either: bounded sanity
   * cutoffs on both DOM distance and visual distance keep this from resolving to an unrelated
   * field elsewhere on a large form.
   */
  adjacentFieldId: string | null;
}

/** Shared, single-source-of-truth cutoffs for trigger-to-field association -- never duplicated as inline literals elsewhere, so a diagnostic report of "configured cutoff" can never drift from the value actually enforced. */
export const TRIGGER_FIELD_MAX_ANCESTOR_HOPS = 20;
export const TRIGGER_FIELD_MAX_PIXEL_DISTANCE = 600;
export const TRIGGER_FIELD_ANCESTOR_HOP_WEIGHT = 40;

/**
 * Diagnostic-only (see src/diagnostics/dealerLookupDiagnostic.ts) per trigger-candidate x
 * field-candidate pair evidence -- never read by, or able to influence, the actual association
 * decision in tagAndFindLookupTriggers (that decision is computed first, unconditionally, by the
 * exact same code path as before this type existed; this is a second, additive pass over the same
 * already-computed numbers, only run when explicitly requested). One entry per pair considered,
 * not just the winner, so a rejected pair's own numbers are always inspectable.
 */
export interface TriggerFieldPairDebug {
  triggerIndex: string;
  triggerText: string;
  fieldIndex: string;
  ariaMatch: boolean;
  nearestCommonAncestorHops: number | null;
  ancestorHopCutoff: number;
  pixelDistance: number | null;
  pixelDistanceCutoff: number;
  /** Signed: this field's position in document order minus the trigger's, among all tagged candidates/fields respectively -- a coarse "found before or after" signal, independent of the ancestor/pixel scoring. */
  domOrderDelta: number;
  ancestorHopScoreComponent: number | null;
  pixelDistanceScoreComponent: number | null;
  finalScore: number | null;
  passedAncestorCutoff: boolean;
  passedPixelCutoff: boolean;
  /** True when this pair was usable at all (an ARIA match, or within both cutoffs) -- independent of whether it ended up the winner (another pair can also be accepted and simply have scored worse). */
  accepted: boolean;
  isWinner: boolean;
  rejectionReason: string | null;
}

export interface TagAndFindLookupTriggersResult {
  candidates: RawLookupTriggerCandidate[];
  /** Present only when collectDebug was true -- every pair considered, for every visible trigger candidate against every tagged field. */
  pairDebug: TriggerFieldPairDebug[];
}

/**
 * Tags every visible, non-submit button-like control in the form with TRIGGER_INDEX_ATTR and
 * reports the field it is structurally associated with, if any. Must run after tagAndReadFields
 * has already tagged the form's input/select/textarea elements with FIELD_INDEX_ATTR -- adjacency
 * is read back from that attribute, not recomputed here. Also tags the smallest ancestor
 * containing both the trigger and its associated field with DEALER_SCOPE_ATTR (keyed by the
 * field's id) so resolveDealerLookup can scope its evidence-gathering to the widget itself.
 *
 * Association is decided from three independent signals, deliberately not from DOM sibling order
 * (a "widen the sibling-walk bound" fix only generalizes to a deeper nesting of the same
 * sibling-chain shape -- it never covers a trigger and its field sitting in separate parallel
 * wrapper elements with no sibling relationship at all, which is exactly the live-site shape that
 * slipped past the old walk):
 *   1. ARIA relationship (trigger aria-controls/aria-owns referencing the field's id, or the
 *      field's aria-describedby referencing the trigger's id) -- authoritative on its own.
 *   2. Nearest-common-ancestor DOM distance -- generalizes "adjacent" to any shared wrapper, not
 *      just a direct-preceding-sibling chain.
 *   3. Visual/geometric proximity (bounding-rect center distance) -- a secondary scoring signal
 *      that also catches a CSS-reordered layout where source order and visual position diverge.
 * Signals 2 and 3 are combined into one score per candidate field and bounded by sanity cutoffs,
 * so a trigger is never matched to "the nearest field anywhere on the page".
 */
export async function tagAndFindLookupTriggers(form: Locator, collectDebug = false): Promise<TagAndFindLookupTriggersResult> {
  return form.evaluate(
    (
      formEl: HTMLFormElement,
      attrs: {
        fieldAttr: string;
        triggerAttr: string;
        scopeAttr: string;
        collectDebug: boolean;
        maxAncestorHops: number;
        maxPixelDistance: number;
        ancestorHopWeight: number;
      },
    ) => {
      const submitEls = new Set(Array.from(formEl.querySelectorAll('button[type="submit"], input[type="submit"]')));
      const candidates = Array.from(formEl.querySelectorAll('button, input[type="button"], [role="button"]')) as HTMLElement[];
      const fieldEls = Array.from(formEl.querySelectorAll(`[${attrs.fieldAttr}]`)) as HTMLElement[];
      const results: { triggerIndex: string; text: string; adjacentFieldId: string | null }[] = [];
      const pairDebug: {
        triggerIndex: string;
        triggerText: string;
        fieldIndex: string;
        ariaMatch: boolean;
        nearestCommonAncestorHops: number | null;
        ancestorHopCutoff: number;
        pixelDistance: number | null;
        pixelDistanceCutoff: number;
        domOrderDelta: number;
        ancestorHopScoreComponent: number | null;
        pixelDistanceScoreComponent: number | null;
        finalScore: number | null;
        passedAncestorCutoff: boolean;
        passedPixelCutoff: boolean;
        accepted: boolean;
        isWinner: boolean;
        rejectionReason: string | null;
      }[] = [];

      const MAX_ANCESTOR_HOPS = attrs.maxAncestorHops;
      const MAX_PIXEL_DISTANCE = attrs.maxPixelDistance;
      const ANCESTOR_HOP_WEIGHT = attrs.ancestorHopWeight;

      candidates.forEach((el, i) => {
        if (submitEls.has(el)) return;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) return;

        const triggerIndex = `trigger-${i}`;
        el.setAttribute(attrs.triggerAttr, triggerIndex);
        const text = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || (el as HTMLInputElement).value || "";

        const referencedIds = (el.getAttribute("aria-controls") || "")
          .split(/\s+/)
          .filter(Boolean)
          .concat((el.getAttribute("aria-owns") || "").split(/\s+/).filter(Boolean));
        const triggerDomId = el.getAttribute("id") || "";

        let ariaMatchedId: string | null = null;
        let bestFieldId: string | null = null;
        let bestScore = Number.POSITIVE_INFINITY;

        for (let f = 0; f < fieldEls.length; f += 1) {
          const fieldEl = fieldEls[f]!;
          // A trigger can never be its own target field -- e.g. a native <input type="button">
          // is tagged both as a field (tagAndReadFields tags every input/select/textarea
          // unconditionally) and as a trigger candidate (this function's own button/
          // input[type=button]/[role=button] selector) here. Left unguarded, this self-pair
          // always scores ancestorHops=0/pixelDistance=0 -- the lowest possible score -- so it
          // would win over every real field on the form regardless of any other evidence.
          if (fieldEl === el) continue;
          const fieldId = fieldEl.getAttribute(attrs.fieldAttr);
          if (fieldId === null) continue;

          const fieldDomId = fieldEl.getAttribute("id") || "";
          const describedBy = (fieldEl.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
          if ((fieldDomId && referencedIds.includes(fieldDomId)) || (triggerDomId && describedBy.includes(triggerDomId))) {
            ariaMatchedId = fieldId;
            break;
          }

          let ancestor: Element | null = el;
          let triggerHops = 0;
          let sharedAncestor: Element | null = null;
          while (ancestor && ancestor !== formEl.parentElement) {
            if (ancestor.contains(fieldEl)) {
              sharedAncestor = ancestor;
              break;
            }
            ancestor = ancestor.parentElement;
            triggerHops += 1;
          }

          let ancestorHops = Number.POSITIVE_INFINITY;
          if (sharedAncestor) {
            let fieldAncestor: Element | null = fieldEl;
            let fieldHops = 0;
            while (fieldAncestor && fieldAncestor !== sharedAncestor) {
              fieldAncestor = fieldAncestor.parentElement;
              fieldHops += 1;
            }
            ancestorHops = triggerHops + fieldHops;
          }

          const fieldRect = fieldEl.getBoundingClientRect();
          const dx = rect.left + rect.width / 2 - (fieldRect.left + fieldRect.width / 2);
          const dy = rect.top + rect.height / 2 - (fieldRect.top + fieldRect.height / 2);
          const pixelDistance = Math.sqrt(dx * dx + dy * dy);

          if (ancestorHops > MAX_ANCESTOR_HOPS || pixelDistance > MAX_PIXEL_DISTANCE) continue;

          const score = ancestorHops * ANCESTOR_HOP_WEIGHT + pixelDistance;
          if (score < bestScore) {
            bestScore = score;
            bestFieldId = fieldId;
          }
        }

        const adjacentFieldId = ariaMatchedId ?? bestFieldId;

        // Diagnostic-only second pass over the same fields, run only when explicitly requested --
        // never short-circuits like the decision loop above (no `break`/`continue` skipping a
        // field once a winner is known), so every pair's own real numbers are always inspectable,
        // including a rejected pair's ancestor-hop/pixel-distance values even when they exceeded a
        // cutoff. Reads the exact same DOM state the decision loop above already read; computes
        // nothing that feeds back into adjacentFieldId.
        if (attrs.collectDebug) {
          for (let f = 0; f < fieldEls.length; f += 1) {
            const fieldEl = fieldEls[f]!;
            const fieldId = fieldEl.getAttribute(attrs.fieldAttr);
            if (fieldId === null) continue;
            const isSelfMatch = fieldEl === el;

            const fieldDomId = fieldEl.getAttribute("id") || "";
            const describedBy = (fieldEl.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
            const ariaMatchesThisField = !isSelfMatch && Boolean((fieldDomId && referencedIds.includes(fieldDomId)) || (triggerDomId && describedBy.includes(triggerDomId)));

            let ancestor: Element | null = el;
            let triggerHops = 0;
            let sharedAncestor: Element | null = null;
            while (ancestor && ancestor !== formEl.parentElement) {
              if (ancestor.contains(fieldEl)) {
                sharedAncestor = ancestor;
                break;
              }
              ancestor = ancestor.parentElement;
              triggerHops += 1;
            }
            let nearestCommonAncestorHops: number | null = null;
            if (sharedAncestor) {
              let fieldAncestor: Element | null = fieldEl;
              let fieldHops = 0;
              while (fieldAncestor && fieldAncestor !== sharedAncestor) {
                fieldAncestor = fieldAncestor.parentElement;
                fieldHops += 1;
              }
              nearestCommonAncestorHops = triggerHops + fieldHops;
            }

            const fieldRect = fieldEl.getBoundingClientRect();
            const dx = rect.left + rect.width / 2 - (fieldRect.left + fieldRect.width / 2);
            const dy = rect.top + rect.height / 2 - (fieldRect.top + fieldRect.height / 2);
            const pixelDistance = Math.sqrt(dx * dx + dy * dy);

            const passedAncestorCutoff = !isSelfMatch && nearestCommonAncestorHops !== null && nearestCommonAncestorHops <= MAX_ANCESTOR_HOPS;
            const passedPixelCutoff = !isSelfMatch && Number.isFinite(pixelDistance) && pixelDistance <= MAX_PIXEL_DISTANCE;
            const ancestorHopScoreComponent = nearestCommonAncestorHops !== null ? nearestCommonAncestorHops * ANCESTOR_HOP_WEIGHT : null;
            const pixelDistanceScoreComponent = Number.isFinite(pixelDistance) ? pixelDistance : null;
            const finalScore =
              !isSelfMatch && (ariaMatchesThisField || (passedAncestorCutoff && passedPixelCutoff))
                ? ariaMatchesThisField
                  ? 0
                  : (ancestorHopScoreComponent ?? 0) + (pixelDistanceScoreComponent ?? 0)
                : null;
            const accepted = !isSelfMatch && (ariaMatchesThisField || (passedAncestorCutoff && passedPixelCutoff));
            const isWinner = !isSelfMatch && adjacentFieldId === fieldId;

            let rejectionReason: string | null = null;
            if (isSelfMatch) {
              rejectionReason = "this field and trigger are the same DOM element -- a trigger can never be its own target field";
            } else if (!accepted) {
              const reasons: string[] = [];
              if (nearestCommonAncestorHops === null) reasons.push("no shared ancestor found within the form");
              else if (!passedAncestorCutoff) reasons.push(`ancestor-hop count ${nearestCommonAncestorHops} exceeds cutoff ${MAX_ANCESTOR_HOPS}`);
              if (!Number.isFinite(pixelDistance)) reasons.push("pixel distance could not be computed");
              else if (!passedPixelCutoff) reasons.push(`pixel distance ${Math.round(pixelDistance)} exceeds cutoff ${MAX_PIXEL_DISTANCE}`);
              rejectionReason = reasons.length > 0 ? reasons.join("; ") : "did not match on any signal";
            } else if (!isWinner) {
              rejectionReason = ariaMatchedId !== null ? "another field had an authoritative ARIA match" : "another accepted field scored better (lower combined ancestor-hop + pixel-distance score)";
            }

            pairDebug.push({
              triggerIndex,
              triggerText: text,
              fieldIndex: fieldId,
              ariaMatch: ariaMatchesThisField,
              nearestCommonAncestorHops,
              ancestorHopCutoff: MAX_ANCESTOR_HOPS,
              pixelDistance: Number.isFinite(pixelDistance) ? pixelDistance : null,
              pixelDistanceCutoff: MAX_PIXEL_DISTANCE,
              domOrderDelta: i - f,
              ancestorHopScoreComponent,
              pixelDistanceScoreComponent,
              finalScore,
              passedAncestorCutoff,
              passedPixelCutoff,
              accepted,
              isWinner,
              rejectionReason,
            });
          }
        }

        if (adjacentFieldId !== null) {
          const fieldEl = formEl.querySelector(`[${attrs.fieldAttr}="${adjacentFieldId}"]`);
          if (fieldEl) {
            let scopeAncestor: Element | null = el;
            while (scopeAncestor && scopeAncestor !== formEl.parentElement) {
              if (scopeAncestor.contains(fieldEl)) {
                scopeAncestor.setAttribute(attrs.scopeAttr, adjacentFieldId);
                break;
              }
              scopeAncestor = scopeAncestor.parentElement;
            }
          }
        }

        results.push({ triggerIndex, text, adjacentFieldId });
      });

      return { candidates: results, pairDebug };
    },
    {
      fieldAttr: FIELD_INDEX_ATTR,
      triggerAttr: TRIGGER_INDEX_ATTR,
      scopeAttr: DEALER_SCOPE_ATTR,
      collectDebug,
      maxAncestorHops: TRIGGER_FIELD_MAX_ANCESTOR_HOPS,
      maxPixelDistance: TRIGGER_FIELD_MAX_PIXEL_DISTANCE,
      ancestorHopWeight: TRIGGER_FIELD_ANCESTOR_HOP_WEIGHT,
    },
  );
}

export async function triggerByIndex(form: Locator, index: string): Promise<Locator> {
  return form.locator(`[${TRIGGER_INDEX_ATTR}="${index}"]`);
}

export async function dealerScopeFor(form: Locator, fieldId: string): Promise<Locator> {
  const scoped = form.locator(`[${DEALER_SCOPE_ATTR}="${fieldId}"]`);
  return (await scoped.count()) > 0 ? scoped.first() : form;
}

async function safeInnerText(locator: Locator): Promise<string> {
  return locator.evaluate((el: Element) => el.textContent ?? "").catch(() => "");
}

/** Tags every current generic candidate as "pre-existing" so a later check can tell new from old. */
async function markBaselineCandidates(scope: Locator): Promise<void> {
  await scope
    .locator(GENERIC_RESULT_CANDIDATE_SELECTOR)
    .evaluateAll((els: Element[], attr: string) => {
      els.forEach((el) => el.setAttribute(attr, "1"));
    }, DEALER_BASELINE_CANDIDATE_ATTR)
    .catch(() => {});
}

/** The first visible candidate that wasn't already present when the trigger was activated, or
 * null if none has appeared yet. Never selected by tag/class identity -- only "new and visible". */
async function firstNewCandidate(scope: Locator): Promise<Locator | null> {
  // :not() binds only to the single compound selector immediately before it, not to a whole
  // comma-separated list -- wrapping the candidate list in :is(...) first is required so the
  // exclusion applies to every branch (a/button/li/[role]/[onclick]/[tabindex]) rather than only
  // the last one.
  const newCandidates = scope.locator(`:is(${GENERIC_RESULT_CANDIDATE_SELECTOR}):not([${DEALER_BASELINE_CANDIDATE_ATTR}])`);
  const count = await newCandidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = newCandidates.nth(i);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

/**
 * A clicked result doesn't by itself prove the widget's own JS committed the selection (e.g. a
 * hidden "selected dealer id" field it still has to write) -- check the result's own selected/
 * checked state after a short settle. `aria-checked` is the correct ARIA state for `role="radio"`,
 * `aria-selected` for `role="option"`; both are checked generically since the result could be
 * either.
 */
async function verifyDealerSelectionCommitted(page: Page, option: Locator): Promise<boolean> {
  await page.waitForTimeout(150);
  return option
    .evaluate(
      (el: Element) =>
        (el as HTMLInputElement).checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("aria-selected") === "true",
    )
    .catch(() => false);
}

/**
 * Diagnostic-only (see src/diagnostics/dealerLookupDiagnostic.ts) blow-by-blow record of what
 * resolveDealerLookup actually did and observed -- every field here is read from state this
 * function already computes or a single additional cheap, non-waiting DOM count; nothing here
 * changes resolveDealerLookup's own timing, waits, or decisions. Never includes a selected
 * result's own text (which could be a real postcode/city/dealer name entered or returned by the
 * live site) -- identity is reported positionally/structurally only.
 */
export interface DealerLookupExecutionTrace {
  eventsDispatched: ("click_trigger" | "press_enter")[];
  waitCondition: string;
  waitTimeoutMs: number;
  waitOutcome: "resolved" | "timed_out";
  suggestionsDetected: boolean;
  suggestionCount: number;
  /** Positional only -- e.g. "result[0]" -- never the selected result's own text content. */
  selectedSuggestionIdentity: string | null;
  secondStageSuggestionCount: number | null;
  /** True when no element matched DEALER_RESULT_SELECTOR (no ARIA radio/option semantics) but a
   * new, visible, generically-clickable element appeared within the dealer-widget scope after
   * the trigger fired, and that element was used as the selected result instead. */
  genericCandidateFallbackUsed: boolean;
}

export interface DealerLookupOutcome {
  dealerLookupTriggered: boolean;
  dealerLookupOutcome: "auto_populated" | "suggestion_selected" | "dealer_selected" | "unresolved";
  locationSuggestionsDetected: boolean;
  locationSuggestionSelected: boolean;
  dealerResultsDetected: boolean;
  dealerAutoPopulated: boolean;
  dealerSelected: boolean;
  dealerValueVerified: boolean;
  dealerVerificationEvidence: string;
  dealerLookupFailureReason?: string;
  executionTrace: DealerLookupExecutionTrace;
}

/**
 * State-driven dealer resolution: fill the postcode/city value is the caller's job (this only
 * activates the lookup and inspects what happens), then inspects the resulting state rather than
 * assuming one fixed shape --
 *   1. a selectable result list (radio/option) appears -> select the first, verify it commits;
 *      if it never commits, give the page a moment in case that first list was itself only a
 *      location-suggestion stage and a second, real dealer list replaces it, then retry once;
 *   2. no selectable list appears at all, but the widget's own scoped text materially changed ->
 *      treat as auto-populated (the generic "placeholder/label replaced by real dealer content"
 *      signal -- never a specific brand's placeholder string);
 *   3. neither -> dealer_lookup_unresolved, and the caller must never submit on this basis alone.
 * Never requires a result element to already exist in the DOM before the trigger is activated --
 * on a real site the result container is routinely created only after the click.
 */
export async function resolveDealerLookup(page: Page, scope: Locator, trigger: Locator | null, field: Locator): Promise<DealerLookupOutcome> {
  const baselineText = await safeInnerText(scope);
  const eventDispatched: "click_trigger" | "press_enter" = trigger ? "click_trigger" : "press_enter";

  // Marked before the trigger fires so a bounded poll can later tell "a brand-new result
  // element appeared" apart from "an element that was already on the page before the lookup
  // ran" without racy before/after count-diffing.
  await markBaselineCandidates(scope);

  if (trigger) {
    await trigger.click().catch(() => {});
  } else {
    await field.press("Enter").catch(() => {});
  }

  const resultLocator = scope.locator(DEALER_RESULT_SELECTOR);
  let resultsAppeared = false;
  let genericCandidate: Locator | null = null;
  const waitTimeoutMs = DEALER_RESULT_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + waitTimeoutMs;
  // Adaptive, bounded poll: the authoritative ARIA/native-radio selector is checked every
  // interval first (unchanged priority over the generic fallback), and only once neither it
  // nor a brand-new generic candidate has shown up does the loop give up -- never a single
  // fixed-delay waitFor, since real lookup widgets vary widely in how long they take to render.
  while (Date.now() < deadline) {
    if (await resultLocator.first().isVisible().catch(() => false)) {
      resultsAppeared = true;
      break;
    }
    const candidate = await firstNewCandidate(scope);
    if (candidate) {
      genericCandidate = candidate;
      break;
    }
    await page.waitForTimeout(DEALER_RESULT_POLL_INTERVAL_MS);
  }
  const suggestionCount = await resultLocator.count().catch(() => 0);

  if (resultsAppeared) {
    const first = resultLocator.first();
    await first.click().catch(() => {});
    let verified = await verifyDealerSelectionCommitted(page, first);
    let suggestionSelected = false;
    let secondStageSuggestionCount: number | null = null;

    if (!verified) {
      // Possibly a two-stage widget: the first list was a location/geocoding suggestion, not
      // the dealer itself -- give the page a moment to replace it with the real dealer list,
      // then retry the same select-and-verify once.
      await page.waitForTimeout(500);
      const secondResult = scope.locator(DEALER_RESULT_SELECTOR);
      const secondCount = await secondResult.count().catch(() => 0);
      secondStageSuggestionCount = secondCount;
      if (secondCount > 0) {
        suggestionSelected = true;
        const second = secondResult.first();
        await second.click().catch(() => {});
        verified = await verifyDealerSelectionCommitted(page, second);
      }
    }

    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: verified ? "dealer_selected" : "unresolved",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: suggestionSelected,
      dealerResultsDetected: true,
      dealerAutoPopulated: false,
      dealerSelected: true,
      dealerValueVerified: verified,
      dealerVerificationEvidence: verified
        ? "selected_result_carries_checked_or_aria_checked_or_aria_selected_state"
        : "no_committed_state_detected_on_selected_result",
      dealerLookupFailureReason: verified ? undefined : "selectable_result_found_but_commit_state_never_verified",
      executionTrace: {
        eventsDispatched: [eventDispatched],
        waitCondition: `${DEALER_RESULT_SELECTOR} visible within scope`,
        waitTimeoutMs,
        waitOutcome: "resolved",
        suggestionsDetected: true,
        suggestionCount,
        selectedSuggestionIdentity: "result[0]",
        secondStageSuggestionCount,
        genericCandidateFallbackUsed: false,
      },
    };
  }

  if (genericCandidate) {
    await genericCandidate.click().catch(() => {});
    const committed = await verifyDealerSelectionCommitted(page, genericCandidate);
    const afterGenericClickText = await safeInnerText(scope);
    const scopeTextChanged =
      afterGenericClickText.trim().length > 0 && afterGenericClickText.trim() !== baselineText.trim();
    const verified = committed || scopeTextChanged;

    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: "suggestion_selected",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: true,
      dealerResultsDetected: verified,
      dealerAutoPopulated: false,
      dealerSelected: verified,
      dealerValueVerified: verified,
      dealerVerificationEvidence: verified
        ? "generic_candidate_selected_and_committed_or_scope_state_changed"
        : "generic_candidate_selected_but_no_committed_state_detected",
      dealerLookupFailureReason: verified ? undefined : "generic_candidate_selected_but_commit_state_never_verified",
      executionTrace: {
        eventsDispatched: [eventDispatched],
        waitCondition: `${DEALER_RESULT_SELECTOR} visible within scope, or a new generic result candidate within scope`,
        waitTimeoutMs,
        waitOutcome: "resolved",
        suggestionsDetected: true,
        suggestionCount,
        selectedSuggestionIdentity: "generic_candidate[0]",
        secondStageSuggestionCount: null,
        genericCandidateFallbackUsed: true,
      },
    };
  }

  await page.waitForTimeout(600);
  const afterText = await safeInnerText(scope);
  const trimmedBefore = baselineText.trim();
  const trimmedAfter = afterText.trim();
  const changed = trimmedAfter.length > 0 && trimmedAfter !== trimmedBefore && trimmedAfter.length > trimmedBefore.length;

  if (changed) {
    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: "auto_populated",
      locationSuggestionsDetected: false,
      locationSuggestionSelected: false,
      dealerResultsDetected: false,
      dealerAutoPopulated: true,
      dealerSelected: false,
      dealerValueVerified: true,
      dealerVerificationEvidence: "dealer_lookup_scope_text_changed_after_trigger_with_no_selectable_result",
      executionTrace: {
        eventsDispatched: [eventDispatched],
        waitCondition: `${DEALER_RESULT_SELECTOR} visible within scope`,
        waitTimeoutMs,
        waitOutcome: "timed_out",
        suggestionsDetected: false,
        suggestionCount,
        selectedSuggestionIdentity: null,
        secondStageSuggestionCount: null,
        genericCandidateFallbackUsed: false,
      },
    };
  }

  return {
    dealerLookupTriggered: true,
    dealerLookupOutcome: "unresolved",
    locationSuggestionsDetected: false,
    locationSuggestionSelected: false,
    dealerResultsDetected: false,
    dealerAutoPopulated: false,
    dealerSelected: false,
    dealerValueVerified: false,
    dealerVerificationEvidence: "no_change_detected_in_dealer_lookup_scope",
    dealerLookupFailureReason: "no_selectable_result_and_no_text_change_within_timeout",
    executionTrace: {
      eventsDispatched: [eventDispatched],
      waitCondition: `${DEALER_RESULT_SELECTOR} visible within scope`,
      waitTimeoutMs,
      waitOutcome: "timed_out",
      suggestionsDetected: false,
      suggestionCount,
      selectedSuggestionIdentity: null,
      secondStageSuggestionCount: null,
      genericCandidateFallbackUsed: false,
    },
  };
}
