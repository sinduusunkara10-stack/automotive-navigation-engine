import type { InteractiveElement, Observation } from "../types/task-response.js";

/**
 * Deterministic, engine-side consent-control assessment (see CLAUDE.md and
 * docs/architecture.md "Consent behaviour" / "Consent behaviour -- multilingual"):
 * independently verifies a consent surface and its candidate controls from the same generic
 * DOM evidence already carried on Observation/InteractiveElement (accessibleName, role,
 * ariaState, pageLanguage) -- never trusting only the reasoning layer's own self-reported
 * ConsentControlIntent (types/consentControl.ts), which src/safety/consentPolicyGuard.ts's
 * isConsentIntentCompliant purely reacts to after the fact. This module never inspects raw
 * HTML, a vendor/CMP-specific selector, or a brand-specific string; it works from known,
 * generic semantic patterns (positive vs negative consent wording, a settings/preferences
 * pattern, and a small set of consent-context tokens used only to confirm a surface is
 * genuinely about cookies/consent/tracking/privacy before trusting any wording match at
 * all) -- the same category of evidence the task description asks for: surface structure,
 * visible text, accessible name, role, button relationships within the same surface, and
 * page language.
 *
 * Deliberately conservative: a lone button whose label happens to contain a short token
 * like "accept" is never enough on its own -- surfaceDetected only becomes true once (a)
 * the page shows independent, generic evidence it is genuinely about
 * cookies/consent/privacy/tracking (consentContextEvidence), and (b) at least one
 * accept-shaped control coexists with at least one decline- or settings-shaped control,
 * the structural shape of a real consent choice rather than an unrelated single button.
 *
 * Multilingual by construction (corrective pass): wording evidence is drawn from a small,
 * independent, appendable table of per-language token sets (CONSENT_LANGUAGES below) --
 * English, French, German, Spanish, Italian, and Dutch today -- checked together, in a
 * fixed order, so an existing English-only page's own classification and evidence text are
 * completely unchanged by this extension. Adding a further language is a config-only change
 * (one more CONSENT_LANGUAGES entry): it never touches the classification/assessment logic
 * itself, and this module never claims to support "any language" from that table alone --
 * see assessConsentSurface's own `languageAmbiguous` result and
 * resolveAmbiguousConsentSurface below for the bounded, independently-verified fallback a
 * caller may use when a page's wording matches none of the configured languages.
 */

export type ConsentControlPolarity = "accept_all" | "decline" | "settings";

export interface ConsentControlMatch {
  elementId: string;
  label: string;
  polarity: ConsentControlPolarity;
  evidence: string;
  /** ISO-639-1-ish code of whichever configured language's wording matched (e.g. "en", "fr"), when classified by wording. */
  language?: string;
}

export interface ConsentSurfaceAssessment {
  surfaceDetected: boolean;
  consentContextEvidence: string[];
  acceptAllCandidate?: ConsentControlMatch;
  declineCandidate?: ConsentControlMatch;
  settingsCandidate?: ConsentControlMatch;
  /**
   * True when this observation shows independent evidence of a genuine consent surface
   * (consentContextEvidence is non-empty) but the deterministic, configured-language wording
   * table could not resolve a confident accept/decline-or-settings choice shape from it --
   * e.g. the page's own wording (and declared pageLanguage, when present) matches none of
   * CONSENT_LANGUAGES. Exposed so a caller can choose to invoke bounded, independently
   * verified model assistance (resolveAmbiguousConsentSurface) rather than either guessing
   * blindly or silently doing nothing. Always false when surfaceDetected is true.
   */
  languageAmbiguous: boolean;
  /** Observation.pageLanguage, carried through for diagnostics -- see that field's own doc comment. */
  pageLanguage?: string;
}

interface ConsentLanguageTokens {
  code: string;
  acceptAllPhrases: string[];
  acceptAllWords: string[];
  declinePhrases: string[];
  declineWords: string[];
  settingsPhrases: string[];
  settingsWords: string[];
  contextTokens: string[];
}

