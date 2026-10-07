import type { SupportedLanguage } from "./testData.js";

/**
 * Generic, multilingual handling for a required `<select>` with no matched field and no
 * negative/consent-shaped options -- the common shape of a model/engine/trim-style choice
 * where *any* valid option is acceptable to the automation (see docs/architecture.md "Lead-
 * form filling"). This never encodes a brand, model, or market name: only option-level
 * structural evidence (the `disabled` attribute) and a small generic placeholder-wording
 * vocabulary, the same per-language incremental-vocabulary shape fieldKeywords.ts already uses.
 */
export interface SelectOptionCandidate {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Generic "please choose" wording -- never a brand/model name, just the placeholder-option convention itself. */
const PLACEHOLDER_OPTION_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["select", "choose", "please select", "please choose", "select an option", "select one", "-- select --"],
  fr: ["selectionnez", "sélectionnez", "choisissez", "veuillez selectionner", "veuillez sélectionner"],
  de: ["bitte wahlen", "bitte wählen", "auswahlen", "auswählen"],
  nl: ["selecteer", "kies"],
  it: ["selezionare", "seleziona", "scegli"],
  es: ["seleccione", "elija"],
  pl: ["wybierz"],
  pt: ["selecione", "escolha"],
};

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

/**
 * True for an option that is a real, selectable choice -- never disabled, never an empty
 * value, and never a label matching the generic placeholder-wording vocabulary (exact match
 * only, so a real option that merely contains a substring like "select" as part of a longer
 * model name is never wrongly excluded).
 */
export function isSelectableOption(option: SelectOptionCandidate, language: SupportedLanguage): boolean {
  if (option.disabled) {
    return false;
  }
  if (option.value.trim().length === 0) {
    return false;
  }
  const normalizedLabel = normalize(option.label);
  const keywords = PLACEHOLDER_OPTION_KEYWORDS[language] ?? PLACEHOLDER_OPTION_KEYWORDS.en;
  return !keywords.some((keyword) => normalizedLabel === normalize(keyword));
}

/**
 * The fixed fallback policy for a required select with no matched field, no preselection, and
 * no negative/consent option: any valid choice is acceptable to the automation, so the first
 * selectable option in document order wins deterministically -- never a brand/model-specific
 * rule about which option to prefer.
 */
export function firstSelectableOption(options: SelectOptionCandidate[], language: SupportedLanguage): SelectOptionCandidate | undefined {
  return options.find((option) => isSelectableOption(option, language));
}
