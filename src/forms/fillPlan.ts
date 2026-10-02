import { matchLeadFormField, type FormFieldTextHints } from "./fieldMapper.js";
import type { LeadFormFieldKey } from "./fieldKeywords.js";
import { FIXED_FIELDS, marketDataFor, phoneValueFor, titleFor, type SupportedLanguage, type SupportedMarket } from "./testData.js";

export type FormFieldTagName = "input" | "select" | "textarea";

export interface SelectOptionDescriptor {
  value: string;
  label: string;
}

export interface FormFieldDescriptor extends FormFieldTextHints {
  id: string;
  tagName: FormFieldTagName;
  type?: string;
  required: boolean;
  visible: boolean;
  /** Current value for a text-like field; the selected option's value for a select; "true"/"false" for a checkbox. */
  currentValue: string;
  /** True for a select/radio-group already resting on a non-default, meaningfully-chosen option. */
  isPreselected?: boolean;
  options?: SelectOptionDescriptor[];
}

export type FillDecision =
  | { kind: "skip"; reason: "prefilled" | "hidden" | "optional" | "no_free_text_target" }
  | { kind: "fill_text"; field: LeadFormFieldKey | "genericRequiredText"; value: string }
  | { kind: "select_option"; value: string }
  | { kind: "choose_first_valid_option" }
  | { kind: "select_negative_option" }
  | { kind: "tick_checkbox" }
  | { kind: "dealer_search"; postcode: string }
  | { kind: "needs_claude" };

export interface PlannedField {
  descriptor: FormFieldDescriptor;
  matchedField?: LeadFormFieldKey;
  decision: FillDecision;
}

export interface FillPlanContext {
  language: SupportedLanguage;
  market: SupportedMarket;
  hasCountryCodeSelector: boolean;
}

const NEGATIVE_OPTION_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["no", "i do not agree", "do not agree"],
  fr: ["non", "je ne souhaite pas", "je n'accepte pas"],
  de: ["nein", "ich stimme nicht zu"],
  nl: ["nee", "ik ga niet akkoord"],
  it: ["no", "non accetto"],
  es: ["no", "no acepto"],
  pl: ["nie", "nie zgadzam sie", "nie zgadzam się"],
  pt: ["nao", "não", "nao aceito", "não aceito"],
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function findNegativeOption(options: SelectOptionDescriptor[], language: SupportedLanguage): SelectOptionDescriptor | undefined {
  const keywords = NEGATIVE_OPTION_KEYWORDS[language] ?? NEGATIVE_OPTION_KEYWORDS.en;
  return options.find((option) => keywords.some((keyword) => normalize(option.label).includes(normalize(keyword))));
}

function firstValidOption(options: SelectOptionDescriptor[]): SelectOptionDescriptor | undefined {
  return options.find((option) => option.value.trim().length > 0);
}

const CONSENT_FIELDS: LeadFormFieldKey[] = ["consentStayInTouch", "consentPersonalised", "consentPartners"];

export function planField(descriptor: FormFieldDescriptor, context: FillPlanContext): PlannedField {
  const matchedField = matchLeadFormField(descriptor);

  if (!descriptor.visible || descriptor.type === "hidden") {
    return { descriptor, matchedField, decision: { kind: "skip", reason: "hidden" } };
  }

  const isCheckbox = descriptor.type === "checkbox";
  const isPrefilled = isCheckbox
    ? descriptor.currentValue === "true" || Boolean(descriptor.isPreselected)
    : descriptor.currentValue.trim().length > 0 || Boolean(descriptor.isPreselected);
  if (isPrefilled) {
    return { descriptor, matchedField, decision: { kind: "skip", reason: "prefilled" } };
  }

  if (matchedField && CONSENT_FIELDS.includes(matchedField)) {
    if (isCheckbox) {
      return descriptor.required
        ? { descriptor, matchedField, decision: { kind: "tick_checkbox" } }
        : { descriptor, matchedField, decision: { kind: "skip", reason: "optional" } };
    }
    if (descriptor.tagName === "select" && descriptor.options) {
      return { descriptor, matchedField, decision: { kind: "select_negative_option" } };
    }
  }

  if (descriptor.tagName === "select" && matchedField === "dealerSearch" && descriptor.options) {
    return { descriptor, matchedField, decision: { kind: "choose_first_valid_option" } };
  }

  if (!descriptor.required) {
    return { descriptor, matchedField, decision: { kind: "skip", reason: "optional" } };
  }

  if (descriptor.tagName === "select") {
    if (!descriptor.options || descriptor.options.length === 0) {
      return { descriptor, matchedField, decision: { kind: "skip", reason: "no_free_text_target" } };
    }
    const negative = findNegativeOption(descriptor.options, context.language);
    if (negative) {
      return { descriptor, matchedField, decision: { kind: "select_negative_option" } };
    }
    return { descriptor, matchedField, decision: { kind: "choose_first_valid_option" } };
  }

  switch (matchedField) {
    case "title":
      return { descriptor, matchedField, decision: { kind: "fill_text", field: "title", value: titleFor(context.language) } };
    case "firstName":
      return { descriptor, matchedField, decision: { kind: "fill_text", field: "firstName", value: FIXED_FIELDS.firstName } };
    case "lastName":
      return { descriptor, matchedField, decision: { kind: "fill_text", field: "lastName", value: FIXED_FIELDS.lastName } };
    case "email":
      return { descriptor, matchedField, decision: { kind: "fill_text", field: "email", value: FIXED_FIELDS.email } };
    case "postcode":
      return {
        descriptor,
        matchedField,
        decision: { kind: "fill_text", field: "postcode", value: marketDataFor(context.market).postcode },
      };
    case "dealerSearch":
      return { descriptor, matchedField, decision: { kind: "dealer_search", postcode: marketDataFor(context.market).postcode } };
    case "landlinePhone":
      return {
        descriptor,
        matchedField,
        decision: { kind: "fill_text", field: "landlinePhone", value: phoneValueFor(context.market, "landline", context.hasCountryCodeSelector) },
      };
    case "mobilePhone":
    case "genericPhone":
      return {
        descriptor,
        matchedField,
        decision: {
          kind: "fill_text",
          field: matchedField,
          value: phoneValueFor(context.market, "mobile", context.hasCountryCodeSelector),
        },
      };
    default:
      if (descriptor.tagName === "input" || descriptor.tagName === "textarea") {
        if (descriptor.type === "checkbox") {
          return { descriptor, matchedField, decision: { kind: "tick_checkbox" } };
        }
        return { descriptor, matchedField, decision: { kind: "needs_claude" } };
      }
      return { descriptor, matchedField, decision: { kind: "skip", reason: "no_free_text_target" } };
  }
}

export function buildFillPlan(descriptors: FormFieldDescriptor[], context: FillPlanContext): PlannedField[] {
  return descriptors.map((descriptor) => planField(descriptor, context));
}

export function fieldsNeedingClaude(plan: PlannedField[]): FormFieldDescriptor[] {
  return plan.filter((p) => p.decision.kind === "needs_claude").map((p) => p.descriptor);
}
