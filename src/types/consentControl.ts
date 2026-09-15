/**
 * Self-reported semantic classification of the consent/tracking-preference intent behind a
 * reasoning decision's chosen action. Generic and language-agnostic by construction: the
 * reasoning layer judges this from a control's accessibleName/type/ariaState (the same
 * semantic judgement it already applies to every other action choice), never from a fixed
 * wordlist, vendor attribute, or selector. Paired with ConsentInteractionPolicy
 * (task-request.ts) so the engine can deterministically check a decision against the
 * requested policy without the engine itself ever having to recognise a specific control.
 *
 * - "grants_optional_consent": the chosen control's purpose is to accept/allow optional,
 *   non-essential, or broad consent/tracking (e.g. an "accept all" style control).
 * - "declines_optional_consent": the chosen control's purpose is to decline optional
 *   consent, keep only strictly necessary/essential functionality, or continue without
 *   granting broad consent.
 * - "opens_consent_settings": the chosen control's purpose is to open a granular
 *   consent/preferences management surface, without itself directly granting or declining.
 * - "not_consent_related": the chosen action has nothing to do with consent/tracking
 *   preferences (the overwhelming majority of decisions).
 */
export type ConsentControlIntent =
  | "grants_optional_consent"
  | "declines_optional_consent"
  | "opens_consent_settings"
  | "not_consent_related";

export const CONSENT_CONTROL_INTENTS: readonly [ConsentControlIntent, ...ConsentControlIntent[]] = [
  "grants_optional_consent",
  "declines_optional_consent",
  "opens_consent_settings",
  "not_consent_related",
];
