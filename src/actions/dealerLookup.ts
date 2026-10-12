import type { Locator, Page } from "playwright";

/** Same attribute tagAndReadFields (fillForm.ts) writes on every input/select/textarea it tags. */
const FIELD_INDEX_ATTR = "data-nav-engine-field-index";
const TRIGGER_INDEX_ATTR = "data-nav-engine-trigger-index";
/** Written on the smallest ancestor that contains both a field and its adjacent lookup trigger -- lets resolveDealerLookup scope its before/after text comparison to the dealer widget itself rather than the whole form or the whole page. */
export const DEALER_SCOPE_ATTR = "data-nav-engine-dealer-scope";

/** Generic, accessibility-based dealer-result candidates -- never a brand-specific selector. Used for both a location-suggestion list and a final selectable dealer list; resolveDealerLookup tells them apart by whether a selection ever verifiably commits. */
export const DEALER_RESULT_SELECTOR = '[role="radio"], input[type="radio"], [role="option"]';

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
export async function tagAndFindLookupTriggers(form: Locator): Promise<RawLookupTriggerCandidate[]> {
  return form.evaluate(
    (formEl: HTMLFormElement, attrs: { fieldAttr: string; triggerAttr: string; scopeAttr: string }) => {
      const submitEls = new Set(Array.from(formEl.querySelectorAll('button[type="submit"], input[type="submit"]')));
      const candidates = Array.from(formEl.querySelectorAll('button, input[type="button"], [role="button"]')) as HTMLElement[];
      const fieldEls = Array.from(formEl.querySelectorAll(`[${attrs.fieldAttr}]`)) as HTMLElement[];
      const results: { triggerIndex: string; text: string; adjacentFieldId: string | null }[] = [];

      const MAX_ANCESTOR_HOPS = 20;
      const MAX_PIXEL_DISTANCE = 600;
      const ANCESTOR_HOP_WEIGHT = 40;

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

      return results;
    },
    { fieldAttr: FIELD_INDEX_ATTR, triggerAttr: TRIGGER_INDEX_ATTR, scopeAttr: DEALER_SCOPE_ATTR },
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

  if (trigger) {
    await trigger.click().catch(() => {});
  } else {
    await field.press("Enter").catch(() => {});
  }

  const resultLocator = scope.locator(DEALER_RESULT_SELECTOR);
  let resultsAppeared = false;
  try {
    await resultLocator.first().waitFor({ state: "visible", timeout: 3000 });
    resultsAppeared = true;
  } catch {
    resultsAppeared = false;
  }

  if (resultsAppeared) {
    const first = resultLocator.first();
    await first.click().catch(() => {});
    let verified = await verifyDealerSelectionCommitted(page, first);
    let suggestionSelected = false;

    if (!verified) {
      // Possibly a two-stage widget: the first list was a location/geocoding suggestion, not
      // the dealer itself -- give the page a moment to replace it with the real dealer list,
      // then retry the same select-and-verify once.
      await page.waitForTimeout(500);
      const secondResult = scope.locator(DEALER_RESULT_SELECTOR);
      const secondCount = await secondResult.count().catch(() => 0);
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
  };
}
