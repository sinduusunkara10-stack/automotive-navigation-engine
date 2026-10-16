import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { isLookupLikePurpose, startDealerLookupNetworkCapture, type DealerLookupNetworkCapture, type SanitizedNetworkRequestEvidence } from "./dealerLookupNetwork.js";
import { detectHiddenCommit, startDealerLookupProbe, type DealerLookupProbe, type HiddenFieldPurpose, type HiddenFieldState } from "./dealerLookupProbe.js";

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
/** Marks every candidate already visible before the trigger is activated, so the first
 * unmarked, visible candidate afterward is provably new -- avoids racy before/after count
 * diffing and never depends on DOM order staying stable. Deliberately visibility-gated (not
 * "every matching element regardless of visibility"): a result container that already exists in
 * the DOM at baseline time but is hidden, then later made visible with no new element ever
 * inserted, must still register as new -- a hidden-until-shown container was confirmed as a real,
 * generic rendering pattern this engine has to handle, not a hypothetical. */
const DEALER_BASELINE_CANDIDATE_ATTR = "data-nav-engine-dealer-baseline-candidate";
/** Marks every candidate present at baseline regardless of visibility -- independent of the
 * visibility-gated attribute above, used only to report (never to decide) whether a result that
 * later appears was a pre-existing-but-hidden element or a freshly-inserted one. Diagnostic-only. */
const DEALER_BASELINE_EXISTED_ATTR = "data-nav-engine-dealer-baseline-existed";
/** Marks every authoritative ARIA/native-radio result element present anywhere on the page
 * (not just in scope) before the lookup starts -- lets the page-wide fallback tier (see
 * pollForStageResult) tell a genuinely new result rendered outside the widget's own DOM scope
 * (e.g. a portal/overlay appended elsewhere, a common pattern for positioned dropdowns) apart
 * from an unrelated pre-existing control elsewhere on the page that merely shares the same role. */
const DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR = "data-nav-engine-dealer-page-baseline-authoritative";

/** Bounded, not unbounded -- a live production lookup can legitimately take longer than a fixed
 * 3s (confirmed by a live run where it never resolved in 3s+600ms at all), but this still caps
 * total wait rather than polling forever. Applied independently to EACH stage (location
 * suggestions, dealer results) -- never once across the whole flow -- so a slow dealer stage
 * can never be starved by time already spent waiting on the location stage, and vice versa. */
export const DEALER_RESULT_WAIT_TIMEOUT_MS = 6000;
/** Granted once per stage, only when a generic loading indicator (see LOADING_INDICATOR_SELECTOR)
 * is observed still active right at that stage's base timeout -- never granted speculatively. */
export const DEALER_STAGE_WAIT_EXTENSION_MS = 3000;
/** Hard ceiling per stage, inclusive of any extension -- a stage can never wait longer than this
 * regardless of what the page does, so the engine cannot stall indefinitely on a dealer widget. */
export const DEALER_STAGE_WAIT_MAX_MS = DEALER_RESULT_WAIT_TIMEOUT_MS + DEALER_STAGE_WAIT_EXTENSION_MS;
export const DEALER_RESULT_POLL_INTERVAL_MS = 250;
/** Short, bounded check for a suggestion list appearing entirely on its own -- from typing alone,
 * with no trigger click or keyboard action yet -- run once right after the field is filled and
 * before deciding whether to activate a trigger at all. */
export const DEALER_AUTO_APPEAR_CHECK_MS = 1200;
/** Generic, accessibility-based "the page is still working on this" signal -- never a brand's own
 * spinner class or loading text. Used only to decide whether a stage's wait has earned one bounded
 * extension, never to wait indefinitely. */
const LOADING_INDICATOR_SELECTOR = '[aria-busy="true"], [role="progressbar"], [role="status"]';

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
// Equal to the pixel cutoff, so one ancestor hop always outweighs any accepted pixel distance: DOM
// structure decides, visual distance only breaks ties. With a smaller weight, a CSS-less inline
// layout let an unrelated field one hop further away but visually nearer (e.g. "First name") win
// the textless trigger, and the postcode was typed into it.
export const TRIGGER_FIELD_ANCESTOR_HOP_WEIGHT = TRIGGER_FIELD_MAX_PIXEL_DISTANCE;

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
      // A hidden <input type="hidden"> is tagged as a field (tagAndReadFields tags every
      // input/select/textarea unconditionally, for other purposes such as the dealer-identifier
      // diagnostics) but can never be the target of a user-facing lookup trigger -- it has no
      // visual presence at all, and browsers collapse it to a zero/degenerate bounding rect that
      // can otherwise score an accidentally-better ancestor-hop/pixel-distance match than the
      // real, visible field a trigger is actually adjacent to.
      const fieldEls = (Array.from(formEl.querySelectorAll(`[${attrs.fieldAttr}]`)) as HTMLElement[]).filter(
        (el) => !(el instanceof HTMLInputElement && el.type === "hidden"),
      );
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

/** Presence-only, never the validation message's own text (which some browsers can echo the
 * field's current value into) -- see DealerLookupExecutionTrace's own doc comments. */
async function readFieldValidationState(field: Locator): Promise<{ ariaInvalid: boolean; hasNativeValidationMessage: boolean }> {
  return field
    .evaluate((el: Element) => ({
      ariaInvalid: el.getAttribute("aria-invalid") === "true",
      hasNativeValidationMessage: ((el as HTMLInputElement).validationMessage ?? "").length > 0,
    }))
    .catch(() => ({ ariaInvalid: false, hasNativeValidationMessage: false }));
}

/** Tags every current generic candidate as "pre-existing" so a later check can tell new from old.
 * Only candidates VISIBLE right now are tagged with the exclusion attribute -- a candidate that
 * exists but is hidden at this moment is tagged only with the diagnostic-only "existed" attribute,
 * so if it later becomes visible with no new element ever inserted, it is still correctly treated
 * as a new result (see DEALER_BASELINE_CANDIDATE_ATTR's own doc comment). */
async function markBaselineCandidates(scope: Locator): Promise<void> {
  await scope
    .locator(GENERIC_RESULT_CANDIDATE_SELECTOR)
    .evaluateAll(
      (els: Element[], attrs: { existedAttr: string; visibleAttr: string }) => {
        els.forEach((el) => {
          el.setAttribute(attrs.existedAttr, "1");
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          if (visible) el.setAttribute(attrs.visibleAttr, "1");
        });
      },
      { existedAttr: DEALER_BASELINE_EXISTED_ATTR, visibleAttr: DEALER_BASELINE_CANDIDATE_ATTR },
    )
    .catch(() => {});
}

/** Generic "dismiss/clear" vocabulary -- a widget routinely renders a clear (x) control inside its own
 * wrapper the moment the field holds a value, which is new and clickable but is never a result.
 * Clicking it would wipe the value the lookup depends on. */
const NON_RESULT_CONTROL_MARKERS = ["clear", "close", "reset", "remove", "delete", "cancel", "effacer", "fermer", "supprimer", "annuler", "loschen", "schliessen", "wissen", "sluiten", "cancella", "chiudi", "borrar", "cerrar", "limpar", "fechar", "wyczysc", "zamknij", "usun"];

/** Generic vocabulary for a control that asks the browser for the user's own position rather than
 * searching for the typed value. Matched against the control's own accessible name, title, id and
 * class tokens -- never a brand-specific selector. Clicking such a control can never resolve a typed
 * postcode/city, and in a headless browser without granted permission it can only fail. */
const GEOLOCATION_CONTROL_MARKERS = [
  "geoloc",
  "locate me",
  "locateme",
  "my location",
  "my position",
  "current location",
  "near me",
  "ma position",
  "me localiser",
  "localisez moi",
  "autour de moi",
  "mein standort",
  "standort ermitteln",
  "mijn locatie",
  "la mia posizione",
  "mi ubicacion",
  "moja lokalizacja",
  "minha localizacao",
  "gps",
];

