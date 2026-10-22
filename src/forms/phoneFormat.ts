import type { LeadFormFieldKey } from "./fieldKeywords.js";

const PHONE_FIELD_KEYS: ReadonlySet<string> = new Set<LeadFormFieldKey>(["landlinePhone", "mobilePhone", "genericPhone"]);

// Whitespace (incl. NBSP / narrow NBSP) plus the separators people use to make a number readable.
const PRESENTATION_SEPARATORS = /[\s  .\-()/]/g;

export interface PhoneInputConstraints {
  pattern?: string | null;
  /** -1 (the DOM default) or undefined when the field sets none. */
  maxLength?: number;
  minLength?: number;
}

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

function patternMatcher(pattern: string): ((value: string) => boolean) | undefined {
  // HTML compiles `pattern` with the "v" flag, anchored to the whole value; fall back to "u"
  // where the runtime lacks "v", and ignore a pattern the browser itself would ignore as invalid.
  for (const flags of ["v", "u"]) {
    try {
      const regex = new RegExp(`^(?:${pattern})$`, flags);
      return (value) => regex.test(value);
    } catch {
      continue;
    }
  }
  return undefined;
}

function satisfies(value: string, constraints: PhoneInputConstraints): boolean {
  const { pattern, maxLength, minLength } = constraints;
  if (pattern) {
    const matches = patternMatcher(pattern);
    if (matches && !matches(value)) {
      return false;
    }
  }
  if (maxLength !== undefined && maxLength >= 0 && value.length > maxLength) {
    return false;
  }
  if (minLength !== undefined && minLength > 0 && value.length < minLength) {
    return false;
  }
  return true;
}

/**
 * Picks the value to type into a confidently identified phone field: the compact form by
 * default, but the configured (formatted) form when the field's own declared constraints
 * accept only that one -- a field whose `pattern` demands separators is never sent a value it
 * would reject. When neither form satisfies the constraints, the compact form is used.
 */
export function phoneValueForField(configured: string, constraints: PhoneInputConstraints = {}): string {
  const compact = normalisePhoneForInput(configured);
  if (compact === configured) {
    return configured;
  }
  if (satisfies(compact, constraints)) {
    return compact;
  }
  return satisfies(configured, constraints) ? configured : compact;
}
