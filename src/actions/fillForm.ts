import type { Locator, Page } from "playwright";
import type { Captures } from "../types/task-response.js";
import type { ActionResult } from "../types/task-response.js";
import type { SelectedAction } from "../types/actions.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { captureDataLayer } from "../capture-modules/dataLayer.js";
import { attachGa4NetworkCapture } from "../capture-modules/ga4NetworkEvents.js";
import { waitForAdaptiveSettle } from "../core/robustNavigation.js";
import { detectCaptcha } from "../forms/captcha.js";
import { detectPageLanguage } from "../forms/fieldMapper.js";
import { buildFillPlan, type FormFieldDescriptor, type PlannedField } from "../forms/fillPlan.js";
import { resolveMarket, type SupportedLanguage } from "../forms/testData.js";
import type { UnmappedFieldResolver } from "../forms/unmappedFieldResolver.js";
import {
  computeFormScore,
  resolveAmbiguousFormSelection,
  selectBestForm,
  type FormCandidate,
  type FormJourneyContext,
  type FormSelectionAmbiguityResolver,
  type FormTextSignals,
  type FormVisibilityProminenceSignals,
} from "../forms/formRelevance.js";
import { gatherSemanticPageSignals } from "../core/semanticPageMatch.js";

const FIELD_INDEX_ATTR = "data-nav-engine-field-index";
const MAX_RETRIES = 2;

const SUCCESS_TEXT_MARKERS = [
  "thank you",
  "merci",
  "danke",
  "bedankt",
  "grazie",
  "gracias",
  "dziekujemy",
  "dziękujemy",
  "obrigado",
  "confirmation",
  "confirme",
  "confirmé",
  "bestatigt",
  "bestätigt",
  "bevestigd",
  "confermato",
  "confirmado",
  "potwierdzenie",
];

const SUBMIT_TEXT_MARKERS = ["submit", "send", "soumettre", "envoyer", "senden", "versturen", "invia", "inviare", "enviar", "wyslij", "wyślij"];

/** Generic, language-agnostic vocabulary for the trigger that runs a postcode/dealer search -- never a brand-specific selector. */
const SEARCH_TEXT_MARKERS = ["search", "go", "find", "ok", "zoeken", "suchen", "rechercher", "cercar", "buscar", "szukaj", "pesquisar"];

/** Diagnostics for the generic postcode -> dealer-results -> select -> verify flow a `dealer_search` decision drives. See docs/architecture.md. */
export interface DealerSearchDiagnostics {
  postcodeSearchTriggered: boolean;
  dealerResultsDetected: boolean;
  dealerSelected: boolean;
  dealerSelectionVerified: boolean;
  /**
   * Diagnostic only -- never used to select or click. Checked only when dealerResultsDetected
   * is false, so a future live run can tell "no results anywhere" apart from "the widget's
   * results render outside the <form> boundary, where waitForDealerResult never looks".
   */
  dealerResultsDetectedOutsideForm: boolean;
}

/** Post-submit validation evidence, read fresh (after re-tagging) so a field revealed only after a dynamic widget interaction is never invisible to it. */
export interface PostSubmitDiagnostics {
  invalidFieldIds: string[];
  nativeValidationMessages: Record<string, string>;
  postSubmitValidationMessages: string[];
}

const EMPTY_DEALER_SEARCH_DIAGNOSTICS: DealerSearchDiagnostics = {
  postcodeSearchTriggered: false,
  dealerResultsDetected: false,
  dealerSelected: false,
  dealerSelectionVerified: false,
  dealerResultsDetectedOutsideForm: false,
};

export interface ExecuteFillFormParams {
  page: Page;
  action: SelectedAction;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  /** Optional, injected once per run -- see unmappedFieldResolver.ts. Never required: an unresolved required field simply stays empty and surfaces via the validation-retry path. */
  unmappedFieldResolver?: UnmappedFieldResolver;
  /** Objective/active-milestone/previous-CTA evidence for multi-form journey-relevance selection -- see forms/formRelevance.ts. Absent (treated as empty) scores every candidate on visibility/prominence and field actionability alone. */
  journeyContext?: FormJourneyContext;
  /** Optional, injected once per run -- see forms/formRelevance.ts's FormSelectionAmbiguityResolver. No caller configures one yet; its absence just means the ambiguous band fails closed. */
  selectionAmbiguityResolver?: FormSelectionAmbiguityResolver;
}

/** Where a field's `required: true` came from -- see RawFieldDescriptor.requiredEvidence below. */
export type RequiredEvidence = "attribute" | "marker" | "none";

interface RawFieldDescriptor {
  index: number;
  tagName: string;
  type?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  label?: string;
  required: boolean;
  /** How `required` was decided -- never submitted as fact without evidence (see fillForm.ts's field-level diagnostics). */
  requiredEvidence: RequiredEvidence;
  visible: boolean;
  currentValue: string;
  /** True when `currentValue` only mirrors this field's own label/placeholder text (a site rendering its placeholder into the live value instead of the `placeholder` attribute) -- never real prefilled data, so fillPlan.ts must not skip the field as "prefilled" because of it. */
  isPlaceholderMimicry: boolean;
  isPreselected?: boolean;
  options?: { value: string; label: string }[];
}