interface NewCandidateResult {
  locator: Locator;
  /** True when this element already existed in the DOM at baseline time (just hidden), rather
   * than being freshly inserted afterward -- diagnostic-only, never affects selection. */
  wasPreExistingHiddenElement: boolean;
}

/** The first visible candidate that wasn't already present when the trigger was activated, or
 * null if none has appeared yet. Never selected by tag/class identity -- only "new and visible",
 * excluding a dismiss/clear control and a link that would navigate the page away. */
async function firstNewCandidate(scope: Locator): Promise<NewCandidateResult | null> {
  // :not() binds only to the single compound selector immediately before it, not to a whole
  // comma-separated list -- wrapping the candidate list in :is(...) first is required so the
  // exclusion applies to every branch (a/button/li/[role]/[onclick]/[tabindex]) rather than only
  // the last one.
  const newCandidates = scope.locator(`:is(${GENERIC_RESULT_CANDIDATE_SELECTOR}):not([${DEALER_BASELINE_CANDIDATE_ATTR}]):not([${DEALER_ALREADY_ACTIVATED_ATTR}])`);
  const count = await newCandidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = newCandidates.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const eligibility = await candidate
      .evaluate(
        (el: Element, args: { existedAttr: string; markers: string[] }) => {
          const text = (el.getAttribute("aria-label") || el.textContent || "")
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .trim();
          const isDismiss = text.length <= 1 || args.markers.some((marker) => text === marker || text.startsWith(`${marker} `));
          const anchor = el.closest("a[href]");
          const href = anchor?.getAttribute("href")?.trim() ?? "";
          let navigational = false;
          if (anchor && href.length > 0 && !href.startsWith("#") && !href.toLowerCase().startsWith("javascript:")) {
            try {
              const target = new URL(href, location.href);
              navigational = target.pathname !== location.pathname || target.origin !== location.origin;
            } catch {
              navigational = true;
            }
          }
          const containsEditable = el.querySelector('input:not([type="radio"]):not([type="hidden"]), select, textarea') !== null || el.matches("input, select, textarea");
          return { eligible: !isDismiss && !navigational && !containsEditable, existed: el.hasAttribute(args.existedAttr) };
        },
        { existedAttr: DEALER_BASELINE_EXISTED_ATTR, markers: NON_RESULT_CONTROL_MARKERS },
      )
      .catch(() => ({ eligible: false, existed: false }));
    if (eligibility.eligible) return { locator: candidate, wasPreExistingHiddenElement: eligibility.existed };
  }
  return null;
}

/** A result found by any discovery tier, frozen to the exact node found right now. */
interface FoundResult {
  handle: ElementHandle<SVGElement | HTMLElement>;
  authoritative: boolean;
  /** True when found outside the trigger/field's own DOM-containment scope (portal, overlay,
   * ARIA-linked container elsewhere on the page, or a same-origin child frame). */
  foundOutsideScope: boolean;
  foundInFrame: boolean;
  wasPreExistingHiddenElement: boolean;
}

interface StagePollResult {
  result: FoundResult | null;
  timedOut: boolean;
  extended: boolean;
  loadingIndicatorObserved: boolean;
  /** True when a lookup-like request was still awaiting its response at the stage's base timeout. */
  pendingRequestObservedAtTimeout: boolean;
}

/** Shared per-resolution discovery context -- see findResultOnce for the tier order. */
interface DiscoveryContext {
  page: Page;
  scope: Locator;
  probe: DealerLookupProbe;
  /** Probe mutation sequence at the start of the current stage -- only DOM changes after it count. */
  stageSeq: number;
  network: DealerLookupNetworkCapture;
}

/** Marks every authoritative result visible right now in each same-origin child frame, so a later
 * check there only ever matches a result that appeared (or became visible) after the lookup began.
 * A cross-origin frame is never inspected: it is outside this page's own origin, and is reported as
 * an unsupported surface instead. */
const DEALER_FRAME_BASELINE_ATTR = "data-nav-engine-dealer-frame-baseline";

function sameOriginChildFrames(page: Page): Frame[] {
  let pageOrigin = "";
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    return [];
  }
  return page.frames().filter((frame) => {
    if (frame === page.mainFrame()) return false;
    try {
      return new URL(frame.url()).origin === pageOrigin;
    } catch {
      return false;
    }
  });
}

async function markFrameBaselineAuthoritative(page: Page): Promise<void> {
  for (const frame of sameOriginChildFrames(page)) {
    await frame
      .locator(DEALER_RESULT_SELECTOR)
      .evaluateAll((els: Element[], attr: string) => {
        els.forEach((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") el.setAttribute(attr, "1");
        });
      }, DEALER_FRAME_BASELINE_ATTR)
      .catch(() => {});
  }
}

/**
 * One discovery pass across every supported result surface, most to least specific:
 *   1. authoritative ARIA/native-radio result inside the widget's own scope;
 *   2. a new, eligible generic candidate inside that scope;
 *   3. a new authoritative result inserted anywhere on the page (pierces open shadow roots);
 *   4. the in-page probe: an ARIA-linked container (aria-controls/aria-owns/aria-activedescendant),
 *      a portal/overlay, or a hidden container that became visible, including plain div/span items
 *      -- always anchored to the field by proximity or an ARIA link, never "anything new anywhere";
 *   5. a new authoritative result in a same-origin child frame.
 */
async function findResultOnce(ctx: DiscoveryContext): Promise<FoundResult | null> {
  const inScopeAuthoritative = ctx.scope.locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}])`).first();
  if (await inScopeAuthoritative.isVisible().catch(() => false)) {
    const handle = await freeze(inScopeAuthoritative);
    if (handle) return { handle, authoritative: true, foundOutsideScope: false, foundInFrame: false, wasPreExistingHiddenElement: false };
  }
  const candidate = await firstNewCandidate(ctx.scope);
  if (candidate) {
    const handle = await freeze(candidate.locator);
    // An ARIA/native result inserted between the authoritative check above and this one must still
    // be reported as authoritative -- otherwise the outcome depends on poll timing.
    const authoritative = handle ? await handle.evaluate((el, sel) => el.matches(sel), DEALER_RESULT_SELECTOR).catch(() => false) : false;
    if (handle) return { handle, authoritative, foundOutsideScope: false, foundInFrame: false, wasPreExistingHiddenElement: authoritative ? false : candidate.wasPreExistingHiddenElement };
  }
  const pageWide = pageWideNewAuthoritativeLocator(ctx.page).first();
  if (await pageWide.isVisible().catch(() => false)) {
    const handle = await freeze(pageWide);
    if (handle) return { handle, authoritative: true, foundOutsideScope: true, foundInFrame: false, wasPreExistingHiddenElement: false };
  }
  const probed = await ctx.probe.findResult(ctx.stageSeq);
  if (probed) {
    const kind = await probed.getAttribute("data-nav-engine-dealer-probe-kind").catch(() => null);
    const scopeHandle = await ctx.scope.elementHandle({ timeout: 500 }).catch(() => null);
    const insideScope = scopeHandle ? await probed.evaluate((el, scopeEl) => scopeEl.contains(el), scopeHandle).catch(() => false) : false;
    return { handle: probed, authoritative: kind === "authoritative", foundOutsideScope: !insideScope, foundInFrame: false, wasPreExistingHiddenElement: false };
  }
  for (const frame of sameOriginChildFrames(ctx.page)) {
    const inFrame = frame.locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}]):not([${DEALER_FRAME_BASELINE_ATTR}])`).first();
    if (await inFrame.isVisible().catch(() => false)) {
      const handle = await freeze(inFrame);
      if (handle) return { handle, authoritative: true, foundOutsideScope: true, foundInFrame: true, wasPreExistingHiddenElement: false };
    }
  }
  return null;
}

