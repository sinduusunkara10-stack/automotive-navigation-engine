import type { Locator, Page } from "playwright";

/** Same attribute tagAndReadFields (fillForm.ts) writes on every input/select/textarea it tags. */
const FIELD_INDEX_ATTR = "data-nav-engine-field-index";
const TRIGGER_INDEX_ATTR = "data-nav-engine-trigger-index";
/** Written on the smallest ancestor that contains both a field and its adjacent lookup trigger -- lets resolveDealerLookup scope its before/after text comparison to the dealer widget itself rather than the whole form or the whole page. */
const DEALER_SCOPE_ATTR = "data-nav-engine-dealer-scope";

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
  /** The FIELD_INDEX_ATTR id of the nearest field found by walking backward through preceding siblings/ancestors (same bounded-walk shape tagAndReadFields already uses for its own label fallback) -- never "any field sharing a distant common ancestor", which on a flat form (fields as direct form children, no wrapper divs) would otherwise resolve to the form's very first field regardless of the trigger's real position. */
  adjacentFieldId: string | null;
}

/**
 * Tags every visible, non-submit button-like control in the form with TRIGGER_INDEX_ATTR and
 * reports the nearest preceding field it is adjacent to, if any. Must run after tagAndReadFields
 * has already tagged the form's input/select/textarea elements with FIELD_INDEX_ATTR -- adjacency
 * is read back from that attribute, not recomputed here. Also tags the smallest ancestor
 * containing both the trigger and its adjacent field with DEALER_SCOPE_ATTR (keyed by the field's
 * id) so resolveDealerLookup can scope its evidence-gathering to the widget itself.
 */
export async function tagAndFindLookupTriggers(form: Locator): Promise<RawLookupTriggerCandidate[]> {
  return form.evaluate(
    (formEl: HTMLFormElement, attrs: { fieldAttr: string; triggerAttr: string; scopeAttr: string }) => {
      const submitEls = new Set(Array.from(formEl.querySelectorAll('button[type="submit"], input[type="submit"]')));
      const candidates = Array.from(formEl.querySelectorAll('button, input[type="button"], [role="button"]')) as HTMLElement[];
      const results: { triggerIndex: string; text: string; adjacentFieldId: string | null }[] = [];

      candidates.forEach((el, i) => {
        if (submitEls.has(el)) return;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) return;

        const triggerIndex = `trigger-${i}`;
        el.setAttribute(attrs.triggerAttr, triggerIndex);
        const text = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || (el as HTMLInputElement).value || "";

        // Nearest-preceding-field walk: never "the first field inside whatever ancestor happens
        // to contain one", which on a flat form (fields as direct <form> children with no
        // wrapper divs) would resolve to the form's very first field for every trigger button.
        let adjacentFieldId: string | null = null;
        let node: Element | null = el;
        let steps = 0;
        while (node && node !== formEl && steps < 8 && adjacentFieldId === null) {
          let sibling: Element | null = node.previousElementSibling;
          let siblingSteps = 0;
          while (sibling && siblingSteps < 6 && adjacentFieldId === null) {
            if (sibling.hasAttribute(attrs.fieldAttr)) {
              adjacentFieldId = sibling.getAttribute(attrs.fieldAttr);
            } else {
              const nested = Array.from(sibling.querySelectorAll(`[${attrs.fieldAttr}]`));
              if (nested.length > 0) {
                adjacentFieldId = nested[nested.length - 1]!.getAttribute(attrs.fieldAttr);
              }
            }
            sibling = sibling.previousElementSibling;
            siblingSteps += 1;
          }
          node = node.parentElement;
          steps += 1;
        }

        if (adjacentFieldId !== null) {
          const fieldEl = formEl.querySelector(`[${attrs.fieldAttr}="${adjacentFieldId}"]`);
          if (fieldEl) {
            let ancestor: Element | null = el;
            while (ancestor && ancestor !== formEl.parentElement) {
              if (ancestor.contains(fieldEl)) {
                ancestor.setAttribute(attrs.scopeAttr, adjacentFieldId);
                break;
              }
              ancestor = ancestor.parentElement;
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
