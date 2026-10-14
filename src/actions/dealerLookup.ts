import type { ElementHandle, Locator, Page } from "playwright";
import { startDealerLookupNetworkCapture, summarizeDealerLookupNetworkActivity, type SanitizedNetworkRequestEvidence } from "./dealerLookupNetwork.js";

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

/** Positional snapshot of every hidden input's value within the given root (the enclosing form,
 * not the narrower trigger/field DOM scope -- a widget's own committed-value hidden field is
 * commonly a sibling of the visible widget markup, not nested inside it), in DOM order -- never
 * read by name/id (which would mean hard-coding a site's own field naming), only by position, so
 * a before/after comparison can tell whether any of them transitioned from empty to non-empty. */
async function snapshotHiddenInputValues(root: Locator): Promise<string[]> {
  return root
    .evaluate((el: Element) => Array.from(el.querySelectorAll('input[type="hidden"]')).map((input) => (input as HTMLInputElement).value.trim()))
    .catch(() => []);
}

/** True only when the same positional hidden input went from empty to non-empty between two
 * snapshots -- never when the count of hidden inputs changed (that is far more likely to be an
 * unrelated widget mutating the DOM than a genuine commit) and never from a value that was
 * already non-empty before (which proves nothing about this lookup). */
function hasHiddenInputCommit(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return false;
  return before.some((value, index) => value.length === 0 && (after[index]?.length ?? 0) > 0);
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

interface NewCandidateResult {
  locator: Locator;
  /** True when this element already existed in the DOM at baseline time (just hidden), rather
   * than being freshly inserted afterward -- diagnostic-only, never affects selection. */
  wasPreExistingHiddenElement: boolean;
}

/** The first visible candidate that wasn't already present when the trigger was activated, or
 * null if none has appeared yet. Never selected by tag/class identity -- only "new and visible". */
async function firstNewCandidate(scope: Locator): Promise<NewCandidateResult | null> {
  // :not() binds only to the single compound selector immediately before it, not to a whole
  // comma-separated list -- wrapping the candidate list in :is(...) first is required so the
  // exclusion applies to every branch (a/button/li/[role]/[onclick]/[tabindex]) rather than only
  // the last one.
  const newCandidates = scope.locator(`:is(${GENERIC_RESULT_CANDIDATE_SELECTOR}):not([${DEALER_BASELINE_CANDIDATE_ATTR}])`);
  const count = await newCandidates.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const candidate = newCandidates.nth(i);
    if (await candidate.isVisible().catch(() => false)) {
      const wasPreExistingHiddenElement = await candidate.evaluate((el, attr) => el.hasAttribute(attr), DEALER_BASELINE_EXISTED_ATTR).catch(() => false);
      return { locator: candidate, wasPreExistingHiddenElement };
    }
  }
  return null;
}

interface StagePollResult {
  authoritative: Locator | null;
  generic: Locator | null;
  timedOut: boolean;
  extended: boolean;
  loadingIndicatorObserved: boolean;
  /** True when the authoritative match was never found inside `scope` at all and only matched
   * page-wide -- the widget rendered its result outside the DOM subtree that contains the trigger
   * and its field (a portal/overlay appended elsewhere is the common real-world cause). Always
   * false for a generic-candidate match (the generic fallback stays scope-only, deliberately --
   * see GENERIC_RESULT_CANDIDATE_SELECTOR's own doc comment on why a page-wide generic search
   * would be too false-positive-prone to use safely). */
  foundOutsideScope: boolean;
  /** Diagnostic-only, mirrors NewCandidateResult.wasPreExistingHiddenElement; always false for an
   * authoritative match (that path isn't baseline-gated the same way -- see below). */
  wasPreExistingHiddenElement: boolean;
}