async function loadingIndicatorVisible(ctx: DiscoveryContext): Promise<boolean> {
  if (await ctx.scope.locator(LOADING_INDICATOR_SELECTOR).first().isVisible().catch(() => false)) return true;
  return (await ctx.probe.snapshot(null)).busy;
}

/**
 * One state-machine stage's bounded, adaptive wait -- never a single fixed-delay waitFor. Runs
 * findResultOnce every poll interval, stopping the instant a result appears. If nothing has
 * appeared by `baseTimeoutMs` and there is concrete evidence the page is still working -- a generic
 * loading indicator still visibly active, or a lookup-like request still awaiting its response --
 * grants exactly one bounded extension (never more, never unbounded) up to `maxTimeoutMs` total.
 */
async function pollForStageResult(ctx: DiscoveryContext, baseTimeoutMs: number, extensionMs: number, maxTimeoutMs: number): Promise<StagePollResult> {
  const start = Date.now();
  let deadline = start + baseTimeoutMs;
  let extended = false;
  let loadingIndicatorObserved = false;
  let pendingRequestObservedAtTimeout = false;

  while (true) {
    const result = await findResultOnce(ctx);
    if (result) return { result, timedOut: false, extended, loadingIndicatorObserved, pendingRequestObservedAtTimeout };
    if (Date.now() >= deadline) {
      if (!extended && Date.now() < start + maxTimeoutMs) {
        const stillLoading = await loadingIndicatorVisible(ctx);
        const stillPending = ctx.network.pendingLookupLike() > 0;
        if (stillLoading || stillPending) {
          loadingIndicatorObserved = stillLoading;
          pendingRequestObservedAtTimeout = stillPending;
          extended = true;
          deadline = Math.min(start + maxTimeoutMs, Date.now() + extensionMs);
          continue;
        }
      }
      return { result: null, timedOut: true, extended, loadingIndicatorObserved, pendingRequestObservedAtTimeout: pendingRequestObservedAtTimeout || ctx.network.pendingLookupLike() > 0 };
    }
    await ctx.page.waitForTimeout(DEALER_RESULT_POLL_INTERVAL_MS);
  }
}

/** Page-wide locator for a NEW authoritative result, excluding anything present at baseline --
 * see DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR's own doc comment. */
