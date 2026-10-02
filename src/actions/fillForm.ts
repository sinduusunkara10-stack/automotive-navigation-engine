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

export interface ExecuteFillFormParams {
  page: Page;
  action: SelectedAction;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  /** Optional, injected once per run -- see unmappedFieldResolver.ts. Never required: an unresolved required field simply stays empty and surfaces via the validation-retry path. */
  unmappedFieldResolver?: UnmappedFieldResolver;
}

interface RawFieldDescriptor {
  index: number;
  tagName: string;
  type?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  label?: string;
  required: boolean;
  visible: boolean;
  currentValue: string;
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

      const id = el.getAttribute("id");
      const byForLabel = id ? formEl.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const closestLabel = el.closest("label");
      const label = byForLabel?.textContent?.trim() || closestLabel?.textContent?.trim() || el.getAttribute("aria-label") || "";

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";

      return {
        index,
        tagName: tagName as "input" | "select" | "textarea",
        type,
        name: el.getAttribute("name") ?? undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        autocomplete: el.getAttribute("autocomplete") ?? undefined,
        label,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        visible,
        currentValue,
        isPreselected,
        options,
      };
    });
  }, FIELD_INDEX_ATTR);
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
    visible: raw.visible,
    currentValue: raw.currentValue,
    isPreselected: raw.isPreselected,
    options: raw.options,
  };
}

async function fieldByIndex(form: Locator, index: string): Promise<Locator> {
  return form.locator(`[${FIELD_INDEX_ATTR}="${index}"]`);
}

async function applyDecision(form: Locator, plannedField: PlannedField, hasCountryCodeSelector: boolean): Promise<string | undefined> {
  const field = await fieldByIndex(form, plannedField.descriptor.id);
  switch (plannedField.decision.kind) {
    case "fill_text":
      await field.fill(plannedField.decision.value);
      return plannedField.decision.field;
    case "select_option": {
      await field.selectOption({ value: plannedField.decision.value });
      return plannedField.matchedField;
    }
    case "choose_first_valid_option": {
      const options = plannedField.descriptor.options ?? [];
      const first = options.find((o) => o.value.trim().length > 0);
      if (first) await field.selectOption({ value: first.value });
      return plannedField.matchedField;
    }
    case "select_negative_option": {
      const options = plannedField.descriptor.options ?? [];
      if (options.length > 0 && plannedField.descriptor.tagName === "select") {
        await field.selectOption({ value: options[options.length - 1]!.value });
      }
      return plannedField.matchedField;
    }
    case "tick_checkbox":
      await field.check();
      return plannedField.matchedField;
    case "dealer_search": {
      await field.fill(plannedField.decision.postcode);
      await field.press("Enter");
      return "dealerSearch";
    }
    default:
      return undefined;
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
      return input.hasAttribute("required") && (!input.checkValidity?.() || el.getAttribute("aria-invalid") === "true");
    });
    return invalid.map((el) => el.getAttribute(attr) ?? "");
  }, FIELD_INDEX_ATTR);
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

export async function executeFillForm(params: ExecuteFillFormParams): Promise<ActionResult> {
  const { page, captures, stepIndex, captureModules, unmappedFieldResolver } = params;

  const form = page.locator("form").first();
  if ((await form.count()) === 0) {
    return { success: false, error: "no_form_found" };
  }

  if (await detectCaptchaOnPage(page)) {
    return { success: false, formFillOutcome: "blocked_captcha" };
  }

  const htmlLang = await page.evaluate(() => document.documentElement.lang || undefined).catch(() => undefined);
  const actionMarketParam = typeof params.action?.params?.market === "string" ? (params.action.params.market as string) : undefined;
  const language: SupportedLanguage = detectPageLanguage(htmlLang);
  const market = resolveMarket(language, actionMarketParam);
  const hasCountryCodeSelector = (await form.locator('select[name*="country" i], select[name*="dial" i]').count()) > 0;

  const fieldsFilled = new Set<string>();
  let claudeCallUsed = false;
  let retries = 0;
  let beforeUrl = page.url();

  async function fillAllRequired(onlyIndices?: Set<string>): Promise<void> {
    const raw = await tagAndReadFields(form);
    const descriptors = raw.map(toDescriptor).filter((d) => !onlyIndices || onlyIndices.has(d.id));
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector });

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
        }
        continue;
      }
      const key = await applyDecision(form, plannedField, hasCountryCodeSelector);
      if (key) fieldsFilled.add(key);
    }
  }

  await fillAllRequired();

  const submit = await findSubmitControl(form);
  if (!submit) {
    return { success: false, error: "no_submit_control_found" };
  }

  beforeUrl = page.url();
  await submit.click();
  await waitForAdaptiveSettle(page);
  await captureAnalyticsPhase(page, captures, stepIndex, captureModules);

  let invalidIds = await findInvalidFieldIds(form).catch(() => []);
  while (invalidIds.length > 0 && retries < MAX_RETRIES) {
    retries += 1;
    await fillAllRequired(new Set(invalidIds));
    await submit.click();
    await waitForAdaptiveSettle(page);
    invalidIds = await findInvalidFieldIds(form).catch(() => []);
  }

  if (invalidIds.length > 0) {
    return {
      success: false,
      formFillOutcome: "form_validation_failed",
      formRetriesUsed: retries,
      formValidationMissingFields: invalidIds,
      formFieldsFilled: [...fieldsFilled],
      formMarketDetected: market,
      formLanguageDetected: language,
      formClaudeCallUsed: claudeCallUsed,
    };
  }

  const afterUrl = page.url();
  const urlChanged = afterUrl !== beforeUrl;
  const hasConfirmationText = !urlChanged && (await detectConfirmationText(page));

  if (!urlChanged && !hasConfirmationText) {
    return {
      success: false,
      formFillOutcome: "form_validation_failed",
      formRetriesUsed: retries,
      formValidationMissingFields: [],
      formFieldsFilled: [...fieldsFilled],
      formMarketDetected: market,
      formLanguageDetected: language,
      formClaudeCallUsed: claudeCallUsed,
    };
  }

  await captureAnalyticsPhase(page, captures, stepIndex + 1, captureModules);

  return {
    success: true,
    resultingUrl: afterUrl,
    formFillOutcome: "submitted",
    formSuccessDetection: urlChanged ? "url_change" : "on_screen_message",
    formRetriesUsed: retries,
    formFieldsFilled: [...fieldsFilled],
    formMarketDetected: market,
    formLanguageDetected: language,
    formClaudeCallUsed: claudeCallUsed,
  };
}
