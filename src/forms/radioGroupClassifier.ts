import { objectiveRelevanceScore } from "../discovery/relevance.js";
import { keywordsFor } from "./fieldKeywords.js";
import type { FormJourneyContext } from "./formRelevance.js";
import type { SupportedLanguage } from "./testData.js";

/**
 * Three-way radio-group taxonomy (see docs/architecture.md and the task spec this follows):
 * a form's radio groups are never resolved by one uniform rule. "marketing_consent" (stay in
 * touch / personalised offers / partner data sharing) keeps the existing opt-out resolution.
 * "journey_intent" (quote vs. test drive vs. contact vs. brochure) must be matched against the
 * task's own workflow journey input, never defaulted. "customer_qualification" (private vs.
 * business/self-employed/company) always resolves to the private-customer answer, a fixed
 * automation policy independent of any workflow field. "ambiguous" means none of the above
 * matched with enough confidence -- left unresolved, never guessed, by the caller
 * (consentGroups.ts).
 */
export type RadioGroupClassification = "marketing_consent" | "journey_intent" | "customer_qualification" | "ambiguous";

export interface RadioGroupClassificationResult {
  classification: RadioGroupClassification;
  evidence: string;
}

export interface RadioGroupEvidence {
  questionText: string;
  memberLabels: string[];
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function findKeyword(text: string, keywordsByLanguage: Record<SupportedLanguage, string[]>, language: SupportedLanguage): string | undefined {
  const keywords = keywordsByLanguage[language] ?? keywordsByLanguage.en;
  return keywords.find((keyword) => text.includes(normalize(keyword)));
}

function findLabelMatch(
  labels: string[],
  keywordsByLanguage: Record<SupportedLanguage, string[]>,
  language: SupportedLanguage,
): { index: number; keyword: string } | undefined {
  const keywords = keywordsByLanguage[language] ?? keywordsByLanguage.en;
  for (let index = 0; index < labels.length; index += 1) {
    const normalized = normalize(labels[index] ?? "");
    const keyword = keywords.find((k) => normalized.includes(normalize(k)));
    if (keyword) {
      return { index, keyword };
    }
  }
  return undefined;
}

/**
 * Question-level vocabulary that only ever shows up when a site is asking the customer to
 * self-identify as a private individual or a business/professional -- never a brand- or
 * market-specific phrase, the same generic incremental-vocabulary approach as
 * fieldKeywords.ts's own tables.
 */
const CUSTOMER_QUALIFICATION_QUESTION_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["private individual", "private or business", "customer type", "are you a private", "self-employed", "vat number", "business customer"],
  fr: ["particulier ou professionnel", "type de client", "auto-entrepreneur", "numero de tva", "client professionnel"],
  de: ["privatkunde", "geschaftskunde", "kundentyp", "ust-id", "freiberufler", "gewerblich"],
  nl: ["particulier of zakelijk", "klanttype", "btw-nummer", "zelfstandige", "zakelijke klant"],
  it: ["privato o azienda", "tipo di cliente", "partita iva", "libero professionista", "cliente aziendale"],
  es: ["particular o empresa", "tipo de cliente", "numero de iva", "autonomo", "cliente empresa"],
  pl: ["klient prywatny", "klient biznesowy", "nip", "osoba prowadzaca dzialalnosc"],
  pt: ["cliente particular", "cliente empresarial", "numero de iva", "trabalhador independente"],
};

/** Option-label vocabulary for the private-customer answer -- the fixed resolution target for every customer_qualification group. */
const PRIVATE_CUSTOMER_OPTION_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["private individual", "individual", "personal use", "private"],
  fr: ["particulier"],
  de: ["privatperson", "privatkunde", "privat"],
  nl: ["particulier"],
  it: ["privato"],
  es: ["particular"],
  pl: ["osoba prywatna", "prywatny"],
  pt: ["particular"],
};

/** Option-label vocabulary for the business/professional answer -- used only as corroborating classification evidence, never as a resolution target. */
const BUSINESS_CUSTOMER_OPTION_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["business", "professional", "company", "self-employed", "corporate"],
  fr: ["professionnel", "entreprise", "societe", "auto-entrepreneur"],
  de: ["geschaftlich", "firma", "unternehmen", "freiberufler", "gewerblich"],
  nl: ["zakelijk", "bedrijf", "zelfstandige"],
  it: ["azienda", "professionista", "societa"],
  es: ["empresa", "profesional", "autonomo"],
  pl: ["biznesowy", "firma", "dzialalnosc"],
  pt: ["empresa", "profissional", "empresarial"],
};