function pageWideNewAuthoritativeLocator(page: Page): Locator {
  return page.locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}]):not([${DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR}])`);
}

/** Tags every authoritative-role element present anywhere on the page right now as pre-existing,
 * so the page-wide fallback tier can later tell a genuinely new result (rendered outside the
 * widget's own DOM scope) apart from an unrelated control elsewhere on the page. A pre-rendered
 * but hidden portal result that later becomes visible is covered by the field-anchored probe tier
 * instead, which requires proximity or an ARIA link before trusting it. */
async function markPageBaselineAuthoritative(page: Page): Promise<void> {
  await page
    .locator(DEALER_RESULT_SELECTOR)
    .evaluateAll((els: Element[], attr: string) => {
      els.forEach((el) => el.setAttribute(attr, "1"));
    }, DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR)
    .catch(() => {});
}

/** Marks the control already used to activate the lookup (a trigger click, or the field itself
 * for a keyboard-only activation) so a later confirm-control search never re-selects it. */
const DEALER_ALREADY_ACTIVATED_ATTR = "data-nav-engine-dealer-already-activated";

/**
 * Freezes a Locator to a stable ElementHandle pointing at the exact node found right now.
 * Required before marking or clicking anything this module tracks across a DOM mutation: a
 * Locator is a lazy, re-resolving selector, not a fixed reference -- re-running a selector that
 * itself excludes "already activated" elements (every authoritative/candidate locator here does)
 * after marking an element would make that very query stop matching the element it just marked,
 * and re-running a selector after the widget's own JS has swapped the matched node out for a
 * different one (a suggestion replaced by the real dealer result) would silently operate on
 * whatever now happens to occupy that same query position instead.
 */
async function freeze(locator: Locator): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  return locator.elementHandle({ timeout: 500 }).catch(() => null);
}

async function markAlreadyActivated(handle: ElementHandle<SVGElement | HTMLElement>): Promise<void> {
  await handle.evaluate((el, attr) => el.setAttribute(attr, "1"), DEALER_ALREADY_ACTIVATED_ATTR).catch(() => {});
}

/** Retires every result visible at the moment a stage's selection is about to be clicked -- its
 * unselected siblings (the rest of a radio group or suggestion list) belong to that same stage and
 * must never be picked up as the next stage's result, which would silently replace the verified
 * selection. Run before the click, so results the click itself renders are never retired. */
async function retireVisibleStageResults(page: Page): Promise<void> {
  const retire = (els: Element[], attr: string) => {
    els.forEach((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none") el.setAttribute(attr, "1");
    });
  };
  await page.locator(DEALER_RESULT_SELECTOR).evaluateAll(retire, DEALER_ALREADY_ACTIVATED_ATTR).catch(() => {});
  for (const frame of sameOriginChildFrames(page)) {
    await frame.locator(DEALER_RESULT_SELECTOR).evaluateAll(retire, DEALER_ALREADY_ACTIVATED_ATTR).catch(() => {});
  }
}

/**
 * After a location/postcode suggestion has been selected, some widgets (Pattern C) still require
 * an explicit OK/search/confirm control -- distinct from whichever control (if any) opened the
 * suggestion list in the first place -- before dealer results appear at all. Looked for only among
 * vocabulary-matched, visible, enabled controls already structurally scoped to this widget; never
 * re-clicks a control already marked as used. Returns a frozen handle (see freeze()), not a
 * Locator, since the caller marks it before clicking.
 */
async function findUnclickedConfirmControl(scope: Locator): Promise<ElementHandle<SVGElement | HTMLElement> | null> {
  const candidates = scope.locator(`:is(button, input[type="button"], input[type="submit"], [role="button"]):not([${DEALER_ALREADY_ACTIVATED_ATTR}])`);
  const count = await candidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const visible = await candidate.isVisible().catch(() => false);
    if (!visible) continue;
    const enabled = await candidate.isEnabled().catch(() => false);
    if (!enabled) continue;
    const text = await candidate.evaluate((el) => el.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("value") ?? "").catch(() => "");
    if (matchesLookupTriggerVocabulary(text)) return freeze(candidate);
  }
  return null;
}

/** Bounded, early-exit window for a selection's commit evidence to appear -- a widget routinely
 * writes its hidden identifier only after its own follow-up request returns, well after the click. */
const SELECTION_COMMIT_WAIT_MS = 1500;

interface SelectionCommitEvidence {
  /** The clicked element itself carries checked / aria-checked / aria-selected / aria-pressed. */
  selectedState: boolean;
  /** A hidden input went from empty to populated (or a dealer/location identifier was inserted)
   * between the snapshot taken right before this click and now. */
  hiddenCommit: boolean;
  hiddenPurposes: HiddenFieldPurpose[];
}

/**
 * A clicked result doesn't by itself prove the widget's own JS committed the selection. Positive
 * evidence only: the result's own selected/checked/pressed state, or a hidden input committing.
 * Never a visible text change, never a request completing, never the field showing the typed or
 * selected text. Takes a frozen handle, never a Locator -- a selection is very often the widget's
 * own cue to replace that exact element, and evaluating a still-lazy Locator whose node is already
 * gone would otherwise fall back to Playwright's own ~30s default actionability wait.
 */
async function waitForSelectionCommit(
  page: Page,
  option: ElementHandle<SVGElement | HTMLElement>,
  probe: DealerLookupProbe,
  hiddenBefore: HiddenFieldState[],
): Promise<SelectionCommitEvidence> {
  const deadline = Date.now() + SELECTION_COMMIT_WAIT_MS;
  let evidence: SelectionCommitEvidence = { selectedState: false, hiddenCommit: false, hiddenPurposes: [] };
  while (true) {
    await page.waitForTimeout(150);
    const selectedState = await option
      .evaluate(
        (el: Element) =>
          (el as HTMLInputElement).checked === true ||
          el.getAttribute("aria-checked") === "true" ||
          el.getAttribute("aria-selected") === "true" ||
          el.getAttribute("aria-pressed") === "true",
      )
      .catch(() => false);
    const hidden = detectHiddenCommit(hiddenBefore, await probe.hiddenState());
    evidence = { selectedState, hiddenCommit: hidden.committed, hiddenPurposes: hidden.purposes };
    if (selectedState || hidden.committed || Date.now() >= deadline) return evidence;
  }
}

/** Clicks a frozen element with the implicit-submit guard told to let exactly this element through. */
async function guardedClick(probe: DealerLookupProbe, handle: ElementHandle<SVGElement | HTMLElement>): Promise<void> {
  await probe.allow(handle);
  await handle.click({ timeout: 5000 }).catch(() => {});
  await probe.allow(null);
}

/**
 * Diagnostic-only (see src/diagnostics/dealerLookupDiagnostic.ts) blow-by-blow record of what
 * resolveDealerLookup actually did and observed. Never includes a typed value, a selected result's
 * own text, a hidden input's value, or any other page text -- identity is reported positionally or
 * structurally only, and state as booleans, counts and lengths.
 */
export type DealerLookupEvent =
  | "type_with_keyboard"
  | "fill_input_fallback"
  | "press_arrowdown"
  | "press_enter"
  | "press_tab"
  | "click_trigger"
  | "click_location_suggestion"
  | "click_confirm_control"
  | "click_dealer_result";

/** One bounded step of the activation ladder or selection sequence, and what followed it. */
export interface DealerActivationStepRecord {
  step: string;
  durationMs: number;
  /** Whether the field still held exactly the typed value (whitespace/case-insensitive) after this
   * step -- a boolean only, never the value. Null when not applicable (no value was typed). */
  fieldValueRetained: boolean | null;
  focusInField: boolean;
  fieldAriaExpanded: boolean | null;
  fieldActiveDescendantPresent: boolean;
  /** Character-count delta of the widget scope's own text, never the text. */
  scopeTextLengthDelta: number;
  domMutationCount: number;
  hiddenFieldCommitObserved: boolean;
  alertOrStatusSurfaceChanged: boolean;
  noResultsMessageObserved: boolean;
  loadingIndicatorVisible: boolean;
  resultCandidateObserved: boolean;
  requestsStarted: number;
  lookupLikeRequestsStarted: number;
  implicitSubmitBlocked: boolean;
  geolocationRequested: boolean;
  /** A lookup-like request, a loading/busy state, or the field's own aria-expanded turning true. */
  lookupActivityObserved: boolean;
}

export type DealerTriggerClassification = "vocabulary_matched" | "textless_unknown" | "geolocation_control" | "other_text" | "no_trigger";

/**
 * Lowest-level deterministic explanation for an unresolved lookup, derived only from recorded
 * evidence, in priority order. Null when the lookup verified.
 */
export type DealerLookupFailureClassification =
  | "field_value_not_retained"
  | "trigger_requested_geolocation_and_nothing_else_reacted"
  | "lookup_request_failed"
  | "lookup_request_returned_empty_results"
  | "lookup_request_returned_records_but_no_result_rendered"
  | "lookup_request_still_pending_at_timeout"
  | "field_reported_invalid"
  | "no_results_message_observed"
  | "result_selected_but_commit_not_verified"
  | "location_selected_but_no_dealer_result_or_commit"
  | "dom_changed_without_selectable_result"
  | "no_reaction_to_any_activation";

export type DealerLookupRetryRecommendation = "none" | "await_pending_lookup";

export interface DealerLookupExecutionTrace {
  eventsDispatched: DealerLookupEvent[];
  waitCondition: string;
  waitTimeoutMs: number;
  waitOutcome: "resolved" | "timed_out";
  suggestionsDetected: boolean;
  suggestionCount: number;
  /** Positional only -- e.g. "result[0]" -- never the selected result's own text content. */
  selectedSuggestionIdentity: string | null;
  secondStageSuggestionCount: number | null;
  /** True when a selected result carried no ARIA radio/option semantics and was found as a new,
   * visible, generically-clickable element instead. */
  genericCandidateFallbackUsed: boolean;
  /** True when a location/postcode suggestion list appeared from real typing alone, before any
   * escalation (arrow key, Enter, Tab or trigger click) was attempted. */
  autoDropdownDetected: boolean;
  /** True when a distinct OK/search/confirm control (never the same element twice) was found
   * and clicked after a location suggestion was selected, before polling for dealer results
   * (Pattern C). */
  confirmControlClicked: boolean;
  /** Which bounded stage actually ran out of time, or null if every stage that ran resolved
   * within its own bound (whether or not a dealer was ultimately verified). */
  timedOutStage: "location_suggestions" | "dealer_results" | null;
  /** True when a generic loading indicator (aria-busy/role=progressbar/role=status) was still
   * visibly active right at a stage's base timeout. */
  loadingIndicatorObservedAtTimeout: boolean;
  /** True when a stage's wait was actually extended past its base bound because of an observed
   * loading indicator or a still-pending lookup-like request -- still capped by its hard maximum. */
  stageWaitExtended: boolean;
  /** True when the selected result was found outside the trigger/field's own DOM-containment
   * scope. Null when no result was ever selected at all. */
  resultFoundOutsideScope: boolean | null;
  /** True when the selected generic-fallback result already existed in the DOM before the lookup
   * started, merely hidden. Null when no generic candidate was ever selected. */
  wasPreExistingHiddenElement: boolean | null;
  /** Sanitised request evidence observed during this call -- see dealerLookupNetwork.ts. Never a
   * request/response body, never a typed or returned value. */
  networkRequests: SanitizedNetworkRequestEvidence[];
  /** True when the postcode/location field itself carried aria-invalid="true" at the moment a
   * stage timed out with no result -- never the validation message text itself. */
  fieldAriaInvalidAtTimeout: boolean;
  /** True when the field's native validationMessage was non-empty at the moment a stage timed out
   * with no result -- presence only, never the message text itself. */
  fieldHasNativeValidationMessageAtTimeout: boolean;
  /** True when a hidden input in the enclosing form committed (empty to populated, or a
   * dealer/location identifier inserted) as part of the verification that decided this outcome.
   * Null when verification was decided by a selected result's own checked/selected state instead. */
  hiddenFieldCommitDetected: boolean | null;
  /** Every bounded step actually run, in order, with what followed it. */
  activationSteps: DealerActivationStepRecord[];
  inputMethod: "keyboard" | "fill_fallback" | "none";
  /** Whether the field still held the typed value right after input -- a boolean only. */
  fieldValueRetainedAfterInput: boolean | null;
  triggerClassification: DealerTriggerClassification;
  /** Why an associated trigger was deliberately not clicked, or null when it was clicked/absent. */
  triggerClickSkippedReason: string | null;
  /** Lead-form submit events or submit-control clicks the implicit-submission guard cancelled. */
  implicitSubmitBlockedCount: number;
  /** The first step whose observation window showed lookup activity, or null if none did. */
  lookupActivityStep: string | null;
  /** Requests observed but omitted from networkRequests by its output bound. */
  networkRequestsOmittedCount: number;
  trackingRequestCount: number;
  /** Semantic purpose (from name/id tokens, never the value) of each hidden input whose commit
   * counted as evidence. */
  hiddenFieldCommitPurposes: HiddenFieldPurpose[];
  /** True when the selected result was found in a same-origin child frame. Null when no result was
   * ever selected. */
  resultFoundInFrame: boolean | null;
  /** Whether a deterministic corrective retry exists: only waiting on a lookup that was observably
   * still in flight. Never a blind re-run of the same input sequence. */
  retryRecommendation: DealerLookupRetryRecommendation;
  lookupFailureClassification: DealerLookupFailureClassification | null;
  /** Human-readable explanation of lookupFailureClassification, built only from recorded evidence. */
  lookupFailureExplanation: string;
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

const DEALER_WAIT_CONDITION =
  "an authoritative ARIA/native-radio result, a new eligible generic candidate in scope, a new page-wide authoritative result, a field-anchored or ARIA-linked portal/overlay result, or a same-origin frame result";

/** Observation window after each escalation step. Short on purpose: a step that starts a lookup is
 * recognised by its activity signals and handed to the full, extendable stage wait instead. */
const ESCALATION_OBSERVE_MS: Record<string, number> = {
  press_arrowdown: 400,
  press_enter: 600,
  press_tab: 600,
  click_trigger: 800,
};
const OBSERVE_POLL_MS = 150;
const KEYBOARD_TYPING_DELAY_MS = 35;

export interface ResolveDealerLookupOptions {
  /** The postcode/city to enter. Typed by this function -- never echoed into any diagnostic. */
  value: string;
  /** "await_pending_lookup" re-polls a lookup that was observably still in flight, without
   * re-entering the value or re-activating anything (which could reset it). */
  mode?: "full" | "await_pending_lookup";
}

/**
 * Generic multi-stage state machine for the postcode/city -> location -> dealer workflow:
 *   0. INPUT -- focus, clear, real keyboard typing, then verify the field still holds the value
 *      (falling back to fill() only when real typing was not retained).
 *   1. ACTIVATION LADDER -- observe whether the lookup starts by itself (no premature blur, which
 *      cancels debounced autocompletes), then escalate one bounded step at a time: ArrowDown,
 *      Enter, Tab, then the semantically associated trigger (skipped when it is a geolocation
 *      control). A step that shows lookup activity hands over to the full stage wait immediately,
 *      and escalation only resumes once that lookup has completed without a result -- an active
 *      lookup is never reset by a further key or click. The whole call runs under an
 *      implicit-submission guard, so no key or click here can submit the lead form.
 *   2. LOCATION SUGGESTIONS -- an independently bounded, adaptive poll across every supported
 *      result surface (scope, page-wide, ARIA-linked, portal, newly visible, same-origin frame).
 *   3. LOCATION SELECTION -- select the first result; verify via its own selected state or a
 *      hidden-input commit, never a text change.
 *   4. CONFIRM-CONTROL RESCAN -- only if a dealer-results widget hasn't already appeared (Pattern C).
 *   5. DEALER RESULTS -- a second, independently bounded, adaptive poll.
 *   6. DEALER SELECTION -- select and verify the dealer, recognise a hidden-identifier
 *      auto-population (Pattern D), or that the stage-1 selection already was the dealer.
 */
export async function resolveDealerLookup(
  page: Page,
  scope: Locator,
  trigger: Locator | null,
  field: Locator,
  form: Locator,
  options: ResolveDealerLookupOptions,
): Promise<DealerLookupOutcome> {
  const capture = startDealerLookupNetworkCapture(page);
  const probe = await startDealerLookupProbe(form, field, scope);
  try {
    const outcome = await resolveDealerLookupCore(page, scope, trigger, field, form, options, probe, capture);
    const requests = await capture.stop();
    const stats = capture.stats();
    const trace = outcome.executionTrace;
    const changedSteps = new Map(
      trace.activationSteps.map((s) => [
        s.step,
        s.domMutationCount > 0 || s.hiddenFieldCommitObserved || s.scopeTextLengthDelta !== 0 || s.resultCandidateObserved || s.alertOrStatusSurfaceChanged,
      ]),
    );
    requests.forEach((r) => {
      r.followedByObservableChange = changedSteps.has(r.activationStep) ? changedSteps.get(r.activationStep)! : null;
    });
    trace.networkRequests = requests;
    trace.networkRequestsOmittedCount = stats.omittedRequestCount;
    trace.trackingRequestCount = stats.trackingRequestCount;
    if (outcome.dealerValueVerified) {
      trace.lookupFailureClassification = null;
      trace.lookupFailureExplanation = "";
      trace.retryRecommendation = "none";
    } else {
      const classified = classifyLookupFailure(outcome, requests);
      trace.lookupFailureClassification = classified.classification;
      trace.lookupFailureExplanation = classified.explanation;
      trace.retryRecommendation = classified.classification === "lookup_request_still_pending_at_timeout" ? "await_pending_lookup" : "none";
    }
    return outcome;
  } catch (error) {
    await capture.stop().catch(() => {});
    throw error;
  } finally {
    await probe.stop();
  }
}

function describeSteps(trace: DealerLookupExecutionTrace): string {
  return trace.activationSteps.map((s) => s.step).join(" -> ") || "no step ran";
}

/** Evidence-only, priority-ordered explanation of an unresolved lookup. Never speculative: each
 * branch names the recorded signal it rests on. */
function classifyLookupFailure(
  outcome: DealerLookupOutcome,
  requests: SanitizedNetworkRequestEvidence[],
): { classification: DealerLookupFailureClassification; explanation: string } {
  const trace = outcome.executionTrace;
  const steps = trace.activationSteps;
  const sequence = describeSteps(trace);
  const lookupRequests = requests.filter((r) => isLookupLikePurpose(r.purpose));
  const anyResultCandidate = steps.some((s) => s.resultCandidateObserved) || trace.suggestionsDetected;
  const anyDomChange = steps.some((s) => s.domMutationCount > 0 || s.scopeTextLengthDelta !== 0);

  if (trace.fieldValueRetainedAfterInput === false) {
    return { classification: "field_value_not_retained", explanation: `the field did not keep the entered value after ${trace.inputMethod === "fill_fallback" ? "both real typing and the fill() fallback" : "input"}, so no lookup could run on it (sequence: ${sequence})` };
  }
  if (outcome.dealerSelected || (outcome.locationSuggestionsDetected && outcome.dealerResultsDetected)) {
    return { classification: "result_selected_but_commit_not_verified", explanation: `a result was selected but neither its own selected/checked state nor any hidden-input commit was observed within the bounded window (sequence: ${sequence})` };
  }
  if (outcome.locationSuggestionsDetected) {
    return { classification: "location_selected_but_no_dealer_result_or_commit", explanation: `a location result was selected but no dealer result appeared and no hidden identifier committed (sequence: ${sequence})` };
  }
  const geolocationTriggered = steps.some((s) => s.step === "click_trigger" && s.geolocationRequested);
  if (geolocationTriggered && lookupRequests.length === 0 && !anyResultCandidate) {
    return { classification: "trigger_requested_geolocation_and_nothing_else_reacted", explanation: `the associated control asked the browser for the device's position (a geolocation control, not a search for the typed value), and no other activation step produced a lookup request or a result (sequence: ${sequence})` };
  }
  if (lookupRequests.some((r) => r.outcome === "failed" || r.purpose === "server_error")) {
    return { classification: "lookup_request_failed", explanation: `a lookup-like request failed at the network level or returned a server error (sequence: ${sequence})` };
  }
  if (lookupRequests.some((r) => r.outcome === "completed" && r.appearsToContainRecords === true) && !anyResultCandidate) {
    return { classification: "lookup_request_returned_records_but_no_result_rendered", explanation: `a lookup-like request returned records, but no selectable result was found on any supported surface -- an unsupported rendering (cross-origin frame, closed shadow root, or canvas) is the remaining explanation (sequence: ${sequence})` };
  }
  if (lookupRequests.some((r) => r.outcome === "completed" && (r.resultCategory === "empty" || r.purpose === "empty_results" || r.purpose === "validation_error"))) {
    return { classification: "lookup_request_returned_empty_results", explanation: `a lookup-like request completed with an empty or error-shaped response (sequence: ${sequence})` };
  }
  if (lookupRequests.some((r) => r.outcome === "pending")) {
    return { classification: "lookup_request_still_pending_at_timeout", explanation: `a lookup-like request was still awaiting its response when the bounded wait ended (sequence: ${sequence})` };
  }
  if (trace.fieldAriaInvalidAtTimeout || trace.fieldHasNativeValidationMessageAtTimeout) {
    return { classification: "field_reported_invalid", explanation: `the field was marked invalid by the page when the wait ended (sequence: ${sequence})` };
  }
  if (steps.some((s) => s.noResultsMessageObserved)) {
    return { classification: "no_results_message_observed", explanation: `a visible "no result" style message appeared and no selectable result did (sequence: ${sequence})` };
  }
  if (anyDomChange || lookupRequests.length > 0) {
    return { classification: "dom_changed_without_selectable_result", explanation: `the page reacted (${lookupRequests.length} lookup-like request(s), DOM changes) but never produced a selectable result or a hidden-identifier commit on any supported surface (sequence: ${sequence})` };
  }
  return { classification: "no_reaction_to_any_activation", explanation: `no activation step produced any request, DOM change, ARIA state change or result (sequence: ${sequence})` };
}