// Longer, higher-specificity phrases are checked before any single-word fallback, across
// every configured language, so "accept all"/"tout accepter" outranks a bare
// "accept"/"accepter" match with its own, more specific evidence string; order *within* a
// tier does not matter, only tier order does. English is listed first and checked first in
// every tier, so an existing English-only page's classification/evidence text is completely
// unchanged by the languages added alongside it.
const CONSENT_LANGUAGES: ConsentLanguageTokens[] = [
  {
    code: "en",
    acceptAllPhrases: [
      "accept all cookies",
      "accept all",
      "allow all cookies",
      "allow all",
      "continue with all",
      "agree to all",
      "i agree",
      "agree and continue",
    ],
    acceptAllWords: ["accept", "allow", "agree"],
    declinePhrases: [
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
    ],
    declineWords: ["reject", "decline", "disagree"],
    settingsPhrases: [
      "cookie settings",
      "manage preferences",
      "manage cookies",
      "cookie preferences",
      "privacy settings",
      "customize cookies",
      "customise cookies",
      "more options",
    ],
    settingsWords: ["preferences", "settings", "customize", "customise"],
    contextTokens: ["cookie", "cookies", "consent", "privacy", "tracking", "gdpr", "data protection", "personal data"],
  },
  {
    code: "fr",
    acceptAllPhrases: ["tout accepter", "accepter tout", "accepter tous les cookies", "j'accepte", "je suis d'accord"],
    acceptAllWords: ["accepter", "autoriser"],
    declinePhrases: [
      "tout refuser",
      "refuser tout",
      "refuser les cookies",
      "continuer sans accepter",
      "nécessaire uniquement",
      "essentiel uniquement",
    ],
    declineWords: ["refuser", "rejeter"],
    settingsPhrases: ["gérer les préférences", "paramètres des cookies", "personnaliser les cookies", "préférences de cookies"],
    settingsWords: ["préférences", "paramètres", "personnaliser"],
    contextTokens: ["cookie", "cookies", "consentement", "confidentialité", "vie privée", "rgpd", "données personnelles"],
  },
  {
    code: "de",
    acceptAllPhrases: ["alle akzeptieren", "alle cookies akzeptieren", "alle zulassen", "ich stimme zu"],
    acceptAllWords: ["akzeptieren", "zulassen", "zustimmen"],
    declinePhrases: ["alle ablehnen", "cookies ablehnen", "nur notwendige", "nur erforderliche", "fortfahren ohne zu akzeptieren"],
    declineWords: ["ablehnen"],
    settingsPhrases: ["cookie-einstellungen", "einstellungen verwalten", "präferenzen verwalten", "cookies anpassen"],
    settingsWords: ["einstellungen", "präferenzen", "anpassen"],
    contextTokens: ["cookie", "cookies", "einwilligung", "datenschutz", "dsgvo", "personenbezogene daten"],
  },
  {
    code: "es",
    acceptAllPhrases: ["aceptar todo", "aceptar todas las cookies", "permitir todo", "estoy de acuerdo"],
    acceptAllWords: ["aceptar", "permitir"],
    declinePhrases: ["rechazar todo", "rechazar todas las cookies", "solo necesarias", "solo esenciales", "continuar sin aceptar"],
    declineWords: ["rechazar"],
    settingsPhrases: ["configuración de cookies", "gestionar preferencias", "personalizar cookies", "preferencias de cookies"],
    settingsWords: ["preferencias", "configuración", "personalizar"],
    contextTokens: ["cookie", "cookies", "consentimiento", "privacidad", "rgpd", "datos personales"],
  },
  {
    code: "it",
    acceptAllPhrases: ["accetta tutto", "accetta tutti i cookie", "consenti tutto", "sono d'accordo"],
    acceptAllWords: ["accetta", "consenti"],
    declinePhrases: ["rifiuta tutto", "rifiuta tutti i cookie", "solo necessari", "solo essenziali", "continua senza accettare"],
    declineWords: ["rifiuta"],
    settingsPhrases: ["impostazioni cookie", "gestisci preferenze", "personalizza cookie", "preferenze cookie"],
    settingsWords: ["preferenze", "impostazioni", "personalizza"],
    contextTokens: ["cookie", "cookie", "consenso", "privacy", "gdpr", "dati personali"],
  },
  {
    code: "nl",
    acceptAllPhrases: ["alles accepteren", "alle cookies accepteren", "alles toestaan", "ik ga akkoord"],
    acceptAllWords: ["accepteren", "toestaan", "akkoord"],
    declinePhrases: ["alles weigeren", "cookies weigeren", "alleen noodzakelijke", "alleen essentiële", "doorgaan zonder te accepteren"],
    declineWords: ["weigeren"],
    settingsPhrases: ["cookie-instellingen", "voorkeuren beheren", "cookies aanpassen", "cookievoorkeuren"],
    settingsWords: ["voorkeuren", "instellingen", "aanpassen"],
    contextTokens: ["cookie", "cookies", "toestemming", "privacy", "avg", "persoonsgegevens"],
  },
];

