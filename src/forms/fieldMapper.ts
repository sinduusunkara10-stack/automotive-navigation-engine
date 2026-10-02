import { allKeywordLanguages, keywordsFor, type LeadFormFieldKey } from "./fieldKeywords.js";
import type { SupportedLanguage } from "./testData.js";

/** Priority order: more specific keys are tried before the generic fallbacks they could otherwise collide with. */
const MATCH_ORDER: LeadFormFieldKey[] = [
  "title",
  "firstName",
  "lastName",
  "email",
  "landlinePhone",
  "mobilePhone",
  "dealerSearch",
  "postcode",
  "genericPhone",
  "consentStayInTouch",
  "consentPersonalised",
  "consentPartners",
];

export interface FormFieldTextHints {
  label?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function combinedText(hints: FormFieldTextHints): string {
  return normalize([hints.label, hints.name, hints.placeholder, hints.autocomplete].filter(Boolean).join(" "));
}

/**
 * Matches against every supported language's keyword list, not just the page's own detected
 * language -- a mistranslated or English-fallback label on an otherwise-localized page still
 * maps correctly, and the page's detected language only decides which *test-data value*
 * (title, phone format) is used once a field is identified.
 */
export function matchLeadFormField(hints: FormFieldTextHints): LeadFormFieldKey | undefined {
  const text = combinedText(hints);
  if (!text) {
    return undefined;
  }
  for (const field of MATCH_ORDER) {
    for (const language of allKeywordLanguages()) {
      for (const keyword of keywordsFor(field, language)) {
        if (text.includes(normalize(keyword))) {
          return field;
        }
      }
    }
  }
  return undefined;
}

export function detectPageLanguage(htmlLangAttribute: string | undefined, fallback: SupportedLanguage = "en"): SupportedLanguage {
  if (!htmlLangAttribute) {
    return fallback;
  }
  const primary = htmlLangAttribute.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  const supported: SupportedLanguage[] = ["en", "fr", "de", "nl", "it", "es", "pl", "pt"];
  return (supported as string[]).includes(primary) ? (primary as SupportedLanguage) : fallback;
}