async function classifyTrigger(trigger: Locator | null): Promise<{ classification: DealerTriggerClassification; skipReason: string | null }> {
  if (!trigger) return { classification: "no_trigger", skipReason: null };
  const info = await trigger
    .evaluate((el: Element) => {
      const parts = [
        el.getAttribute("aria-label") ?? "",
        el.getAttribute("title") ?? "",
        el.textContent ?? "",
        (el as HTMLInputElement).value ?? "",
        el.getAttribute("id") ?? "",
        typeof el.className === "string" ? el.className : "",
        el.getAttribute("data-testid") ?? "",
      ];
      el.querySelectorAll("[title], [aria-label], use, svg, i, span").forEach((child) => {
        parts.push(child.getAttribute("title") ?? "", child.getAttribute("aria-label") ?? "", typeof child.className === "string" ? child.className : "", child.getAttribute("href") ?? child.getAttribute("xlink:href") ?? "");
      });
      return {
        visibleText: (el.getAttribute("aria-label") || el.textContent || (el as HTMLInputElement).value || "").trim(),
        attributeText: parts.join(" "),
      };
    })
    .catch(() => ({ visibleText: "", attributeText: "" }));
  const attributeText = normalizeText(info.attributeText).replace(/[^a-z0-9]+/g, " ");
  if (GEOLOCATION_CONTROL_MARKERS.some((marker) => attributeText.includes(marker))) {
    return { classification: "geolocation_control", skipReason: "trigger_matches_geolocation_vocabulary" };
  }
  if (info.visibleText.length === 0) return { classification: "textless_unknown", skipReason: null };
  return { classification: matchesLookupTriggerVocabulary(info.visibleText) ? "vocabulary_matched" : "other_text", skipReason: null };
}