/**
 * One state-machine stage's bounded, adaptive wait -- never a single fixed-delay waitFor. Checks
 * the authoritative ARIA/native-radio selector first (unchanged priority) and a brand-new generic
 * candidate second, every poll interval, stopping the instant either appears. If neither has
 * appeared by `baseTimeoutMs` and a generic loading indicator is still visibly active in scope,
 * grants exactly one bounded extension (never more, never unbounded) up to `maxTimeoutMs` total.
 *
 * `pageWideAuthoritativeFallback`, when provided, is checked only after the in-scope authoritative
 * and generic checks both miss on a given poll tick -- a second, page-wide-but-narrow tier that
 * looks only for a NEW (not pre-existing at lookup start) authoritative ARIA/native-radio element
 * anywhere on the page. Deliberately restricted to the authoritative selector alone (never the
 * noisy generic one) to keep the false-positive risk of searching outside the widget's own DOM
 * scope low: an unrelated page element sharing role="radio"/role="option" that already existed
 * before the lookup started can never match, since it was tagged at baseline.
 */
async function pollForStageResult(
  page: Page,
  scope: Locator,
  baseTimeoutMs: number,
  extensionMs: number,
  maxTimeoutMs: number,
  pageWideAuthoritativeFallback?: Locator,
): Promise<StagePollResult> {
  const start = Date.now();
  let deadline = start + baseTimeoutMs;
  let extended = false;
  let loadingIndicatorObserved = false;
  // Excludes anything this resolution has already clicked/selected -- without this, an
  // already-selected radio/option from an earlier stage would keep matching the authoritative
  // selector forever and look like a brand-new dealer-results stage every time it's re-checked.
  const authoritativeLocator = scope.locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}])`);

  while (true) {
    if (await authoritativeLocator.first().isVisible().catch(() => false)) {
      return { authoritative: authoritativeLocator.first(), generic: null, timedOut: false, extended, loadingIndicatorObserved, foundOutsideScope: false, wasPreExistingHiddenElement: false };
    }
    const candidate = await firstNewCandidate(scope);
    if (candidate) {
      return {
        authoritative: null,
        generic: candidate.locator,
        timedOut: false,
        extended,
        loadingIndicatorObserved,
        foundOutsideScope: false,
        wasPreExistingHiddenElement: candidate.wasPreExistingHiddenElement,
      };
    }
    if (pageWideAuthoritativeFallback && (await pageWideAuthoritativeFallback.first().isVisible().catch(() => false))) {
      return {
        authoritative: pageWideAuthoritativeFallback.first(),
        generic: null,
        timedOut: false,
        extended,
        loadingIndicatorObserved,
        foundOutsideScope: true,
        wasPreExistingHiddenElement: false,
      };
    }
    if (Date.now() >= deadline) {
      if (!extended && Date.now() < start + maxTimeoutMs) {
        const stillLoading = await scope.locator(LOADING_INDICATOR_SELECTOR).first().isVisible().catch(() => false);
        if (stillLoading) {
          loadingIndicatorObserved = true;
          extended = true;
          deadline = Math.min(start + maxTimeoutMs, Date.now() + extensionMs);
          continue;
        }
      }
      return { authoritative: null, generic: null, timedOut: true, extended, loadingIndicatorObserved, foundOutsideScope: false, wasPreExistingHiddenElement: false };
    }
    await page.waitForTimeout(DEALER_RESULT_POLL_INTERVAL_MS);
  }
}

/** A short, bounded, non-extending check -- used both for "did a dropdown appear entirely on its
 * own" (Pattern A/D) and for "did ArrowDown alone already reveal something" (Pattern E), neither
 * of which should ever justify the full per-stage extension logic. */
async function quickPoll(page: Page, scope: Locator, timeoutMs: number): Promise<StagePollResult> {
  return pollForStageResult(page, scope, timeoutMs, 0, timeoutMs);
}

/** Page-wide locator for a NEW authoritative result, excluding anything present at baseline --
 * see DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR's own doc comment. */
function pageWideNewAuthoritativeLocator(page: Page): Locator {
  return page.locator(`:is(${DEALER_RESULT_SELECTOR}):not([${DEALER_ALREADY_ACTIVATED_ATTR}]):not([${DEALER_PAGE_BASELINE_AUTHORITATIVE_ATTR}])`);
}

/** Tags every authoritative-role element present anywhere on the page right now as pre-existing,
 * so the page-wide fallback tier can later tell a genuinely new result (rendered outside the
 * widget's own DOM scope) apart from an unrelated control elsewhere on the page. */
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

/**
 * A clicked result doesn't by itself prove the widget's own JS committed the selection (e.g. a
 * hidden "selected dealer id" field it still has to write) -- check the result's own selected/
 * checked state after a short settle. `aria-checked` is the correct ARIA state for `role="radio"`,
 * `aria-selected` for `role="option"`; both are checked generically since the result could be
 * either. Takes a frozen handle, never a Locator -- a selection is very often the widget's own
 * cue to replace that exact element (e.g. a location suggestion swapped out for the real dealer
 * result), and evaluating a still-lazy Locator whose node is already gone would otherwise fall
 * back to Playwright's own ~30s default actionability wait before any .catch ever sees it.
 */
async function verifyDealerSelectionCommitted(page: Page, option: ElementHandle<SVGElement | HTMLElement>): Promise<boolean> {
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
export type DealerLookupEvent =
  | "dispatch_input_change_blur"
  | "dispatch_keyboard_events"
  | "click_trigger"
  | "press_arrowdown"
  | "press_enter"
  | "click_location_suggestion"
  | "click_confirm_control"
  | "click_dealer_result";

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
  /** True when no element matched DEALER_RESULT_SELECTOR (no ARIA radio/option semantics) but a
   * new, visible, generically-clickable element appeared within the dealer-widget scope after
   * the trigger fired, and that element was used as the selected result instead. */
  genericCandidateFallbackUsed: boolean;
  /** True when a location/postcode suggestion list was already visible, entirely on its own,
   * before any trigger click or keyboard action was attempted (Pattern A/D). */
  autoDropdownDetected: boolean;
  /** True when a distinct OK/search/confirm control (never the same element twice) was found
   * and clicked after a location suggestion was selected, before polling for dealer results
   * (Pattern C). */
  confirmControlClicked: boolean;
  /** Which bounded stage actually ran out of time, or null if every stage that ran resolved
   * within its own bound (whether or not a dealer was ultimately verified). */
  timedOutStage: "location_suggestions" | "dealer_results" | null;
  /** True when a generic loading indicator (aria-busy/role=progressbar/role=status) was still
   * visibly active in scope right at a stage's base timeout, justifying its one bounded
   * extension. */
  loadingIndicatorObservedAtTimeout: boolean;
  /** True when a stage's wait was actually extended past its base bound because of an observed
   * loading indicator -- still capped by that stage's own hard maximum. */
  stageWaitExtended: boolean;
  /** True when the selected result was never found inside the trigger/field's own DOM-containment
   * scope and only matched a page-wide fallback search -- see pollForStageResult's own doc
   * comment. Null when no result was ever selected at all (nothing to report this about). */
  resultFoundOutsideScope: boolean | null;
  /** True when the selected generic-fallback result already existed in the DOM before the lookup
   * started, merely hidden, rather than being freshly inserted afterward. Null when no generic
   * candidate was ever selected (an authoritative result, or no result at all). */
  wasPreExistingHiddenElement: boolean | null;
  /** Sanitised xhr/fetch request evidence observed during this call -- see
   * dealerLookupNetwork.ts. Never a request/response body, never a typed or returned value. */
  networkRequests: SanitizedNetworkRequestEvidence[];
  /** True when the postcode/location field itself carried aria-invalid="true" at the moment a
   * stage timed out with no result -- never the validation message text itself, which some
   * browsers can echo the field's own value into. */
  fieldAriaInvalidAtTimeout: boolean;
  /** True when the field's native (browser-generated) validationMessage was non-empty at the
   * moment a stage timed out with no result -- presence only, never the message text itself. */
  fieldHasNativeValidationMessageAtTimeout: boolean;
  /** True when a hidden input (input[type="hidden"]) within the dealer-lookup scope itself
   * transitioned from an empty value to a non-empty one -- the only signal this engine treats as
   * genuine proof a widget committed an identifier, as opposed to some unrelated visible text
   * (an error message, a loading string, whitespace noise) merely changing in scope. False when
   * this check ran and found no such transition. Null when this check never ran at all (a result
   * was selected via its own ARIA/native-checked state instead, which is already authoritative). */
  hiddenFieldCommitDetected: boolean | null;
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

const DEALER_WAIT_CONDITION = `${DEALER_RESULT_SELECTOR} visible within scope, or a new generic result candidate within scope`;

/**
 * Generic multi-stage state machine covering every postcode/location/dealer interaction sequence
 * this engine has evidence for -- fill the postcode/city value is the caller's job (this only
 * activates the lookup and inspects what happens):
 *   0. AUTO-DROPDOWN CHECK -- a short, bounded, non-extending look for a suggestion list that
 *      appeared entirely on its own from typing alone, before any trigger click or keyboard
 *      action is attempted (Pattern A/D). Only when nothing appears does the widget get
 *      activated at all.
 *   1. ACTIVATION -- click the structurally-associated trigger if one exists; otherwise try
 *      ArrowDown (the standard combobox "open the menu" key) and, if that alone reveals nothing,
 *      Enter (Pattern E). A trigger is never clicked twice, and the field/trigger used is marked
 *      so it can never be mistaken for a *result* later.
 *   2. LOCATION SUGGESTIONS -- an independently bounded, adaptive poll (never a single fixed
 *      delay) for the authoritative ARIA/native-radio selector or a generic fallback candidate.
 *   3. LOCATION SELECTION -- select the first result; verify via its own committed state or a
 *      scoped text change.
 *   4. CONFIRM-CONTROL RESCAN -- only if a dealer-results widget hasn't already appeared, look
 *      for a distinct, not-yet-clicked OK/search/confirm control and activate it (Pattern C).
 *   5. DEALER RESULTS -- a second, independently bounded, adaptive poll for the dealer list.
 *   6. DEALER SELECTION -- select and verify the dealer, or recognise it auto-populated with no
 *      further selectable result (Pattern D), or that nothing further ever came and the stage-1
 *      selection already *was* the dealer (Pattern B's single-widget case).
 * Every bounded wait is independent per stage, adaptive (polls frequently, stops the instant the
 * expected state appears), and grants at most one bounded extension when a generic loading
 * indicator is still visibly active at its own base timeout -- never unbounded. Never requires a
 * result element to already exist before activation -- on a real site the result container is
 * routinely created only afterward.
 */
/**
 * Public entry point -- wraps resolveDealerLookupCore with sanitised network observation for the
 * full duration of the call, then attaches the result to the returned trace. Kept as a thin
 * wrapper (rather than threading capture start/stop through every one of the core function's
 * five return points) so the core state machine's own control flow stays exactly as it was.
 */
export async function resolveDealerLookup(page: Page, scope: Locator, trigger: Locator | null, field: Locator, form: Locator): Promise<DealerLookupOutcome> {
  const capture = startDealerLookupNetworkCapture(page);
  try {
    const outcome = await resolveDealerLookupCore(page, scope, trigger, field, form);
    outcome.executionTrace.networkRequests = await capture.stop();
    return outcome;
  } catch (error) {
    await capture.stop().catch(() => {});
    throw error;
  }
}

async function resolveDealerLookupCore(page: Page, scope: Locator, trigger: Locator | null, field: Locator, form: Locator): Promise<DealerLookupOutcome> {
  const baselineText = await safeInnerText(scope);
  // Hidden-input commit detection reads from the enclosing form, not the narrower trigger/field
  // DOM-containment scope -- a widget's own committed-value hidden field is commonly a sibling
  // of the visible widget markup rather than nested inside it, and a hidden input changing
  // anywhere in the form is still a far stronger, far less noisy signal than any visible text
  // change in the narrow scope (which is what caused the original false positive).
  const baselineHiddenValues = await snapshotHiddenInputValues(form);
  await markBaselineCandidates(scope);
  // Page-wide baseline, independent of the scope-local one above -- lets the page-wide fallback
  // tier (see pollForStageResult) distinguish a genuinely new, portal-rendered result from an
  // unrelated pre-existing control elsewhere on the page that merely shares the same ARIA role.
  await markPageBaselineAuthoritative(page);
  const pageWideFallback = pageWideNewAuthoritativeLocator(page);

  // Never rely solely on Playwright's own implicit fill() behaviour -- some widgets only react
  // to blur, not input/change. Keyboard events are dispatched too, separately from fill()'s own
  // input/change -- fill() sets the value and fires input/change but never simulates a real
  // keypress, and some autocomplete widgets bind their lookup trigger to keyup/keydown instead.
  await field
    .evaluate((el: Element) => {
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    })
    .catch(() => {});
  const eventsDispatched: DealerLookupEvent[] = ["dispatch_keyboard_events"];
  await field
    .evaluate((el: Element) => {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    })
    .catch(() => {});
  await field.blur().catch(() => {});
  eventsDispatched.push("dispatch_input_change_blur");

  // Stage 0: did a suggestion list appear entirely on its own?
  let stage1 = await quickPoll(page, scope, DEALER_AUTO_APPEAR_CHECK_MS);
  const autoDropdownDetected = Boolean(stage1.authoritative || stage1.generic);

  if (!autoDropdownDetected) {
    if (trigger) {
      // Freeze and mark BEFORE clicking, never after -- a click that causes the widget's own JS
      // to swap the trigger out of the DOM would otherwise make a lazily-re-resolving locator
      // mark whatever element happens to occupy that same position afterward instead, which can
      // be a freshly-appeared result the next stage must still be free to select.
      const triggerHandle = await freeze(trigger);
      if (triggerHandle) {
        await markAlreadyActivated(triggerHandle);
        await triggerHandle.click().catch(() => {});
      } else {
        await trigger.click().catch(() => {});
      }
      eventsDispatched.push("click_trigger");
    } else {
      await field.press("ArrowDown").catch(() => {});
      eventsDispatched.push("press_arrowdown");
      const afterArrowDown = await quickPoll(page, scope, 300);
      if (afterArrowDown.authoritative || afterArrowDown.generic) {
        stage1 = afterArrowDown;
      } else {
        await field.press("Enter").catch(() => {});
        eventsDispatched.push("press_enter");
      }
    }
    if (!stage1.authoritative && !stage1.generic) {
      stage1 = await pollForStageResult(page, scope, DEALER_RESULT_WAIT_TIMEOUT_MS, DEALER_STAGE_WAIT_EXTENSION_MS, DEALER_STAGE_WAIT_MAX_MS, pageWideFallback);
    }
  }

  const suggestionCount = await scope.locator(DEALER_RESULT_SELECTOR).count().catch(() => 0);

  if (!stage1.authoritative && !stage1.generic) {
    // Nothing selectable ever appeared for the location/postcode stage. The only signal this
    // engine treats as genuine proof of a committed dealer/location identifier here is a hidden
    // input within scope transitioning from empty to non-empty -- never a generic visible
    // text-length change in scope, which was confirmed in production to fire from unrelated
    // causes (a validation message, a loading string) with no identifier ever actually
    // committed, and was wrongly treated as sufficient to let a submit proceed and then get
    // silently cancelled by the site's own JS. A text-only change, with no hidden-field commit,
    // is reported as unresolved -- the caller must never submit on that basis alone.
    await page.waitForTimeout(600);
    const afterText = await safeInnerText(scope);
    const afterHiddenValues = await snapshotHiddenInputValues(form);
    const hiddenFieldCommitDetected = hasHiddenInputCommit(baselineHiddenValues, afterHiddenValues);
    const textChanged = afterText.trim().length > 0 && afterText.trim() !== baselineText.trim() && afterText.trim().length > baselineText.trim().length;
    const fieldValidationState = await readFieldValidationState(field);

    if (hiddenFieldCommitDetected) {
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
        executionTrace: {
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
          timedOutStage: "location_suggestions",
          loadingIndicatorObservedAtTimeout: stage1.loadingIndicatorObserved,
          stageWaitExtended: stage1.extended,
          resultFoundOutsideScope: null,
          wasPreExistingHiddenElement: null,
          networkRequests: [],
          fieldAriaInvalidAtTimeout: fieldValidationState.ariaInvalid,
          fieldHasNativeValidationMessageAtTimeout: fieldValidationState.hasNativeValidationMessage,
          hiddenFieldCommitDetected: true,
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
      dealerLookupFailureReason: textChanged
        ? "visible_scope_text_changed_but_no_hidden_identifier_committed_within_timeout"
        : "no_selectable_result_and_no_text_change_within_timeout",
      executionTrace: {
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
        timedOutStage: "location_suggestions",
        loadingIndicatorObservedAtTimeout: stage1.loadingIndicatorObserved,
        stageWaitExtended: stage1.extended,
        resultFoundOutsideScope: null,
        wasPreExistingHiddenElement: null,
        networkRequests: [],
        fieldAriaInvalidAtTimeout: fieldValidationState.ariaInvalid,
        fieldHasNativeValidationMessageAtTimeout: fieldValidationState.hasNativeValidationMessage,
        hiddenFieldCommitDetected: false,
      },
    };
  }

  // Stage 1: select the location/postcode suggestion.
  const stage1Result = stage1.authoritative ?? stage1.generic!;
  const stage1WasGeneric = !stage1.authoritative;
  const stage1FoundOutsideScope = stage1.foundOutsideScope;
  const stage1WasPreExistingHiddenElement = stage1.wasPreExistingHiddenElement;
  // Freeze, then mark, then click, in that order -- see the trigger-click comment above for why
  // marking must happen before clicking, and the freeze() doc comment for why a frozen handle
  // (not the original lazily-re-resolving Locator) is required for both: marking through the
  // same self-excluding Locator would make it stop matching the very element it just marked,
  // and selecting a suggestion routinely replaces it in-place with the real dealer result (the
  // exact shape this stage exists to handle), which a stale Locator would otherwise re-resolve to.
  const stage1Handle = await freeze(stage1Result);
  if (stage1Handle) {
    await markAlreadyActivated(stage1Handle);
    await stage1Handle.click().catch(() => {});
  } else {
    await stage1Result.click().catch(() => {});
  }
  eventsDispatched.push("click_location_suggestion");
  const stage1Committed = stage1Handle ? await verifyDealerSelectionCommitted(page, stage1Handle) : false;
  const afterSelectText = await safeInnerText(scope);
  const stage1TextChanged = afterSelectText.trim().length > 0 && afterSelectText.trim() !== baselineText.trim();
  const stage1Verified = stage1Committed || stage1TextChanged;

  // Re-baseline so this stage's own elements never register as "new" in the next stage.
  await markBaselineCandidates(scope);

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
      // Mark BEFORE clicking -- same reasoning as the trigger/suggestion clicks above.
      await markAlreadyActivated(confirmControl);
      await confirmControl.click().catch(() => {});
      confirmControlClicked = true;
      eventsDispatched.push("click_confirm_control");
      await markBaselineCandidates(scope);
    }
  }

  // Stage 3: dealer results, independently bounded from stage 1/2.
  const stage3 = await pollForStageResult(page, scope, DEALER_RESULT_WAIT_TIMEOUT_MS, DEALER_STAGE_WAIT_EXTENSION_MS, DEALER_STAGE_WAIT_MAX_MS, pageWideFallback);
  const secondStageSuggestionCount = await scope.locator(DEALER_RESULT_SELECTOR).count().catch(() => 0);

  if (stage3.authoritative || stage3.generic) {
    const dealerResult = stage3.authoritative ?? stage3.generic!;
    const dealerWasGeneric = !stage3.authoritative;
    const dealerHandle = await freeze(dealerResult);
    if (dealerHandle) {
      await dealerHandle.click().catch(() => {});
    } else {
      await dealerResult.click().catch(() => {});
    }
    eventsDispatched.push("click_dealer_result");
    const dealerCommitted = dealerHandle ? await verifyDealerSelectionCommitted(page, dealerHandle) : false;
    const afterDealerText = await safeInnerText(scope);
    const dealerTextChanged = afterDealerText.trim().length > 0 && afterDealerText.trim() !== afterSelectText.trim();
    const dealerVerified = dealerCommitted || dealerTextChanged;

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
        ? dealerCommitted
          ? "selected_result_carries_checked_or_aria_checked_or_aria_selected_state"
          : "dealer_lookup_scope_text_changed_after_second_stage_selection"
        : "no_committed_state_detected_on_selected_result",
      dealerLookupFailureReason: dealerVerified ? undefined : "selectable_result_found_but_commit_state_never_verified",
      executionTrace: {
        eventsDispatched,
        waitCondition: DEALER_WAIT_CONDITION,
        waitTimeoutMs: DEALER_RESULT_WAIT_TIMEOUT_MS,
        waitOutcome: "resolved",
        suggestionsDetected: true,
        suggestionCount,
        selectedSuggestionIdentity: "dealer_result[0]",
        secondStageSuggestionCount,
        genericCandidateFallbackUsed: stage1WasGeneric || dealerWasGeneric,
        autoDropdownDetected,
        confirmControlClicked,
        timedOutStage: null,
        loadingIndicatorObservedAtTimeout: stage3.loadingIndicatorObserved,
        stageWaitExtended: stage3.extended,
        resultFoundOutsideScope: stage3.foundOutsideScope,
        wasPreExistingHiddenElement: stage3.wasPreExistingHiddenElement,
        networkRequests: [],
        fieldAriaInvalidAtTimeout: false,
        fieldHasNativeValidationMessageAtTimeout: false,
        hiddenFieldCommitDetected: null,
      },
    };
  }

  // No distinct dealer-results stage ever appeared. Either the location selection itself
  // already WAS the dealer (a single combined widget -- Pattern B's simplest case), the dealer
  // auto-populated with no further selectable result (Pattern D), or nothing further happened.
  const afterDealerText = await safeInnerText(scope);
  const autoPopulatedFurther = afterDealerText.trim().length > 0 && afterDealerText.trim() !== afterSelectText.trim();

  if (stage1Verified && !autoPopulatedFurther) {
    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: stage1WasGeneric ? "suggestion_selected" : "dealer_selected",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: false,
      dealerResultsDetected: true,
      dealerAutoPopulated: false,
      dealerSelected: true,
      dealerValueVerified: true,
      dealerVerificationEvidence: stage1Committed
        ? "selected_result_carries_checked_or_aria_checked_or_aria_selected_state"
        : "dealer_lookup_scope_state_changed_after_selection_with_no_distinct_dealer_stage",
      executionTrace: {
        eventsDispatched,
        waitCondition: DEALER_WAIT_CONDITION,
        waitTimeoutMs: DEALER_RESULT_WAIT_TIMEOUT_MS,
        waitOutcome: "resolved",
        suggestionsDetected: true,
        suggestionCount,
        selectedSuggestionIdentity: "result[0]",
        secondStageSuggestionCount,
        genericCandidateFallbackUsed: stage1WasGeneric,
        autoDropdownDetected,
        confirmControlClicked,
        timedOutStage: stage3.timedOut ? "dealer_results" : null,
        loadingIndicatorObservedAtTimeout: stage3.loadingIndicatorObserved,
        stageWaitExtended: stage3.extended,
        resultFoundOutsideScope: stage1FoundOutsideScope,
        wasPreExistingHiddenElement: stage1WasPreExistingHiddenElement,
        networkRequests: [],
        fieldAriaInvalidAtTimeout: false,
        fieldHasNativeValidationMessageAtTimeout: false,
        hiddenFieldCommitDetected: null,
      },
    };
  }

  if (autoPopulatedFurther) {
    return {
      dealerLookupTriggered: true,
      dealerLookupOutcome: "auto_populated",
      locationSuggestionsDetected: true,
      locationSuggestionSelected: confirmControlClicked,
      dealerResultsDetected: false,
      dealerAutoPopulated: true,
      dealerSelected: false,
      dealerValueVerified: true,
      dealerVerificationEvidence: "dealer_lookup_scope_text_changed_after_location_selection_with_no_selectable_result",
      executionTrace: {
        eventsDispatched,
        waitCondition: DEALER_WAIT_CONDITION,
        waitTimeoutMs: DEALER_RESULT_WAIT_TIMEOUT_MS,
        waitOutcome: "timed_out",
        suggestionsDetected: true,
        suggestionCount,
        selectedSuggestionIdentity: "result[0]",
        secondStageSuggestionCount,
        genericCandidateFallbackUsed: stage1WasGeneric,
        autoDropdownDetected,
        confirmControlClicked,
        timedOutStage: "dealer_results",
        loadingIndicatorObservedAtTimeout: stage3.loadingIndicatorObserved,
        stageWaitExtended: stage3.extended,
        resultFoundOutsideScope: stage1FoundOutsideScope,
        wasPreExistingHiddenElement: stage1WasPreExistingHiddenElement,
        networkRequests: [],
        fieldAriaInvalidAtTimeout: false,
        fieldHasNativeValidationMessageAtTimeout: false,
        hiddenFieldCommitDetected: null,
      },
    };
  }

  return {
    dealerLookupTriggered: true,
    dealerLookupOutcome: "unresolved",
    locationSuggestionsDetected: true,
    locationSuggestionSelected: confirmControlClicked,
    dealerResultsDetected: false,
    dealerAutoPopulated: false,
    dealerSelected: false,
    dealerValueVerified: false,
    dealerVerificationEvidence: "no_change_detected_in_dealer_lookup_scope_after_location_selection",
    dealerLookupFailureReason: "location_selected_but_no_selectable_dealer_result_and_no_text_change_within_timeout",
    executionTrace: {
      eventsDispatched,
      waitCondition: DEALER_WAIT_CONDITION,
      waitTimeoutMs: DEALER_RESULT_WAIT_TIMEOUT_MS,
      waitOutcome: "timed_out",
      suggestionsDetected: true,
      suggestionCount,
      selectedSuggestionIdentity: "result[0]",
      secondStageSuggestionCount,
      genericCandidateFallbackUsed: stage1WasGeneric,
      autoDropdownDetected,
      confirmControlClicked,
      timedOutStage: "dealer_results",
      loadingIndicatorObservedAtTimeout: stage3.loadingIndicatorObserved,
      stageWaitExtended: stage3.extended,
      resultFoundOutsideScope: stage1FoundOutsideScope,
      wasPreExistingHiddenElement: stage1WasPreExistingHiddenElement,
      networkRequests: [],
      fieldAriaInvalidAtTimeout: false,
      fieldHasNativeValidationMessageAtTimeout: false,
      hiddenFieldCommitDetected: null,
    },
  };
}
