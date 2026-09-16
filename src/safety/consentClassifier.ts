import type { InteractiveElement, Observation } from "../types/task-response.js";

/**
 * Deterministic, engine-side consent-control assessment (see CLAUDE.md and
 * docs/architecture.md "Consent behaviour"): independently verifies a consent surface and
 * its candidate controls from the same generic DOM evidence already carried on
 * Observation/InteractiveElement (accessibleName, role, ariaState) -- never trusting only
 * the reasoning layer's own self-reported ConsentControlIntent (types/consentControl.ts),
 * which src/safety/consentPolicyGuard.ts's isConsentIntentCompliant purely reacts to after
 * the fact. This module never inspects raw HTML, a vendor/CMP-specific selector, or a
 * brand-specific string; it works from known, generic semantic patterns (positive vs
 * negative consent wording, a settings/preferences pattern, and a small set of
 * consent-context tokens used only to confirm a surface is genuinely about
 * cookies/consent/tracking/privacy before trusting any wording match at all) -- the same
 * category of evidence the task description asks for: visible text, accessible name, role,
 * and page/heading context.
 *
 * Deliberately conservative: a lone button whose label happens to contain a short token
 * like "accept" is never enough on its own -- surfaceDetected only becomes true once (a)
 * the page shows independent, generic evidence it is genuinely about
 * cookies/consent/privacy/tracking (consentContextEvidence), and (b) at least one
 * accept-shaped control coexists with at least one decline- or settings-shaped control,
 * the structural shape of a real consent choice rather than an unrelated single button.
 *
 * English-centric today by construction (the only wordlist available without a
 * translation service this engine does not have) -- structured as small, independent,
 * appendable token lists specifically so additional-language tokens can be added later
 * without changing the classification logic itself, per the requirement that this stay
 * generic across languages/brands/CMPs.
 */

export type ConsentControlPolarity = "accept_all" | "decline" | "settings";

export interface ConsentControlMatch {
  elementId: string;
  label: string;
  polarity: ConsentControlPolarity;
  evidence: string;
}

export interface ConsentSurfaceAssessment {
  surfaceDetected: boolean;
  consentContextEvidence: string[];
  acceptAllCandidate?: ConsentControlMatch;
  declineCandidate?: ConsentControlMatch;
  settingsCandidate?: ConsentControlMatch;
}

// Longer, higher-specificity phrases are checked first so "accept all" outranks a bare
// "accept" match with its own, more specific evidence string; order within a tier does not
// matter, only tier order does (checked via Array.prototype.find below).
const ACCEPT_ALL_PHRASES = [
  "accept all cookies",
  "accept all",
  "allow all cookies",
  "allow all",
  "continue with all",
  "agree to all",
  "i agree",
  "agree and continue",
];
const ACCEPT_ALL_WORDS = ["accept", "allow", "agree"];

const DECLINE_PHRASES = [
  "reject all cookies",
  "reject all",
  "decline all",
  "necessary only",
  "essential only",
  "only necessary",
  "only essential",
  "continue without accepting",
  "do not accept",
  "no thanks",
];
const DECLINE_WORDS = ["reject", "decline", "disagree"];

const SETTINGS_PHRASES = [
  "cookie settings",
  "manage preferences",
  "manage cookies",
  "cookie preferences",
  "privacy settings",
  "customize cookies",
  "customise cookies",
  "more options",
];
const SETTINGS_WORDS = ["preferences", "settings", "customize", "customise"];

const CONSENT_CONTEXT_TOKENS = [
  "cookie",
  "cookies",
  "consent",
  "privacy",
  "tracking",
  "gdpr",
  "data protection",
  "personal data",
];

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function matchesAny(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find((phrase) => text.includes(phrase));
}

/**
 * Classifies one already-observed interactive element's consent polarity from its own
 * accessibleName alone -- generic text-pattern matching, never a selector or vendor
 * attribute. Phrase-level matches are preferred (more specific, lower false-positive risk)
 * over single-word matches; when both an accept-shaped and a decline/settings-shaped phrase
 * somehow appear in the same label (rare, but possible for a long/awkward accessible name),
 * the more specific phrase match wins by being checked first.
 */