/**
 * Deliberately avoids any named helper function/const inside the evaluate callback --
 * tsx/esbuild wraps a nested named binding in a `__name(...)` call that doesn't exist once
 * Playwright serializes the function's source to run in the browser (ReferenceError:
 * __name is not defined). Everything stays inline in one anonymous arrow per field instead.
 */
async function tagAndReadFields(form: Locator): Promise<RawFieldDescriptor[]> {
  return form.evaluate((formEl: HTMLFormElement, attr: string) => {
    const fields = Array.from(formEl.querySelectorAll("input, select, textarea")) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    return fields.map((el, index) => {
      el.setAttribute(attr, String(index));
      const tagName = el.tagName.toLowerCase();
      const type = tagName === "input" ? (el as HTMLInputElement).type : undefined;
      let currentValue = "";
      let isPreselected: boolean | undefined;
      let options: { value: string; label: string }[] | undefined;
      if (tagName === "select") {
        const select = el as HTMLSelectElement;
        options = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() ?? "" }));
        currentValue = select.value;
        isPreselected = select.selectedIndex > 0 && select.value.trim().length > 0;
      } else if (type === "checkbox" || type === "radio") {
        currentValue = String((el as HTMLInputElement).checked);
      } else {
        currentValue = (el as HTMLInputElement | HTMLTextAreaElement).value;
      }

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";

      const id = el.getAttribute("id");
      const byForLabel = id ? formEl.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const closestLabel = el.closest("label");
      let labelEl: Element | null = byForLabel ?? closestLabel;
      if (!labelEl && visible) {
        // Generic fallback for a visible control whose id doesn't match any label's `for`
        // (a custom-widget-generated id, or a label pointing at a hidden duplicate backing
        // input) and that isn't wrapped in a <label> either: walk a few preceding siblings
        // of the control itself, then of its parent, looking for the first element carrying
        // its own short text -- the same bounded sibling/ancestor-walk shape
        // forms/formRelevance.ts's gatherFormSignals already uses for nearestHeadingText.
        // Never climbs past the form's own boundary -- a hidden field never needs this (it is
        // always skipped regardless of its label) and a visible field's real label is always
        // inside the form that contains it.
        let node: Element | null = el;
        let steps = 0;
        while (node && node !== formEl && steps < 6 && !labelEl) {
          let sibling: Element | null = node.previousElementSibling;
          let siblingSteps = 0;
          while (sibling && siblingSteps < 4 && !labelEl) {
            const text = sibling.textContent?.trim() ?? "";
            if (text.length > 0 && text.length < 80 && sibling.querySelector("input, select, textarea") === null) {
              labelEl = sibling;
            }
            sibling = sibling.previousElementSibling;
            siblingSteps += 1;
          }
          node = node.parentElement;
          steps += 1;
        }
      }
      const labelText = labelEl?.textContent?.trim() || el.getAttribute("aria-label") || "";

      // Generic visible required-marker detection: a bare "*" is a near-universal,
      // language-agnostic convention for "this field is required" that many sites express
      // only visually (a sibling/decorator element, or appended to the label text) without
      // ever setting the HTML `required` attribute or `aria-required`. Never brand-specific --
      // just the literal asterisk symbol, wherever it appears near this field's own label.
      const hasAttributeRequired = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      let hasRequiredMarker = /\*\s*$/.test(labelText);
      if (!hasRequiredMarker && labelEl) {
        const markerCandidates = [labelEl.nextElementSibling, labelEl.parentElement?.querySelector(".required, .mandatory") ?? null];
        hasRequiredMarker = markerCandidates.some((candidate) => (candidate?.textContent?.trim() ?? "") === "*");
      }
      if (!hasRequiredMarker) {
        const ownMarkerSibling = el.nextElementSibling;
        hasRequiredMarker = (ownMarkerSibling?.textContent?.trim() ?? "") === "*";
      }
      const required = hasAttributeRequired || hasRequiredMarker;
      const requiredEvidence: "attribute" | "marker" | "none" = hasAttributeRequired ? "attribute" : hasRequiredMarker ? "marker" : "none";

      const normalizedValue = currentValue.trim().toLowerCase();
      const normalizedLabel = labelText.trim().toLowerCase();
      const normalizedPlaceholder = (el.getAttribute("placeholder") ?? "").trim().toLowerCase();
      const isPlaceholderMimicry =
        normalizedValue.length > 0 && (normalizedValue === normalizedLabel || normalizedValue === normalizedPlaceholder);

      el.setAttribute(`${attr}-required`, String(required));

      return {
        index,
        tagName: tagName as "input" | "select" | "textarea",
        type,
        name: el.getAttribute("name") ?? undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        autocomplete: el.getAttribute("autocomplete") ?? undefined,
        label: labelText,
        required,
        requiredEvidence,
        visible,
        currentValue,
        isPlaceholderMimicry,
        isPreselected,
        options,
      };
    });
  }, FIELD_INDEX_ATTR);
}