/**
 * Broader marketing/privacy-consent vocabulary than fieldKeywords.ts's own consentStayInTouch/
 * consentPersonalised/consentPartners tables alone cover -- merged with those three at runtime
 * below so a group matching either source counts as marketing_consent, keeping one vocabulary
 * rather than two divergent ones.
 */
const MARKETING_CONSENT_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["marketing", "personal data", "data protection", "promotional", "privacy policy", "receive offers", "receive communications", "process your data", "gdpr"],
  fr: ["marketing", "donnees personnelles", "protection des donnees", "politique de confidentialite", "rgpd"],
  de: ["marketing", "personenbezogene daten", "datenschutz", "datenschutzerklarung", "dsgvo"],
  nl: ["marketing", "persoonsgegevens", "gegevensbescherming", "privacybeleid", "avg"],
  it: ["marketing", "dati personali", "protezione dei dati", "informativa sulla privacy", "gdpr"],
  es: ["marketing", "datos personales", "proteccion de datos", "politica de privacidad", "rgpd"],
  pl: ["marketing", "dane osobowe", "ochrona danych", "polityka prywatnosci", "rodo"],
  pt: ["marketing", "dados pessoais", "protecao de dados", "politica de privacidade", "rgpd"],
};

function mergedMarketingConsentKeywords(language: SupportedLanguage): string[] {
  return [
    ...(MARKETING_CONSENT_KEYWORDS[language] ?? MARKETING_CONSENT_KEYWORDS.en),
    ...keywordsFor("consentStayInTouch", language),
    ...keywordsFor("consentPersonalised", language),
    ...keywordsFor("consentPartners", language),
  ];
}

type JourneyPurposeCategory = "quote" | "test_drive" | "contact" | "brochure";

/** Same generic per-language journey-purpose vocabulary shape as formRelevance.ts's own POSITIVE_PURPOSE_KEYWORDS, split into distinct categories so option labels can be told apart rather than only recognised as "some purpose". */
const JOURNEY_PURPOSE_KEYWORDS: Record<JourneyPurposeCategory, Record<SupportedLanguage, string[]>> = {
  quote: {
    en: ["quote", "offer", "get a quote", "get an offer", "price", "pricing"],
    fr: ["devis", "offre"],
    de: ["angebot"],
    nl: ["offerte"],
    it: ["preventivo", "offerta"],
    es: ["presupuesto", "oferta"],
    pl: ["oferta"],
    pt: ["orcamento", "oferta"],
  },
  test_drive: {
    en: ["test drive"],
    fr: ["essai", "essayer"],
    de: ["probefahrt"],
    nl: ["proefrit"],
    it: ["prova su strada", "provare"],
    es: ["prueba de conduccion"],
    pl: ["jazda testowa"],
    pt: ["test drive"],
  },
  contact: {
    en: ["contact", "general enquiry", "more information", "enquire"],
    fr: ["contact", "information", "renseignement"],
    de: ["kontakt", "information"],
    nl: ["contact", "informatie"],
    it: ["contatto", "informazioni"],
    es: ["contacto", "informacion"],
    pl: ["kontakt", "informacje"],
    pt: ["contacto", "informacao"],
  },
  brochure: {
    en: ["brochure", "catalogue", "catalog"],
    fr: ["brochure", "catalogue"],
    de: ["broschure", "katalog"],
    nl: ["brochure", "catalogus"],
    it: ["brochure", "catalogo"],
    es: ["folleto", "catalogo"],
    pl: ["broszura", "katalog"],
    pt: ["brochura", "catalogo"],
  },
};

function matchJourneyCategory(label: string, language: SupportedLanguage): JourneyPurposeCategory | undefined {
  const normalized = normalize(label);
  return (Object.keys(JOURNEY_PURPOSE_KEYWORDS) as JourneyPurposeCategory[]).find((category) => {
    const keywords = JOURNEY_PURPOSE_KEYWORDS[category][language] ?? JOURNEY_PURPOSE_KEYWORDS[category].en;
    return keywords.some((keyword) => normalized.includes(normalize(keyword)));
  });
}

/**
 * Classifies one discovered radio group (consentGroups.ts's ConsentGroupDescriptor, reduced to
 * just its text evidence) into the three-way taxonomy. Order matters: customer_qualification is
 * checked first since its vocabulary ("private"/"business") is unambiguous and would never
 * coincidentally match marketing-consent or journey-intent wording; marketing_consent next;
 * journey_intent last, and only once at least two options map to two *different* purpose
 * categories -- a single matched keyword on one option alone is too weak a signal (it could be a
 * single-option disclosure, not a real intent choice) to classify the whole group.
 */