export function classifyConsentControlPolarity(accessibleName: string): { polarity: ConsentControlPolarity; evidence: string } | undefined {
  const text = normalize(accessibleName);
  if (!text) {
    return undefined;
  }

  const acceptPhrase = matchesAny(text, ACCEPT_ALL_PHRASES);
  if (acceptPhrase) {
    return { polarity: "accept_all", evidence: `label matched accept-all phrase "${acceptPhrase}"` };
  }
  const declinePhrase = matchesAny(text, DECLINE_PHRASES);
  if (declinePhrase) {
    return { polarity: "decline", evidence: `label matched decline phrase "${declinePhrase}"` };
  }
  const settingsPhrase = matchesAny(text, SETTINGS_PHRASES);
  if (settingsPhrase) {
    return { polarity: "settings", evidence: `label matched settings phrase "${settingsPhrase}"` };
  }

  const acceptWord = matchesAny(text, ACCEPT_ALL_WORDS);
  if (acceptWord) {
    return { polarity: "accept_all", evidence: `label matched accept word "${acceptWord}"` };
  }
  const declineWord = matchesAny(text, DECLINE_WORDS);
  if (declineWord) {
    return { polarity: "decline", evidence: `label matched decline word "${declineWord}"` };
  }
  const settingsWord = matchesAny(text, SETTINGS_WORDS);
  if (settingsWord) {
    return { polarity: "settings", evidence: `label matched settings word "${settingsWord}"` };
  }
  return undefined;
}

/**
 * Independent, generic evidence that the *page* (not just one button) is genuinely about
 * cookies/consent/privacy/tracking right now -- drawn only from already-captured,
 * already-generic Observation fields (notableText headings, and the candidate elements'
 * own accessible names), never a second DOM scan. Required before any button-label match
 * is trusted at all (see this module's own doc comment on why a lone "accept"-shaped label
 * is not sufficient by itself).
 */
function findConsentContextEvidence(observation: Observation, candidates: readonly InteractiveElement[]): string[] {
  const evidence: string[] = [];
  for (const heading of observation.notableText ?? []) {
    const text = normalize(heading);
    const token = CONSENT_CONTEXT_TOKENS.find((t) => text.includes(t));
    if (token) {
      evidence.push(`heading text matched consent-context token "${token}"`);
    }
  }
  for (const el of candidates) {
    const text = normalize(el.accessibleName);
    const token = CONSENT_CONTEXT_TOKENS.find((t) => text.includes(t));
    if (token) {
      evidence.push(`control "${el.accessibleName}" matched consent-context token "${token}"`);
    }
  }
  return evidence;
}

/**
 * Assesses whether a genuine consent surface with real accept/decline/settings choices is
 * currently visible, from the current Observation alone. See this module's own doc comment
 * for the conservative surfaceDetected gate.
 */
export function assessConsentSurface(observation: Observation): ConsentSurfaceAssessment {
  const candidates = observation.interactiveElements.filter(
    (el) => el.visible !== false && !el.disabled,
  );

  const matches: ConsentControlMatch[] = [];
  for (const el of candidates) {
    const classified = classifyConsentControlPolarity(el.accessibleName);
    if (classified) {
      matches.push({ elementId: el.id, label: el.accessibleName, polarity: classified.polarity, evidence: classified.evidence });
    }
  }

  const consentContextEvidence = findConsentContextEvidence(observation, candidates);
  const acceptAllCandidate = matches.find((m) => m.polarity === "accept_all");
  const declineCandidate = matches.find((m) => m.polarity === "decline");
  const settingsCandidate = matches.find((m) => m.polarity === "settings");

  const hasGenuineChoiceShape = Boolean(acceptAllCandidate) && Boolean(declineCandidate || settingsCandidate);
  const surfaceDetected = consentContextEvidence.length > 0 && hasGenuineChoiceShape;

  return {
    surfaceDetected,
    consentContextEvidence,
    ...(acceptAllCandidate ? { acceptAllCandidate } : {}),
    ...(declineCandidate ? { declineCandidate } : {}),
    ...(settingsCandidate ? { settingsCandidate } : {}),
  };
}