interface RawFormSignals {
  visible: boolean;
  inChrome: boolean;
  areaRatio: number;
  hasNearbyHeading: boolean;
  hasVisibleSubmitButton: boolean;
  nearestHeadingText: string;
  submitButtonText: string;
  formAttributesText: string;
}

/**
 * Visual-prominence and local-text evidence for one candidate <form> -- see
 * forms/formRelevance.ts's FormVisibilityProminenceSignals/FormTextSignals. Everything stays
 * inline in one anonymous callback (no nested named helper), same reason as tagAndReadFields
 * above.
 */
async function gatherFormSignals(form: Locator): Promise<RawFormSignals> {
  return form.evaluate((formEl: HTMLFormElement) => {
    const rect = formEl.getBoundingClientRect();
    const style = window.getComputedStyle(formEl);
    const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && onScreen;
    const inChrome =
      formEl.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"]') !== null;
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const areaRatio = Math.min(1, (rect.width * rect.height) / viewportArea);

    const headingSelector = "h1, h2, h3, h4";
    let nearestHeadingText = "";
    const ownHeading = formEl.querySelector(headingSelector);
    if (ownHeading) {
      nearestHeadingText = ownHeading.textContent?.trim() ?? "";
    } else {
      let sibling: Element | null = formEl.previousElementSibling;
      let siblingSteps = 0;
      while (sibling && siblingSteps < 6 && !nearestHeadingText) {
        if (sibling.matches(headingSelector)) {
          nearestHeadingText = sibling.textContent?.trim() ?? "";
        }
        sibling = sibling.previousElementSibling;
        siblingSteps += 1;
      }
      let ancestor: Element | null = formEl.parentElement;
      let ancestorSteps = 0;
      while (ancestor && ancestorSteps < 4 && !nearestHeadingText) {
        const heading = ancestor.querySelector(headingSelector);
        if (heading) {
          nearestHeadingText = heading.textContent?.trim() ?? "";
        }
        ancestor = ancestor.parentElement;
        ancestorSteps += 1;
      }
    }
    const hasNearbyHeading = nearestHeadingText.length > 0;

    const submitEls = Array.from(formEl.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]'));
    let submitButtonText = "";
    let hasVisibleSubmitButton = false;
    for (const el of submitEls) {
      const elRect = el.getBoundingClientRect();
      const elStyle = window.getComputedStyle(el);
      const elVisible = elRect.width > 0 && elRect.height > 0 && elStyle.visibility !== "hidden" && elStyle.display !== "none";
      if (elVisible) {
        hasVisibleSubmitButton = true;
        submitButtonText = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || (el as HTMLInputElement).value || "";
        break;
      }
    }
    if (!hasVisibleSubmitButton && submitEls.length === 0) {
      const genericButtons = Array.from(formEl.querySelectorAll<HTMLElement>("button"));
      const lastButton = genericButtons[genericButtons.length - 1];
      if (lastButton) {
        submitButtonText = lastButton.getAttribute("aria-label")?.trim() || lastButton.textContent?.trim() || "";
      }
    }

    const formAttributesText = [
      formEl.getAttribute("aria-label") ?? "",
      formEl.getAttribute("name") ?? "",
      formEl.id ?? "",
      formEl.getAttribute("action") ?? "",
    ].join(" ");

    return { visible, inChrome, areaRatio, hasNearbyHeading, hasVisibleSubmitButton, nearestHeadingText, submitButtonText, formAttributesText };
  });
}

function toDescriptor(raw: RawFieldDescriptor): FormFieldDescriptor {
  return {
    id: String(raw.index),
    tagName: raw.tagName as FormFieldDescriptor["tagName"],
    type: raw.type,
    name: raw.name,
    placeholder: raw.placeholder,
    autocomplete: raw.autocomplete,
    label: raw.label,
    required: raw.required,
    requiredEvidence: raw.requiredEvidence,
    visible: raw.visible,
    currentValue: raw.currentValue,
    isPlaceholderMimicry: raw.isPlaceholderMimicry,
    isPreselected: raw.isPreselected,
    options: raw.options,
  };
}

async function fieldByIndex(form: Locator, index: string): Promise<Locator> {
  return form.locator(`[${FIELD_INDEX_ATTR}="${index}"]`);
}

/** Generic, accessibility-based dealer-result candidates -- never a brand-specific selector. */
const DEALER_RESULT_SELECTOR = '[role="radio"], input[type="radio"], [role="option"]';