function normalize(text: string): string {
  return text.toLowerCase().trim();
}

function matchesAny(text: string, phrases: readonly string[]): string | undefined {
  return phrases.find((phrase) => text.includes(phrase));
}

function findAcrossLanguages(
  text: string,
  pick: (lang: ConsentLanguageTokens) => readonly string[],
): { phrase: string; language: string } | undefined {
  for (const lang of CONSENT_LANGUAGES) {
    const match = matchesAny(text, pick(lang));
    if (match) {
      return { phrase: match, language: lang.code };
    }
  }
  return undefined;
}

/**
 * Classifies one already-observed interactive element's consent polarity from its own
 * accessibleName alone -- generic text-pattern matching across every configured language
 * (CONSENT_LANGUAGES), never a selector or vendor attribute. Phrase-level matches (in any
 * configured language) are preferred over single-word matches; within a tier, languages are
 * checked in table order (English first), so an all-English page's classification is
 * unaffected by the other languages configured alongside it.
 */
export function classifyConsentControlPolarity(
  accessibleName: string,
): { polarity: ConsentControlPolarity; evidence: string; language: string } | undefined {
  const text = normalize(accessibleName);
  if (!text) {
    return undefined;
  }

  const acceptPhrase = findAcrossLanguages(text, (l) => l.acceptAllPhrases);
  if (acceptPhrase) {
    return {
      polarity: "accept_all",
      evidence: `label matched accept-all phrase "${acceptPhrase.phrase}" (${acceptPhrase.language})`,
      language: acceptPhrase.language,
    };
  }
  const declinePhrase = findAcrossLanguages(text, (l) => l.declinePhrases);
  if (declinePhrase) {
    return {
      polarity: "decline",
      evidence: `label matched decline phrase "${declinePhrase.phrase}" (${declinePhrase.language})`,
      language: declinePhrase.language,
    };
  }
  const settingsPhrase = findAcrossLanguages(text, (l) => l.settingsPhrases);
  if (settingsPhrase) {
    return {
      polarity: "settings",
      evidence: `label matched settings phrase "${settingsPhrase.phrase}" (${settingsPhrase.language})`,
      language: settingsPhrase.language,
    };
  }

  const acceptWord = findAcrossLanguages(text, (l) => l.acceptAllWords);
  if (acceptWord) {
    return {
      polarity: "accept_all",
      evidence: `label matched accept word "${acceptWord.phrase}" (${acceptWord.language})`,
      language: acceptWord.language,
    };
  }
  const declineWord = findAcrossLanguages(text, (l) => l.declineWords);
  if (declineWord) {
    return {
      polarity: "decline",
      evidence: `label matched decline word "${declineWord.phrase}" (${declineWord.language})`,
      language: declineWord.language,
    };
  }
  const settingsWord = findAcrossLanguages(text, (l) => l.settingsWords);
  if (settingsWord) {
    return {
      polarity: "settings",
      evidence: `label matched settings word "${settingsWord.phrase}" (${settingsWord.language})`,
      language: settingsWord.language,
    };
  }
  return undefined;
}

