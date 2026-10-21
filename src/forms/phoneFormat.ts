import type { LeadFormFieldKey } from "./fieldKeywords.js";

const PHONE_FIELD_KEYS: ReadonlySet<string> = new Set<LeadFormFieldKey>(["landlinePhone", "mobilePhone", "genericPhone"]);

// Whitespace (incl. NBSP / narrow NBSP) plus the separators people use to make a number readable.
const PRESENTATION_SEPARATORS = /[\s  .\-()/]/g;

export function isPhoneFieldKey(field: string): boolean {
  return PHONE_FIELD_KEYS.has(field);
}

/**
 * Converts a human-readable phone number into the compact digits-only form most site validators
 * require, keeping a leading "+". Anything that does not reduce to a plain phone number is
 * returned untouched rather than guessed at.
 */
export function normalisePhoneForInput(value: string): string {
  const compact = value.trim().replace(PRESENTATION_SEPARATORS, "");
  return /^\+?\d+$/.test(compact) ? compact : value;
}
