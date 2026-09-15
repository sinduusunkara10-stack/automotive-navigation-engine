import type { ConsentInteractionPolicy } from "../types/task-request.js";
import type { ConsentControlIntent } from "../types/consentControl.js";

export type { ConsentControlIntent } from "../types/consentControl.js";
export { CONSENT_CONTROL_INTENTS } from "../types/consentControl.js";

/**
 * Deterministic, provider-agnostic enforcement of ConsentInteractionPolicy (task-request.ts)
 * against a decision's self-reported ConsentControlIntent (consentControl.ts) -- the second,
 * engine-side line of defence that a reasoning-layer instruction alone (see
 * src/reasoning/promptBuilder.ts's consentInteractionPolicyClause) can never guarantee on its
 * own. Deliberately never inspects a control's label, selector, or vendor attribute: it only
 * compares two already-classified enum values, matching this repo's non-negotiable design
 * rule that the safety layer stays free of domain/site-specific logic (CLAUDE.md).
 *
 * "not_consent_related" is always compliant under every policy -- only a control the
 * reasoning layer itself identified as consent-related can conflict with the requested
 * policy. "opens_consent_settings" is treated as compliant under every policy: opening a
 * granular settings surface neither grants nor declines anything by itself, so it is never
 * the deterministic violation this guard exists to catch (see promptBuilder.ts's per-policy
 * prompt wording for the softer, non-enforced preference against using it as a substitute
 * for a direct control when one already exists).
 */
export function isConsentIntentCompliant(policy: ConsentInteractionPolicy, intent: ConsentControlIntent): boolean {
  if (intent === "not_consent_related" || intent === "opens_consent_settings") {
    return true;
  }
  switch (policy) {
    case "accept_optional":
      return intent !== "declines_optional_consent";
    case "do_not_interact":
      return false;
    case "essential_only":
    case "reject_optional":
    default:
      return intent !== "grants_optional_consent";
  }
}