async function findSearchTrigger(form: Locator): Promise<Locator | null> {
  for (const marker of SEARCH_TEXT_MARKERS) {
    const byRole = form.getByRole("button", { name: new RegExp(marker, "i") }).first();
    if ((await byRole.count()) > 0) return byRole;
  }
  return null;
}

async function waitForDealerResult(form: Locator): Promise<Locator | null> {
  const results = form.locator(DEALER_RESULT_SELECTOR);
  try {
    await results.first().waitFor({ state: "visible", timeout: 3000 });
  } catch {
    return null;
  }
  return (await results.count()) > 0 ? results.first() : null;
}

/**
 * Clicking a result doesn't by itself prove the widget's own JS committed the selection (e.g.
 * a hidden "selected dealer id" field it still has to write) -- check the result's own
 * selected/checked state after a short settle. `aria-checked` is the correct ARIA state for a
 * `role="radio"` widget, `aria-selected` for `role="option"`; both are checked generically
 * since the result could be either.
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

async function applyDecision(
  page: Page,
  form: Locator,
  plannedField: PlannedField,
  hasCountryCodeSelector: boolean,
): Promise<{ key?: string; dealerSearch?: DealerSearchDiagnostics }> {
  const field = await fieldByIndex(form, plannedField.descriptor.id);
  switch (plannedField.decision.kind) {
    case "fill_text":
      await field.fill(plannedField.decision.value);
      return { key: plannedField.decision.field };
    case "select_option": {
      await field.selectOption({ value: plannedField.decision.value });
      return { key: plannedField.matchedField };
    }
    case "choose_first_valid_option": {
      const options = plannedField.descriptor.options ?? [];
      const first = options.find((o) => o.value.trim().length > 0);
      if (first) await field.selectOption({ value: first.value });
      return { key: plannedField.matchedField };
    }
    case "select_negative_option": {
      const options = plannedField.descriptor.options ?? [];
      if (options.length > 0 && plannedField.descriptor.tagName === "select") {
        await field.selectOption({ value: options[options.length - 1]!.value });
      }
      return { key: plannedField.matchedField };
    }
    case "tick_checkbox":
      await field.check();
      return { key: plannedField.matchedField };
    case "dealer_search": {
      await field.fill(plannedField.decision.postcode);
      const trigger = await findSearchTrigger(form);
      if (trigger) {
        await trigger.click();
      } else {
        await field.press("Enter");
      }
      const dealerOption = await waitForDealerResult(form);
      const dealerResultsDetected = dealerOption !== null;
      let dealerSelected = false;
      let dealerSelectionVerified = false;
      if (dealerOption) {
        await dealerOption.click();
        dealerSelected = true;
        dealerSelectionVerified = await verifyDealerSelectionCommitted(page, dealerOption);
      }
      const dealerResultsDetectedOutsideForm = dealerResultsDetected
        ? false
        : await page
            .locator(DEALER_RESULT_SELECTOR)
            .count()
            .then((count) => count > 0)
            .catch(() => false);
      return {
        key: "dealerSearch",
        dealerSearch: {
          postcodeSearchTriggered: true,
          dealerResultsDetected,
          dealerSelected,
          dealerSelectionVerified,
          dealerResultsDetectedOutsideForm,
        },
      };
    }
    default:
      return {};
  }
}

async function findSubmitControl(form: Locator): Promise<Locator | null> {
  const typed = form.locator('button[type="submit"], input[type="submit"]').first();
  if ((await typed.count()) > 0) return typed;
  for (const marker of SUBMIT_TEXT_MARKERS) {
    const byText = form.getByRole("button", { name: new RegExp(marker, "i") }).first();
    if ((await byText.count()) > 0) return byText;
  }
  const lastButton = form.locator("button").last();
  return (await lastButton.count()) > 0 ? lastButton : null;
}

async function findInvalidFieldIds(form: Locator): Promise<string[]> {
  return form.evaluate((formEl: HTMLFormElement, attr: string) => {
    const invalid = Array.from(formEl.querySelectorAll(`[${attr}]`)).filter((el) => {
      const input = el as HTMLInputElement;
      // Reuses the same requiredness tagAndReadFields already computed (attribute or visible
      // marker) rather than recomputing `hasAttribute("required")` alone, which would miss a
      // field required only by a visible "*" marker.
      const isRequired = el.getAttribute(`${attr}-required`) === "true";
      return isRequired && (!input.checkValidity?.() || el.getAttribute("aria-invalid") === "true");
    });
    return invalid.map((el) => el.getAttribute(attr) ?? "");
  }, FIELD_INDEX_ATTR);
}

/**
 * Post-submit evidence, read fresh right after a submit click -- re-tagging (tagAndReadFields)
 * immediately before this is called is what lets a field a dynamic widget only revealed after
 * the submit attempt (e.g. a dealer-selection widget's own hidden "committed" field) be seen at
 * all; without that re-tag, findInvalidFieldIds can only ever see fields that already existed
 * at the start of the run, and silently reports zero invalid fields even though the site
 * cancelled the submit.
 */