/**
 * Independent, generic evidence that the *page* (not just one button) is genuinely about
 * cookies/consent/privacy/tracking right now -- drawn only from already-captured,
 * already-generic Observation fields (notableText headings, and the candidate elements'
 * own accessible names), checked against every configured language's context tokens,
 * never a second DOM scan. Required before any button-label match is trusted at all (see
 * this module's own doc comment on why a lone "accept"-shaped label is not sufficient by
 * itself).
 */
function findConsentContextEvidence(observation: Observation, candidates: readonly InteractiveElement[]): string[] {
  const evidence: string[] = [];
  const allContextTokens = CONSENT_LANGUAGES.flatMap((l) => l.contextTokens);
  for (const heading of observation.notableText ?? []) {
    const text = normalize(heading);
    const token = allContextTokens.find((t) => text.includes(t));
    if (token) {
      evidence.push(`heading text matched consent-context token "${token}"`);
    }
  }
  for (const el of candidates) {
    const text = normalize(el.accessibleName);
    const token = allContextTokens.find((t) => text.includes(t));
    if (token) {
      evidence.push(`control "${el.accessibleName}" matched consent-context token "${token}"`);
    }
  }
  return evidence;
}

/**
 * Assesses whether a genuine consent surface with real accept/decline/settings choices is
 * currently visible, from the current Observation alone. See this module's own doc comment
 * for the conservative surfaceDetected gate and for the multilingual wording table. When
 * consentContextEvidence shows the page is genuinely about consent but no configured
 * language's wording resolves a confident choice shape, `languageAmbiguous` is set instead
 * of silently reporting "no surface" -- see resolveAmbiguousConsentSurface below for the
 * bounded, independently-verified fallback for that case.
 */
export function assessConsentSurface(observation: Observation): ConsentSurfaceAssessment {
  const candidates = observation.interactiveElements.filter(
    (el) => el.visible !== false && !el.disabled,
  );

  const matches: ConsentControlMatch[] = [];
  for (const el of candidates) {
    const classified = classifyConsentControlPolarity(el.accessibleName);
    if (classified) {
      matches.push({
        elementId: el.id,
        label: el.accessibleName,
        polarity: classified.polarity,
        evidence: classified.evidence,
        language: classified.language,
      });
    }
  }

  const consentContextEvidence = findConsentContextEvidence(observation, candidates);
  const acceptAllCandidate = matches.find((m) => m.polarity === "accept_all");
  const declineCandidate = matches.find((m) => m.polarity === "decline");
  const settingsCandidate = matches.find((m) => m.polarity === "settings");

  const hasGenuineChoiceShape = Boolean(acceptAllCandidate) && Boolean(declineCandidate || settingsCandidate);
  const surfaceDetected = consentContextEvidence.length > 0 && hasGenuineChoiceShape;
  const languageAmbiguous = !surfaceDetected && consentContextEvidence.length > 0 && !hasGenuineChoiceShape;

  return {
    surfaceDetected,
    consentContextEvidence,
    ...(acceptAllCandidate ? { acceptAllCandidate } : {}),
    ...(declineCandidate ? { declineCandidate } : {}),
    ...(settingsCandidate ? { settingsCandidate } : {}),
    languageAmbiguous,
    ...(observation.pageLanguage ? { pageLanguage: observation.pageLanguage } : {}),
  };
}

/**
 * Bounded, generic evidence handed to an optional model-assist resolver (see
 * ConsentAmbiguityResolver below) when assessConsentSurface's own configured-language
 * wording table could not resolve a confident choice shape -- the complete visible consent
 * surface's own candidate controls (role+accessibleName only, the same generic evidence
 * every other candidate identity in this codebase already uses), plus the deterministic
 * context evidence and page language already gathered. Never raw HTML, never a full page
 * dump.
 */