export function classifyRadioGroup(evidence: RadioGroupEvidence, language: SupportedLanguage): RadioGroupClassificationResult {
  const questionText = normalize(evidence.questionText);
  const combinedText = normalize([evidence.questionText, ...evidence.memberLabels].join(" "));

  const qualificationQuestionKeyword = findKeyword(questionText, CUSTOMER_QUALIFICATION_QUESTION_KEYWORDS, language);
  const privateOptionMatch = findLabelMatch(evidence.memberLabels, PRIVATE_CUSTOMER_OPTION_KEYWORDS, language);
  const businessOptionMatch = findLabelMatch(evidence.memberLabels, BUSINESS_CUSTOMER_OPTION_KEYWORDS, language);
  if (qualificationQuestionKeyword) {
    return { classification: "customer_qualification", evidence: `question text matched customer-qualification vocabulary ("${qualificationQuestionKeyword}")` };
  }
  if (privateOptionMatch && businessOptionMatch) {
    return {
      classification: "customer_qualification",
      evidence: `options matched both private ("${privateOptionMatch.keyword}") and business ("${businessOptionMatch.keyword}") customer-type vocabulary`,
    };
  }

  const marketingKeywords: Record<SupportedLanguage, string[]> = { ...MARKETING_CONSENT_KEYWORDS, [language]: mergedMarketingConsentKeywords(language) } as Record<
    SupportedLanguage,
    string[]
  >;
  const marketingKeyword = findKeyword(combinedText, marketingKeywords, language);
  if (marketingKeyword) {
    return { classification: "marketing_consent", evidence: `question/option text matched marketing-consent vocabulary ("${marketingKeyword}")` };
  }

  const categoryMatches = evidence.memberLabels.map((label) => matchJourneyCategory(label, language)).filter((c): c is JourneyPurposeCategory => Boolean(c));
  const distinctCategories = new Set(categoryMatches);
  if (distinctCategories.size >= 2) {
    return {
      classification: "journey_intent",
      evidence: `at least two options matched distinct journey-purpose categories (${[...distinctCategories].join(", ")})`,
    };
  }

  return { classification: "ambiguous", evidence: "no confident classification signal found in question text or option labels" };
}

const JOURNEY_INTENT_MIN_SCORE = 0.2;
const JOURNEY_INTENT_AMBIGUITY_MARGIN = 0.15;

/**
 * Resolves a journey_intent group against the task's own workflow journey input
 * (FormJourneyContext -- objective/active-milestone-texts/previous-CTA label), never a new
 * schema field and never a hardcoded default. Returns undefined (leave unresolved, block
 * submit) whenever no option scores above the confidence floor or the top two options are too
 * close to call -- "ambiguous" radio groups, under this rule's own spec, are never defaulted.
 */
export function resolveJourneyIntentOption(
  memberLabels: string[],
  journeyContext: FormJourneyContext,
  language: SupportedLanguage,
): { index: number; reason: string } | undefined {
  const anchorText = [journeyContext.objective, ...(journeyContext.activeMilestoneTexts ?? []), journeyContext.previousActionLabel]
    .filter((anchor): anchor is string => Boolean(anchor && anchor.trim().length > 0))
    .join(" ");
  if (!anchorText.trim()) {
    return undefined;
  }

  const scored = memberLabels.map((label, index) => {
    const category = matchJourneyCategory(label, language);
    const keywords = category ? (JOURNEY_PURPOSE_KEYWORDS[category][language] ?? JOURNEY_PURPOSE_KEYWORDS[category].en) : [];
    const candidateText = [label, ...keywords].join(" ");
    return { index, label, score: objectiveRelevanceScore(anchorText, candidateText) };
  });

  const ranked = [...scored].sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const runnerUp = ranked[1];
  if (!top || top.score < JOURNEY_INTENT_MIN_SCORE) {
    return undefined;
  }
  if (runnerUp && top.score - runnerUp.score < JOURNEY_INTENT_AMBIGUITY_MARGIN) {
    return undefined;
  }
  return { index: top.index, reason: `matched the task's own journey-intent context against option "${top.label}" (score ${top.score.toFixed(2)})` };
}

/**
 * Resolves a customer_qualification group to its private-customer option -- the fixed
 * automation policy (never the task's own customer-type input, which this category
 * deliberately ignores). Returns undefined (leave unresolved, block submit) when no option
 * confidently matches the private-customer vocabulary at all.
 */
export function resolvePrivateCustomerOption(memberLabels: string[], language: SupportedLanguage): { index: number; reason: string } | undefined {
  const match = findLabelMatch(memberLabels, PRIVATE_CUSTOMER_OPTION_KEYWORDS, language);
  if (!match) {
    return undefined;
  }
  return { index: match.index, reason: `fixed policy: selected the private-customer option (matched "${match.keyword}")` };
}