async function collectPostSubmitDiagnostics(form: Locator): Promise<PostSubmitDiagnostics> {
  await tagAndReadFields(form).catch(() => []);
  const invalidFieldIds = await findInvalidFieldIds(form).catch(() => []);
  const nativeValidationMessages = await form
    .evaluate((formEl: HTMLFormElement, attr: string) => {
      const messages: Record<string, string> = {};
      Array.from(formEl.querySelectorAll(`[${attr}]`)).forEach((el) => {
        const message = (el as HTMLInputElement).validationMessage;
        if (message) messages[el.getAttribute(attr) ?? ""] = message;
      });
      return messages;
    }, FIELD_INDEX_ATTR)
    .catch(() => ({}));
  const postSubmitValidationMessages = await form
    .evaluate((formEl: HTMLFormElement) => {
      const nodes = Array.from(formEl.querySelectorAll('[role="alert"], [aria-live], .error, .error-message, .invalid-feedback'));
      return nodes.map((n) => n.textContent?.trim() ?? "").filter((t) => t.length > 0);
    })
    .catch(() => []);
  return { invalidFieldIds, nativeValidationMessages, postSubmitValidationMessages };
}

async function detectCaptchaOnPage(page: Page): Promise<boolean> {
  const iframeSrcs = await page.evaluate(() => Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src") ?? ""));
  const elementAttributes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[class],[data-sitekey]")).map((el) => `${el.className ?? ""} ${el.getAttribute("data-sitekey") ?? ""}`),
  );
  const visibleText = await page.evaluate(() => document.body.innerText).catch(() => "");
  return detectCaptcha({ iframeSrcs, elementAttributes, visibleText });
}

async function detectConfirmationText(page: Page): Promise<boolean> {
  const text = await page
    .evaluate(() => document.body.innerText)
    .then((t) => t.toLowerCase())
    .catch(() => "");
  return SUCCESS_TEXT_MARKERS.some((marker) => text.includes(marker));
}

async function captureAnalyticsPhase(page: Page, captures: Captures, stepIndex: number, captureModules: CaptureModuleName[]): Promise<void> {
  let detach: (() => void) | undefined;
  if (captureModules.includes("ga4_network_events")) {
    detach = attachGa4NetworkCapture(page, captures, () => stepIndex, { contextId: `fill_form:${stepIndex}` });
  }
  await page.waitForTimeout(300);
  detach?.();
  if (captureModules.includes("data_layer_evidence")) {
    const entries = await captureDataLayer(page, stepIndex, { contextId: `fill_form:${stepIndex}` });
    captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), ...entries];
  }
}

function scorePlan(plan: PlannedField[]): number {
  return plan.filter((p) => p.decision.kind !== "skip").length;
}