export interface ConsentAmbiguityContext {
  consentContextEvidence: string[];
  pageLanguage?: string;
  candidates: { elementId: string; role: string; label: string }[];
}

export interface ConsentAmbiguityResolution {
  /** The candidate elementId the resolver judged to be the accept-all-equivalent control, when it found one. */
  acceptAllElementId?: string;
  rationale: string;
  confidence: number;
}

/**
 * Optional, generic model-assist hook for the ambiguous case only (see
 * ConsentSurfaceAssessment.languageAmbiguous) -- structurally the same optional-callback
 * shape reasoning/semanticCriterionVerifier.ts's SemanticCriterionVerifier already
 * establishes for this codebase's other bounded, structured-output model consultations:
 * never a navigation decision, never given allowedActions/allowedDomains/limits, and
 * cannot itself move the run. See resolveAmbiguousConsentSurface below for the independent
 * verification every resolution is still put through before the engine ever acts on it.
 */
export interface ConsentAmbiguityResolver {
  resolve(context: ConsentAmbiguityContext): Promise<ConsentAmbiguityResolution>;
}

// Conservative bar matching this codebase's existing semantic-verification convention (see
// DEFAULT_SEMANTIC_MIN_CONFIDENCE, reasoning/semanticCriterionVerifier.ts) -- a low-confidence
// resolution must never be trusted to proactively click anything.
const MIN_AMBIGUITY_RESOLUTION_CONFIDENCE = 0.7;

/**
 * Bounded model-assisted interpretation for a consent surface whose wording matched none of
 * assessConsentSurface's configured languages (docs/architecture.md "Consent behaviour --
 * unsupported/ambiguous languages"): never invoked when a language was already resolved
 * deterministically (`deterministic.languageAmbiguous` false), and never invoked with no
 * consent-context evidence at all (nothing suggesting this is a consent surface to begin
 * with). The resolver is given only the bounded, generic candidate list already computed --
 * never asked to invent a target -- and its answer is independently verified against that
 * exact same list before being trusted: a resolution naming an elementId that was not
 * actually among the observed candidates, or falling below the confidence bar, resolves to
 * undefined (fail closed, exactly like every other confidence gate in this codebase). Every
 * existing safety restriction (consentInteractionPolicy, allowed-domain enforcement, no
 * payment/personal-data entry) remains fully in force regardless of this function's result --
 * it only ever proposes *which* control is the accept-all-equivalent one, never whether to
 * click it at all.
 */
export async function resolveAmbiguousConsentSurface(
  observation: Observation,
  deterministic: ConsentSurfaceAssessment,
  resolver: ConsentAmbiguityResolver,
): Promise<ConsentControlMatch | undefined> {
  if (!deterministic.languageAmbiguous) {
    return undefined;
  }
  const candidates = observation.interactiveElements
    .filter((el) => el.visible !== false && !el.disabled)
    .map((el) => ({ elementId: el.id, role: el.role, label: el.accessibleName }));
  if (candidates.length === 0) {
    return undefined;
  }

  let resolution: ConsentAmbiguityResolution;
  try {
    resolution = await resolver.resolve({
      consentContextEvidence: deterministic.consentContextEvidence,
      ...(deterministic.pageLanguage ? { pageLanguage: deterministic.pageLanguage } : {}),
      candidates,
    });
  } catch {
    return undefined;
  }

  if (
    !resolution.acceptAllElementId ||
    resolution.confidence < MIN_AMBIGUITY_RESOLUTION_CONFIDENCE ||
    resolution.rationale.trim().length === 0
  ) {
    return undefined;
  }

  // Independent verification: the resolution must name a control that genuinely belongs to
  // the exact candidate set just offered -- never trusted blindly (see this function's own
  // doc comment).
  const matched = candidates.find((c) => c.elementId === resolution.acceptAllElementId);
  if (!matched) {
    return undefined;
  }

  return {
    elementId: matched.elementId,
    label: matched.label,
    polarity: "accept_all",
    evidence: `bounded model-assisted interpretation (independently verified against the observed surface): ${resolution.rationale}`,
  };
}