async function resolveDealerLookupCore(
  page: Page,
  scope: Locator,
  trigger: Locator | null,
  field: Locator,
  form: Locator,
  options: ResolveDealerLookupOptions,
  probe: DealerLookupProbe,
  network: DealerLookupNetworkCapture,
): Promise<DealerLookupOutcome> {
  const mode = options.mode ?? "full";
  const typed = options.value;
  const eventsDispatched: DealerLookupEvent[] = [];
  const activationSteps: DealerActivationStepRecord[] = [];
  let implicitSubmitBlockedCount = 0;
  let lookupActivityStep: string | null = null;

  const baselineHidden = await probe.hiddenState();
  if (mode === "full") await markBaselineCandidates(scope);
  // Page-wide baseline, independent of the scope-local one above -- lets the page-wide fallback
  // tier distinguish a genuinely new, portal-rendered result from an unrelated pre-existing control
  // elsewhere on the page that merely shares the same ARIA role.
  await markPageBaselineAuthoritative(page);
  await markFrameBaselineAuthoritative(page);
  const ctx: DiscoveryContext = { page, scope, probe, network, stageSeq: await probe.markStage() };
  let previous = await probe.snapshot(typed);
  let lastHidden = baselineHidden;

  /** Runs one bounded observation window after `stepName`, stopping early on a result or on
   * lookup activity, then records what the step changed. */
  async function observeStep(stepName: string, windowMs: number, stepStartMs: number): Promise<{ result: FoundResult | null; activity: boolean }> {
    const started = Date.now();
    let result: FoundResult | null = null;
    let activity = false;
    while (true) {
      result = await findResultOnce(ctx);
      if (result) break;
      const now = await probe.snapshot(typed);
      const requestActivity = network.activitySince(stepStartMs).lookupLike > 0;
      const expandedTurnedOn = now.fieldAriaExpanded === true && previous.fieldAriaExpanded !== true;
      if (requestActivity || now.busy || expandedTurnedOn) {
        activity = true;
        break;
      }
      if (Date.now() - started >= windowMs) break;
      await page.waitForTimeout(OBSERVE_POLL_MS);
    }
    await recordStep(stepName, started, stepStartMs, result !== null, activity);
    return { result, activity };
  }

  async function recordStep(stepName: string, startedAt: number, stepStartMs: number, resultCandidateObserved: boolean, activity: boolean): Promise<void> {
    const now = await probe.snapshot(typed);
    const hidden = await probe.hiddenState();
    const requests = network.activitySince(stepStartMs);
    const blocked = now.blockedSubmitEvents + now.blockedSubmitClicks - (previous.blockedSubmitEvents + previous.blockedSubmitClicks);
    implicitSubmitBlockedCount += Math.max(0, blocked);
    const lookupActivityObserved = activity || requests.lookupLike > 0 || now.busy || (now.fieldAriaExpanded === true && previous.fieldAriaExpanded !== true);
    if (lookupActivityObserved && lookupActivityStep === null) lookupActivityStep = stepName;
    activationSteps.push({
      step: stepName,
      durationMs: Date.now() - startedAt,
      fieldValueRetained: now.fieldValueRetained,
      focusInField: now.focusInField,
      fieldAriaExpanded: now.fieldAriaExpanded,
      fieldActiveDescendantPresent: now.fieldActiveDescendantPresent,
      scopeTextLengthDelta: now.scopeTextLength - previous.scopeTextLength,
      domMutationCount: Math.max(0, now.mutationCount - previous.mutationCount),
      hiddenFieldCommitObserved: detectHiddenCommit(lastHidden, hidden).committed,
      alertOrStatusSurfaceChanged: now.surfaceCount !== previous.surfaceCount || now.surfaceTextLength !== previous.surfaceTextLength,
      noResultsMessageObserved: now.noResultsMessageObserved,
      loadingIndicatorVisible: now.busy,
      resultCandidateObserved,
      requestsStarted: requests.started,
      lookupLikeRequestsStarted: requests.lookupLike,
      implicitSubmitBlocked: blocked > 0,
      geolocationRequested: now.geolocationRequests > previous.geolocationRequests,
      lookupActivityObserved,
    });
    previous = now;
    lastHidden = hidden;
  }

  async function fullStageWait(stepName: string): Promise<StagePollResult> {
    const stepStartMs = network.now();
    network.setStep(stepName);
    const started = Date.now();
    const poll = await pollForStageResult(ctx, DEALER_RESULT_WAIT_TIMEOUT_MS, DEALER_STAGE_WAIT_EXTENSION_MS, DEALER_STAGE_WAIT_MAX_MS);
    await recordStep(stepName, started, stepStartMs, poll.result !== null, poll.extended);
    return poll;
  }

  // Stage 0: real input.
  let inputMethod: "keyboard" | "fill_fallback" | "none" = "none";
  let fieldValueRetainedAfterInput: boolean | null = null;
  let autoDropdownDetected = false;
  let stage1: StagePollResult = { result: null, timedOut: false, extended: false, loadingIndicatorObserved: false, pendingRequestObservedAtTimeout: false };
  let fullWaitRan = false;
  const triggerInfo = await classifyTrigger(trigger);

  if (mode === "full") {
    const inputStartMs = network.now();
    network.setStep("keyboard_input");
    const inputStarted = Date.now();
    await field.focus().catch(() => {});
    await field.fill("").catch(() => {});
    let typedOk = await field
      .pressSequentially(typed, { delay: KEYBOARD_TYPING_DELAY_MS })
      .then(() => true)
      .catch(() => false);
    inputMethod = "keyboard";
    eventsDispatched.push("type_with_keyboard");
    let retained = (await probe.snapshot(typed)).fieldValueRetained;
    if (retained === null) {
      const current = await field.inputValue().catch(() => "");
      retained = normalizeText(current).replace(/\s+/g, "") === normalizeText(typed).replace(/\s+/g, "");
    }
    if (!typedOk || !retained) {
      // A masked/formatted input can legitimately reject per-key typing; fill() sets the value
      // directly and fires input/change, which such widgets usually accept.
      await field.fill(typed).catch(() => {});
      inputMethod = "fill_fallback";
      eventsDispatched.push("fill_input_fallback");
      const current = await field.inputValue().catch(() => "");
      retained = normalizeText(current).replace(/\s+/g, "") === normalizeText(typed).replace(/\s+/g, "");
      typedOk = true;
    }
    fieldValueRetainedAfterInput = retained;
    await recordStep("keyboard_input", inputStarted, inputStartMs, false, false);

    // Observe whether real typing alone starts the lookup (debounced autocompletes need the field
    // to keep focus -- the old immediate blur() cancelled them).
    const autoStartMs = network.now();
    network.setStep("observe_auto_lookup");
    const auto = await observeStep("observe_auto_lookup", DEALER_AUTO_APPEAR_CHECK_MS, autoStartMs);
    if (auto.result) {
      stage1 = { ...stage1, result: auto.result };
      autoDropdownDetected = true;
    } else if (auto.activity) {
      stage1 = await fullStageWait("await_lookup_results");
      fullWaitRan = true;
      autoDropdownDetected = stage1.result !== null;
    }

    const escalation: { name: string; event: DealerLookupEvent; run: () => Promise<void> }[] = [
      { name: "press_arrowdown", event: "press_arrowdown", run: () => field.press("ArrowDown").catch(() => {}) },
      { name: "press_enter", event: "press_enter", run: () => field.press("Enter").catch(() => {}) },
      { name: "press_tab", event: "press_tab", run: () => field.press("Tab").catch(() => {}) },
    ];
    if (trigger && triggerInfo.skipReason === null) {
      escalation.push({
        name: "click_trigger",
        event: "click_trigger",
        run: async () => {
          // Freeze and mark BEFORE clicking, never after -- a click that causes the widget's own JS
          // to swap the trigger out of the DOM would otherwise make a lazily-re-resolving locator
          // mark whatever element happens to occupy that same position afterward instead.
          const triggerHandle = await freeze(trigger);
          if (triggerHandle) {
            await markAlreadyActivated(triggerHandle);
            await guardedClick(probe, triggerHandle);
          } else {
            await trigger.click({ timeout: 5000 }).catch(() => {});
          }
        },
      });
    }

    for (const step of escalation) {
      if (stage1.result) break;
      // Never escalate over a lookup that is observably still in flight -- a further key or click
      // could reset it.
      if (fullWaitRan && (stage1.pendingRequestObservedAtTimeout || (await loadingIndicatorVisible(ctx)))) break;
      const stepStartMs = network.now();
      network.setStep(step.name);
      await step.run();
      eventsDispatched.push(step.event);
      const observed = await observeStep(step.name, ESCALATION_OBSERVE_MS[step.name] ?? 600, stepStartMs);
      if (observed.result) {
        stage1 = { ...stage1, result: observed.result };
        break;
      }
      if (observed.activity) {
        stage1 = await fullStageWait("await_lookup_results");
        fullWaitRan = true;
      }
    }
  }

  if (!stage1.result && (!fullWaitRan || mode === "await_pending_lookup")) {
    stage1 = await fullStageWait(mode === "await_pending_lookup" ? "await_pending_lookup" : "await_lookup_results");
  }

  const suggestionCount = await scope.locator(DEALER_RESULT_SELECTOR).count().catch(() => 0);
  const validationAtTimeout = await readFieldValidationState(field);

  const baseTrace = (): DealerLookupExecutionTrace => ({
    eventsDispatched,
    waitCondition: DEALER_WAIT_CONDITION,
    waitTimeoutMs: DEALER_RESULT_WAIT_TIMEOUT_MS,
    waitOutcome: "timed_out",
    suggestionsDetected: false,
    suggestionCount,
    selectedSuggestionIdentity: null,
    secondStageSuggestionCount: null,
    genericCandidateFallbackUsed: false,
    autoDropdownDetected,
    confirmControlClicked: false,
    timedOutStage: null,
    loadingIndicatorObservedAtTimeout: stage1.loadingIndicatorObserved,
    stageWaitExtended: stage1.extended,
    resultFoundOutsideScope: null,
    wasPreExistingHiddenElement: null,
    networkRequests: [],
    fieldAriaInvalidAtTimeout: false,
    fieldHasNativeValidationMessageAtTimeout: false,
    hiddenFieldCommitDetected: null,
    activationSteps,
    inputMethod,
    fieldValueRetainedAfterInput,
    triggerClassification: triggerInfo.classification,
    triggerClickSkippedReason: triggerInfo.skipReason,
    implicitSubmitBlockedCount,
    lookupActivityStep,
    networkRequestsOmittedCount: 0,
    trackingRequestCount: 0,
    hiddenFieldCommitPurposes: [],
    resultFoundInFrame: null,
    retryRecommendation: "none",
    lookupFailureClassification: null,
    lookupFailureExplanation: "",
  });
  const refreshCounters = (trace: DealerLookupExecutionTrace): DealerLookupExecutionTrace => ({ ...trace, implicitSubmitBlockedCount, lookupActivityStep });

  if (!stage1.result) {
    // Nothing selectable ever appeared. The only signal accepted as proof of a committed
    // dealer/location identifier here is a hidden input committing -- never a visible text change,
    // which was confirmed in production to fire from unrelated causes (a validation message, a
    // loading string, an error from a geolocation control) with no identifier ever committed.
    await page.waitForTimeout(600);
    const hidden = detectHiddenCommit(baselineHidden, await probe.hiddenState());
    const scopeTextGrew = activationSteps.reduce((sum, s) => sum + s.scopeTextLengthDelta, 0) > 0;
    const trace: DealerLookupExecutionTrace = {
      ...baseTrace(),
      timedOutStage: "location_suggestions",
      fieldAriaInvalidAtTimeout: validationAtTimeout.ariaInvalid,
      fieldHasNativeValidationMessageAtTimeout: validationAtTimeout.hasNativeValidationMessage,
      hiddenFieldCommitDetected: hidden.committed,
      hiddenFieldCommitPurposes: hidden.purposes,
    };

    if (hidden.committed) {
      return {
        dealerLookupTriggered: true,
        dealerLookupOutcome: "auto_populated",
        locationSuggestionsDetected: false,
        locationSuggestionSelected: false,
        dealerResultsDetected: false,
        dealerAutoPopulated: true,
        dealerSelected: false,
        dealerValueVerified: true,
        dealerVerificationEvidence: "dealer_lookup_scope_hidden_identifier_committed_after_trigger",
        executionTrace: refreshCounters(trace),
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
      dealerLookupFailureReason: scopeTextGrew
        ? "visible_scope_text_changed_but_no_hidden_identifier_committed_within_timeout"
        : "no_selectable_result_and_no_text_change_within_timeout",
      executionTrace: refreshCounters(trace),
    };
  }

  // Stage 1: select the location/postcode suggestion. Mark before clicking (see the trigger click
  // above), and snapshot hidden state right before the click so only this click's commit counts.
  const stage1Found = stage1.result;
  const stage1HiddenBefore = await probe.hiddenState();
  await markAlreadyActivated(stage1Found.handle);
  await retireVisibleStageResults(page);
  const stage1StartMs = network.now();
  network.setStep("click_location_suggestion");
  const stage1ClickStarted = Date.now();
  await guardedClick(probe, stage1Found.handle);
  eventsDispatched.push("click_location_suggestion");
  const stage1Commit = await waitForSelectionCommit(page, stage1Found.handle, probe, stage1HiddenBefore);
  await recordStep("click_location_suggestion", stage1ClickStarted, stage1StartMs, true, false);
  const stage1Verified = stage1Commit.selectedState || stage1Commit.hiddenCommit;
  const afterStage1Hidden = await probe.hiddenState();

  // Re-baseline so this stage's own elements never register as "new" in the next stage.
  await markBaselineCandidates(scope);
  ctx.stageSeq = await probe.markStage();

  // Stage 2 (Pattern C): a distinct confirm/OK/search control, not yet clicked, only if a
  // dealer-results widget hasn't already appeared on its own.
  let confirmControlClicked = false;
  const alreadyDealerVisible = await scope
    .locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}])`)
    .first()
    .isVisible()
    .catch(() => false);
  if (!alreadyDealerVisible) {
    const confirmControl = await findUnclickedConfirmControl(scope);
    if (confirmControl) {
      await markAlreadyActivated(confirmControl);
      const confirmStartMs = network.now();
      network.setStep("click_confirm_control");
      const confirmStarted = Date.now();
      await guardedClick(probe, confirmControl);
      confirmControlClicked = true;
      eventsDispatched.push("click_confirm_control");
      await recordStep("click_confirm_control", confirmStarted, confirmStartMs, false, false);
      await markBaselineCandidates(scope);
      ctx.stageSeq = await probe.markStage();
    }
  }

  // Stage 3: dealer results, independently bounded from stage 1/2.
  const stage3 = await fullStageWait("await_dealer_results");
  const secondStageSuggestionCount = await scope.locator(DEALER_RESULT_SELECTOR).count().catch(() => 0);
  const stage1Trace = (): DealerLookupExecutionTrace => ({
    ...baseTrace(),
    waitOutcome: "resolved",
    suggestionsDetected: true,
    selectedSuggestionIdentity: "result[0]",
    secondStageSuggestionCount,
    genericCandidateFallbackUsed: !stage1Found.authoritative,
    confirmControlClicked,
    loadingIndicatorObservedAtTimeout: stage3.loadingIndicatorObserved,
    stageWaitExtended: stage3.extended,
    resultFoundOutsideScope: stage1Found.foundOutsideScope,
    resultFoundInFrame: stage1Found.foundInFrame,
    wasPreExistingHiddenElement: stage1Found.authoritative ? null : stage1Found.wasPreExistingHiddenElement,
  });

  if (stage3.result) {
    const dealerFound = stage3.result;
    const dealerHiddenBefore = await probe.hiddenState();
    const dealerStartMs = network.now();
    network.setStep("click_dealer_result");
    const dealerClickStarted = Date.now();
    await guardedClick(probe, dealerFound.handle);
    eventsDispatched.push("click_dealer_result");
    const dealerCommit = await waitForSelectionCommit(page, dealerFound.handle, probe, dealerHiddenBefore);
    await recordStep("click_dealer_result", dealerClickStarted, dealerStartMs, true, false);
    const dealerVerified = dealerCommit.selectedState || dealerCommit.hiddenCommit;
    const dealerWasGeneric = !dealerFound.authoritative;

    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: dealerVerified ? (dealerWasGeneric ? "suggestion_selected" : "dealer_selected") : "unresolved",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: true,
      dealerResultsDetected: true,
      dealerAutoPopulated: false,
      dealerSelected: true,
      dealerValueVerified: dealerVerified,
      dealerVerificationEvidence: dealerVerified
        ? dealerCommit.selectedState
          ? "selected_result_carries_checked_or_aria_checked_or_aria_selected_state"
          : "hidden_identifier_committed_after_dealer_selection"
        : "no_committed_state_detected_on_selected_result",
      dealerLookupFailureReason: dealerVerified ? undefined : "selectable_result_found_but_commit_state_never_verified",
      executionTrace: refreshCounters({
        ...stage1Trace(),
        selectedSuggestionIdentity: "dealer_result[0]",
        genericCandidateFallbackUsed: !stage1Found.authoritative || dealerWasGeneric,
        resultFoundOutsideScope: dealerFound.foundOutsideScope,
        resultFoundInFrame: dealerFound.foundInFrame,
        wasPreExistingHiddenElement: dealerWasGeneric ? dealerFound.wasPreExistingHiddenElement : null,
        hiddenFieldCommitDetected: dealerCommit.selectedState ? null : dealerCommit.hiddenCommit,
        hiddenFieldCommitPurposes: dealerCommit.hiddenPurposes,
      }),
    };
  }

  // No distinct dealer-results stage ever appeared. Either the dealer auto-populated as a hidden
  // identifier after the location selection (Pattern D), the location selection itself already WAS
  // the dealer (Pattern B's single-widget case), or nothing verifiable happened.
  const furtherHidden = detectHiddenCommit(afterStage1Hidden, await probe.hiddenState());

  if (furtherHidden.committed) {
    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: "auto_populated",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: confirmControlClicked || stage1Verified,
      dealerResultsDetected: false,
      dealerAutoPopulated: true,
      dealerSelected: false,
      dealerValueVerified: true,
      dealerVerificationEvidence: "hidden_identifier_committed_after_location_selection_with_no_selectable_dealer_result",
      executionTrace: refreshCounters({
        ...stage1Trace(),
        waitOutcome: "timed_out",
        timedOutStage: "dealer_results",
        hiddenFieldCommitDetected: true,
        hiddenFieldCommitPurposes: furtherHidden.purposes,
      }),
    };
  }

  if (stage1Verified) {
    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: stage1Found.authoritative ? "dealer_selected" : "suggestion_selected",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: false,
      dealerResultsDetected: true,
      dealerAutoPopulated: false,
      dealerSelected: true,
      dealerValueVerified: true,
      dealerVerificationEvidence: stage1Commit.selectedState
        ? "selected_result_carries_checked_or_aria_checked_or_aria_selected_state"
        : "hidden_identifier_committed_after_selection_with_no_distinct_dealer_stage",
      executionTrace: refreshCounters({
        ...stage1Trace(),
        timedOutStage: stage3.timedOut ? "dealer_results" : null,
        hiddenFieldCommitDetected: stage1Commit.selectedState ? null : true,
        hiddenFieldCommitPurposes: stage1Commit.hiddenPurposes,
      }),
    };
  }

  // A selectable (ARIA/native) result that was clicked, never committed, and was followed by no
  // further stage is the single-widget dealer case: report it as an uncommitted dealer selection,
  // not as a location step whose dealer list never came.
  const uncommittedSelectableResult = stage1Found.authoritative && !confirmControlClicked;
  return {
    dealerLookupTriggered: true,
    dealerLookupOutcome: "unresolved",
    locationSuggestionsDetected: true,
    locationSuggestionSelected: confirmControlClicked,
    dealerResultsDetected: uncommittedSelectableResult,
    dealerAutoPopulated: false,
    dealerSelected: uncommittedSelectableResult,
    dealerValueVerified: false,
    dealerVerificationEvidence: uncommittedSelectableResult
      ? "no_committed_state_detected_on_selected_result"
      : "no_selected_state_or_hidden_identifier_commit_after_location_selection",
    dealerLookupFailureReason: uncommittedSelectableResult
      ? "selectable_result_found_but_commit_state_never_verified"
      : "location_selected_but_no_selectable_dealer_result_and_no_hidden_identifier_commit_within_timeout",
    executionTrace: refreshCounters({
      ...stage1Trace(),
      waitOutcome: "timed_out",
      timedOutStage: "dealer_results",
      hiddenFieldCommitDetected: false,
    }),
  };
}