export async function executeFillForm(params: ExecuteFillFormParams): Promise<ActionResult> {
  const { page, captures, stepIndex, captureModules, unmappedFieldResolver, selectionAmbiguityResolver } = params;
  const journeyContext: FormJourneyContext = params.journeyContext ?? {};

  const forms = page.locator("form");
  const formsOnPage = await forms.count();
  if (formsOnPage === 0) {
    return { success: false, error: "no_form_found" };
  }

  if (await detectCaptchaOnPage(page)) {
    return { success: false, formFillOutcome: "blocked_captcha" };
  }

  const htmlLang = await page.evaluate(() => document.documentElement.lang || undefined).catch(() => undefined);
  const actionMarketParam = typeof params.action?.params?.market === "string" ? (params.action.params.market as string) : undefined;
  const language: SupportedLanguage = detectPageLanguage(htmlLang);
  const market = resolveMarket(language, actionMarketParam);

  /**
   * A page can have several <form> elements (search, newsletter, cookie/consent, the actual
   * lead form) in any document order. Field count alone is not a reliable signal -- a
   * newsletter signup can easily have more fillable fields than the correct request-a-quote
   * form (the production bug this scoring replaced). Every candidate is scored on journey
   * relevance (does its own text match the objective/active-milestone/previous-CTA anchors,
   * and generic request-a-quote/offer/test-drive/contact vocabulary, never newsletter/search/
   * login vocabulary), visual prominence (visible, in the main content area, a reasonably
   * large area, a nearby heading, a visible submit control), and field actionability as
   * supporting evidence only -- see forms/formRelevance.ts.
   */
  const pageSignals = await gatherSemanticPageSignals(page);
  const candidateEvidence: {
    index: number;
    hasCountryCodeSelector: boolean;
    hasDealerSearchWidget: boolean;
    textSignals: FormTextSignals;
    score: ReturnType<typeof computeFormScore>;
  }[] = [];
  for (let i = 0; i < formsOnPage; i += 1) {
    const candidate = forms.nth(i);
    const hasCountryCodeSelectorCandidate = (await candidate.locator('select[name*="country" i], select[name*="dial" i]').count()) > 0;
    // Structural, generic dealer-widget detection (a search trigger plus an accessible
    // selectable-result container) -- never label text, which a dealer-search postcode field
    // very often shares with a plain postcode field. See fillPlan.ts's hasDealerSearchWidget.
    const hasDealerSearchWidgetCandidate =
      (await findSearchTrigger(candidate)) !== null && (await candidate.locator(DEALER_RESULT_SELECTOR).count()) > 0;
    const raw = await tagAndReadFields(candidate);
    const descriptors = raw.map(toDescriptor);
    const plan = buildFillPlan(descriptors, {
      language,
      market,
      hasCountryCodeSelector: hasCountryCodeSelectorCandidate,
      hasDealerSearchWidget: hasDealerSearchWidgetCandidate,
    });
    const actionableFieldCount = scorePlan(plan);
    const formSignals = await gatherFormSignals(candidate);

    const textSignals: FormTextSignals = {
      pageTitle: pageSignals.title,
      pageHeadings: pageSignals.headings,
      nearestHeadingText: formSignals.nearestHeadingText,
      submitButtonText: formSignals.submitButtonText,
      formAttributesText: formSignals.formAttributesText,
    };
    const visibilitySignals: FormVisibilityProminenceSignals = {
      visible: formSignals.visible,
      inChrome: formSignals.inChrome,
      areaRatio: formSignals.areaRatio,
      hasNearbyHeading: formSignals.hasNearbyHeading,
      hasVisibleSubmitButton: formSignals.hasVisibleSubmitButton,
    };

    candidateEvidence.push({
      index: i,
      hasCountryCodeSelector: hasCountryCodeSelectorCandidate,
      hasDealerSearchWidget: hasDealerSearchWidgetCandidate,
      textSignals,
      score: computeFormScore({
        journeyContext,
        textSignals,
        visibilitySignals,
        fieldsDiscovered: descriptors.length,
        actionableFieldCount,
      }),
    });
  }

  const candidates: FormCandidate[] = candidateEvidence.map((c) => ({ index: c.index, score: c.score }));
  let selection = selectBestForm(candidates);

  if (selection.ambiguous && selectionAmbiguityResolver) {
    const resolved = await resolveAmbiguousFormSelection(
      { candidates: candidateEvidence.map((c) => ({ index: c.index, textSignals: c.textSignals, score: c.score })), journeyContext },
      selectionAmbiguityResolver,
    );
    if (resolved) {
      selection = {
        ...selection,
        chosenIndex: resolved.chosenIndex,
        ambiguous: false,
        selectedFormReason: `Claude-assisted tiebreak (independently verified): ${resolved.rationale}`,
      };
    }
  }

  const chosenEvidence = candidateEvidence.find((c) => c.index === selection.chosenIndex)!;
  const formSelectionDiagnostics = {
    journeyRelevanceScore: chosenEvidence.score.journeyRelevanceScore,
    visibilityProminenceScore: chosenEvidence.score.visibilityProminenceScore,
    fieldActionabilityScore: chosenEvidence.score.fieldActionabilityScore,
    totalFormScore: chosenEvidence.score.totalFormScore,
    selectedFormReason: selection.selectedFormReason,
    rejectedFormsAndReasons: selection.rejectedFormsAndReasons,
  };

  // Safety: an ambiguous selection the resolver couldn't (or wasn't asked to) resolve is
  // never guessed away, and a selection below the confidence threshold is never filled or
  // submitted at all -- "do not submit when confidence is below a defined threshold".
  if (selection.belowConfidenceThreshold || selection.ambiguous) {
    return {
      success: false,
      formFillOutcome: "form_discovery_failed",
      formMarketDetected: market,
      formLanguageDetected: language,
      formDiscoveryDiagnostics: {
        formsOnPage,
        selectedFormIndex: selection.chosenIndex,
        fieldsDiscovered: 0,
        requiredFieldsDetected: 0,
        requiredFieldsFilled: 0,
        dealerSearchWidgetDetected: chosenEvidence.hasDealerSearchWidget,
        unmappedRequiredFieldIds: [],
        skippedFieldReasons: [],
        fieldDiagnostics: [],
        ...formSelectionDiagnostics,
        selectedFormReason: selection.ambiguous
          ? `ambiguous: ${selection.selectedFormReason} (no verified tiebreak available)`
          : selection.selectedFormReason,
      },
    };
  }

  const form = forms.nth(selection.chosenIndex);
  const hasCountryCodeSelector = chosenEvidence.hasCountryCodeSelector;
  const hasDealerSearchWidget = chosenEvidence.hasDealerSearchWidget;

  const fieldsFilled = new Set<string>();
  let claudeCallUsed = false;
  let retries = 0;
  let dealerSearchDiagnostics: DealerSearchDiagnostics | undefined;

  async function fillAllRequired(onlyIndices?: Set<string>): Promise<{ plan: PlannedField[]; filledIds: Set<string> }> {
    const raw = await tagAndReadFields(form);
    const descriptors = raw.map(toDescriptor).filter((d) => !onlyIndices || onlyIndices.has(d.id));
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector, hasDealerSearchWidget });
    const filledIds = new Set<string>();

    const needingClaude = plan.filter((p) => p.decision.kind === "needs_claude");
    let resolved: Map<string, string> | undefined;
    if (needingClaude.length > 0 && unmappedFieldResolver) {
      claudeCallUsed = true;
      const resolutions = await unmappedFieldResolver.resolve(
        needingClaude.map((p) => p.descriptor),
        { language, market },
      );
      resolved = new Map(resolutions.map((r) => [r.fieldId, r.value]));
    }

    for (const plannedField of plan) {
      if (plannedField.decision.kind === "needs_claude") {
        const value = resolved?.get(plannedField.descriptor.id);
        if (value !== undefined) {
          const field = await fieldByIndex(form, plannedField.descriptor.id);
          await field.fill(value);
          fieldsFilled.add("claude_resolved");
          filledIds.add(plannedField.descriptor.id);
        }
        continue;
      }
      const outcome = await applyDecision(page, form, plannedField, hasCountryCodeSelector);
      if (outcome.dealerSearch) dealerSearchDiagnostics = outcome.dealerSearch;
      if (outcome.key) {
        fieldsFilled.add(outcome.key);
        filledIds.add(plannedField.descriptor.id);
      }
    }
    return { plan, filledIds };
  }

  const { plan: initialPlan, filledIds: initialFilledIds } = await fillAllRequired();

  const requiredFields = initialPlan.filter((p) => p.descriptor.required && p.descriptor.visible);
  const requiredFieldsFilled = requiredFields.filter((p) => initialFilledIds.has(p.descriptor.id)).length;
  const actionableFields = initialPlan.filter((p) => p.decision.kind !== "skip");
  const formDiscoveryDiagnostics = {
    formsOnPage,
    selectedFormIndex: selection.chosenIndex,
    fieldsDiscovered: initialPlan.length,
    requiredFieldsDetected: requiredFields.length,
    requiredFieldsFilled,
    dealerSearchWidgetDetected: hasDealerSearchWidget,
    unmappedRequiredFieldIds: requiredFields.filter((p) => !initialFilledIds.has(p.descriptor.id)).map((p) => p.descriptor.id),
    skippedFieldReasons: initialPlan
      .filter((p): p is PlannedField & { decision: { kind: "skip"; reason: string } } => p.decision.kind === "skip")
      .map((p) => ({ id: p.descriptor.id, reason: p.decision.reason })),
    fieldDiagnostics: initialPlan.map((p) => ({
      id: p.descriptor.id,
      label: p.descriptor.label ?? "",
      type: p.descriptor.tagName === "input" ? p.descriptor.type ?? "text" : p.descriptor.tagName,
      visible: p.descriptor.visible,
      requiredEvidence: p.descriptor.requiredEvidence ?? "none",
      valueState: (p.descriptor.isPlaceholderMimicry
        ? "placeholder_mimicry"
        : p.descriptor.currentValue.trim().length > 0
          ? "has_value"
          : "empty") as "empty" | "has_value" | "placeholder_mimicry",
      matchedField: p.matchedField,
      decision: p.decision.kind,
      filled: initialFilledIds.has(p.descriptor.id),
    })),
    ...formSelectionDiagnostics,
  };

  // Safety: never submit having filled nothing. The chosen form's fieldActionabilityScore
  // (computed at selection time, before any fill attempt) and the actual post-fill-attempt
  // outcome are checked independently -- either one alone catching zero fillable/filled
  // fields is enough to stop here, rather than only the narrower "detected >=1 required
  // field but filled none" case, which a required-detection gap (or any other discovery
  // miss) can silently defeat by making requiredFields.length itself 0.
  if (
    formSelectionDiagnostics.fieldActionabilityScore === 0 ||
    actionableFields.length === 0 ||
    initialFilledIds.size === 0 ||
    (requiredFields.length > 0 && requiredFieldsFilled === 0)
  ) {
    return {
      success: false,
      formFillOutcome: "form_discovery_failed",
      formMarketDetected: market,
      formLanguageDetected: language,
      formClaudeCallUsed: claudeCallUsed,
      formDiscoveryDiagnostics,
    };
  }

  const submitControl = await findSubmitControl(form);
  if (!submitControl) {
    return { success: false, error: "no_submit_control_found", formDiscoveryDiagnostics };
  }
  const submit: Locator = submitControl;

  const beforeUrl = page.url();

  async function rerunDealerSearch(): Promise<void> {
    const raw = await tagAndReadFields(form);
    const descriptors = raw.map(toDescriptor);
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector, hasDealerSearchWidget });
    const dealerField = plan.find((p) => p.decision.kind === "dealer_search");
    if (!dealerField) return;
    const outcome = await applyDecision(page, form, dealerField, hasCountryCodeSelector);
    if (outcome.dealerSearch) dealerSearchDiagnostics = outcome.dealerSearch;
  }

  async function attemptSubmit(): Promise<{ postSubmit: PostSubmitDiagnostics; succeeded: boolean; afterUrl: string }> {
    await submit.click();
    await waitForAdaptiveSettle(page);
    const afterUrl = page.url();
    const urlChanged = afterUrl !== beforeUrl;
    // A URL change already proves the submit went through -- `form` now refers to whatever
    // (if anything) matches the same index on the page we navigated to, not the form that was
    // submitted, so reading post-submit diagnostics from it here would just be evaluating
    // against a gone/unrelated element until Playwright's default action timeout gives up.
    const postSubmit: PostSubmitDiagnostics = urlChanged
      ? { invalidFieldIds: [], nativeValidationMessages: {}, postSubmitValidationMessages: [] }
      : await collectPostSubmitDiagnostics(form);
    const hasConfirmationText = !urlChanged && postSubmit.invalidFieldIds.length === 0 && (await detectConfirmationText(page));
    const succeeded = postSubmit.invalidFieldIds.length === 0 && (urlChanged || hasConfirmationText);
    return { postSubmit, succeeded, afterUrl };
  }

  let attempt = await attemptSubmit();
  await captureAnalyticsPhase(page, captures, stepIndex, captureModules);

  let retryDecision = "not needed: the first submit succeeded";

  // Never treat requiredFieldsFilled/initial fill success as proof a dynamic widget's
  // dependent selection (e.g. a dealer-results list) is complete -- only a verified,
  // re-read post-submit state decides whether a retry has a real corrective action
  // available: an unverified dealer selection, or at least one invalid field to re-read and
  // re-fill. With neither, a retry would just resubmit the exact same state, so it's refused
  // rather than burning the bounded retry budget pretending to fix something.
  while (!attempt.succeeded && retries < MAX_RETRIES) {
    const dealerUncommitted = dealerSearchDiagnostics !== undefined && !dealerSearchDiagnostics.dealerSelectionVerified;
    const correctiveActionAvailable = dealerUncommitted || attempt.postSubmit.invalidFieldIds.length > 0;

    if (!correctiveActionAvailable) {
      retryDecision = "not retried: the submit was cancelled but no invalid field or uncommitted dealer selection was found to correct";
      break;
    }

    retries += 1;
    if (dealerUncommitted) {
      await rerunDealerSearch();
      retryDecision = `retried ${retries}/${MAX_RETRIES}: re-ran the dealer search/select/verify flow after an uncommitted selection`;
    } else {
      await fillAllRequired(new Set(attempt.postSubmit.invalidFieldIds));
      retryDecision = `retried ${retries}/${MAX_RETRIES}: re-read live validation state and re-filled ${attempt.postSubmit.invalidFieldIds.join(", ")}`;
    }
    attempt = await attemptSubmit();
  }

  // Always present, even when the dealer_search decision never ran at all (e.g. no dealer
  // widget was structurally detected on this form) -- a promised diagnostic field must appear
  // with explicit false defaults rather than being silently omitted from the serialized
  // response, which previously made "the dealer flow never activated" indistinguishable from
  // "it activated and every step came back false".
  const formDealerSearchDiagnostics = dealerSearchDiagnostics ?? EMPTY_DEALER_SEARCH_DIAGNOSTICS;
  const formPostSubmitDiagnostics = {
    submitCanceled: !attempt.succeeded,
    invalidFieldIds: attempt.postSubmit.invalidFieldIds,
    nativeValidationMessages: attempt.postSubmit.nativeValidationMessages,
    postSubmitValidationMessages: attempt.postSubmit.postSubmitValidationMessages,
    retryDecision,
  };

  if (!attempt.succeeded) {
    return {
      success: false,
      formFillOutcome: "form_validation_failed",
      formRetriesUsed: retries,
      formValidationMissingFields: attempt.postSubmit.invalidFieldIds,
      formFieldsFilled: [...fieldsFilled],
      formMarketDetected: market,
      formLanguageDetected: language,
      formClaudeCallUsed: claudeCallUsed,
      formDiscoveryDiagnostics,
      formDealerSearchDiagnostics,
      formPostSubmitDiagnostics,
    };
  }

  await captureAnalyticsPhase(page, captures, stepIndex + 1, captureModules);

  return {
    success: true,
    resultingUrl: attempt.afterUrl,
    formFillOutcome: "submitted",
    formSuccessDetection: attempt.afterUrl !== beforeUrl ? "url_change" : "on_screen_message",
    formRetriesUsed: retries,
    formFieldsFilled: [...fieldsFilled],
    formMarketDetected: market,
    formLanguageDetected: language,
    formClaudeCallUsed: claudeCallUsed,
    formDiscoveryDiagnostics,
    formDealerSearchDiagnostics,
    formPostSubmitDiagnostics,
  };
}
