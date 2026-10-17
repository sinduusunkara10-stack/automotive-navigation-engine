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
export type RadioGroupClassification = "marketing_consent" | "required_consent" | "journey_intent" | "customer_qualification" | "ambiguous";

/**
 * Finer consent-purpose taxonomy. Optional commercial purposes (marketing, profiling, third-party
 * sharing) are always declined; required processing and terms are accepted only when the form
 * marks them necessary for the requested submission; anything else is left untouched.
 */
export type ConsentPurpose =
  | "required_privacy_processing"
  | "terms_and_conditions"
  | "optional_marketing"
  | "optional_profiling"
  | "optional_third_party"
  | "customer_qualification"
  | "journey_intent"
  | "ambiguous";

export interface RadioGroupClassificationResult {
  classification: RadioGroupClassification;
  purpose: ConsentPurpose;
  evidence: string;
}

export interface RadioGroupEvidence {
  questionText: string;
  memberLabels: string[];
  /** The group's own name/id attribute: only identifier tokens are read from it, as corroborating evidence when no question text is associated. */
  groupName?: string;
}

type ConsentPurposeVocabulary = { text: string[]; nameTokens: string[] };

/**
 * Language-neutral by design: every language's phrases are matched regardless of the detected page
 * language, so a mislabelled or mixed-language page still classifies. Name tokens are generic
 * identifier stems and abbreviations, never a site's own field names.
 */
const CONSENT_PURPOSE_VOCABULARY: Record<"terms_and_conditions" | "optional_third_party" | "optional_profiling" | "optional_marketing" | "required_privacy_processing", ConsentPurposeVocabulary> = {
  terms_and_conditions: {
    text: [
      "terms and conditions", "terms of use", "terms of service", "conditions generales", "conditions d'utilisation", "cgu", "cgv",
      "allgemeinen geschaftsbedingungen", "nutzungsbedingungen", "agb", "algemene voorwaarden", "gebruiksvoorwaarden",
      "termini e condizioni", "condizioni generali", "terminos y condiciones", "condiciones generales", "regulamin", "termos e condicoes",
    ],
    nameTokens: ["terms", "tos", "cgu", "cgv", "agb", "tnc", "conditions"],
  },
  optional_third_party: {
    text: [
      "third part", "partners", "partner companies", "partenaires", "tiers", "dritte", "partnerunternehmen", "partnern", "derden", "partners van",
      "terzi", "partner commerciali", "terceros", "socios", "partnerzy", "podmiot", "terceiros", "parceiros",
    ],
    nameTokens: ["thirdparty", "third", "partner", "partners", "tiers", "thirdparties", "3rdparty", "dritte", "terzi", "terceros"],
  },
  optional_profiling: {
    text: [
      "profiling", "personalised", "personalized", "tailored to", "your interests", "profilage", "personnalise", "profilierung", "personalisiert",
      "profilering", "gepersonaliseerd", "profilazione", "personalizzat", "perfilado", "personalizad", "profilowanie", "spersonalizowan", "perfil",
    ],
    nameTokens: ["prfl", "profil", "profile", "profiling", "personalisation", "personalization", "perso", "personalised", "personalized", "profilage"],
  },
  optional_marketing: {
    text: [
      "marketing", "newsletter", "promotional", "special offers", "receive offers", "receive communications", "commercial communications", "stay in touch", "news and offers",
      "offres", "communications commerciales", "prospection", "actualites", "werbung", "angebote", "werbliche", "aanbiedingen", "nieuwsbrief",
      "offerte commerciali", "comunicazioni commerciali", "ofertas", "comunicaciones comerciales", "oferty", "informacje handlowe", "comunicacoes comerciais",
    ],
    nameTokens: ["marketing", "mkt", "mrkt", "mktg", "newsletter", "promo", "promotional", "commercial", "offers", "optin", "advertising", "prospection"],
  },
  required_privacy_processing: {
    text: [
      "process my request", "process your request", "handle my request", "processing of my request", "necessary to process", "privacy policy", "privacy notice", "i have read",
      "traitement de ma demande", "traiter ma demande", "politique de confidentialite", "j'ai lu", "j'ai pris connaissance",
      "bearbeitung meiner anfrage", "datenschutzerklarung", "datenschutzhinweise", "ich habe gelesen",
      "verwerking van mijn aanvraag", "privacyverklaring", "privacybeleid", "ik heb gelezen",
      "gestione della mia richiesta", "informativa sulla privacy", "ho letto",
      "tramitar mi solicitud", "gestionar mi solicitud", "politica de privacidad", "he leido",
      "realizacji zapytania", "polityka prywatnosci", "zapoznalem", "processar o meu pedido", "politica de privacidade", "li e aceito",
    ],
    nameTokens: [],
  },
};

function identifierTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function matchPurposeText(text: string, purpose: keyof typeof CONSENT_PURPOSE_VOCABULARY): string | undefined {
  return CONSENT_PURPOSE_VOCABULARY[purpose].text.find((phrase) => {
    const needle = normalize(phrase);
    // Phrases match from a word start ("tiers" never inside "entiers"); short abbreviations only as whole words.
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z])${escaped}${needle.length <= 4 ? "([^a-z]|$)" : ""}`).test(text);
  });
}

/**
 * Consent-purpose classification from question text, option labels and the group's own name
 * tokens. Optional commercial purposes outrank the generic required-processing vocabulary
 * (a "privacy" prefix on a marketing flag is still a marketing flag), but a text that bundles a
 * required acknowledgement with an optional commercial purpose is ambiguous: accepting it would
 * opt into the commercial purpose, declining it might block the request.
 */
export function classifyConsentPurpose(evidence: RadioGroupEvidence): { purpose: ConsentPurpose; evidence: string } | undefined {
  const text = normalize([evidence.questionText, ...evidence.memberLabels].join(" "));
  const nameTokens = identifierTokens(evidence.groupName);
  const optionalOrder = ["optional_third_party", "optional_profiling", "optional_marketing"] as const;
  const requiredOrder = ["terms_and_conditions", "required_privacy_processing"] as const;

  const textOptional = optionalOrder.map((p) => ({ p, hit: matchPurposeText(text, p) })).filter((x) => x.hit);
  const textRequired = requiredOrder.map((p) => ({ p, hit: matchPurposeText(text, p) })).filter((x) => x.hit);
  const nameOptional = optionalOrder.map((p) => ({ p, hit: CONSENT_PURPOSE_VOCABULARY[p].nameTokens.find((t) => nameTokens.includes(t)) })).filter((x) => x.hit);
  const nameRequired = requiredOrder.map((p) => ({ p, hit: CONSENT_PURPOSE_VOCABULARY[p].nameTokens.find((t) => nameTokens.includes(t)) })).filter((x) => x.hit);

  const optional = textOptional.length > 0 ? textOptional : nameOptional;
  const required = textRequired.length > 0 ? textRequired : nameRequired;
  const source = (list: { p: ConsentPurpose; hit?: string }[], fromText: boolean): string => list.map((x) => `${x.p}:${fromText ? "text" : "name_token"}("${x.hit}")`).join("+");

  if (optional.length > 0 && required.length > 0 && textOptional.length > 0 && textRequired.length > 0) {
    return { purpose: "ambiguous", evidence: `bundled required and optional purposes: ${source(textRequired, true)}+${source(textOptional, true)}` };
  }
  if (optional.length > 0) {
    return { purpose: optional[0]!.p, evidence: source(optional, textOptional.length > 0) };
  }
  if (required.length > 0) {
    return { purpose: required[0]!.p, evidence: source(required, textRequired.length > 0) };
  }
  return undefined;
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
    return { classification: "customer_qualification", purpose: "customer_qualification", evidence: `question text matched customer-qualification vocabulary ("${qualificationQuestionKeyword}")` };
  }
  if (privateOptionMatch && businessOptionMatch) {
    return {
      classification: "customer_qualification",
      purpose: "customer_qualification",
      evidence: `options matched both private ("${privateOptionMatch.keyword}") and business ("${businessOptionMatch.keyword}") customer-type vocabulary`,
    };
  }

  const consentPurpose = classifyConsentPurpose(evidence);
  if (consentPurpose) {
    const classification: RadioGroupClassification =
      consentPurpose.purpose === "ambiguous"
        ? "ambiguous"
        : consentPurpose.purpose === "terms_and_conditions" || consentPurpose.purpose === "required_privacy_processing"
          ? "required_consent"
          : "marketing_consent";
    return { classification, purpose: consentPurpose.purpose, evidence: consentPurpose.evidence };
  }

  const marketingKeywords: Record<SupportedLanguage, string[]> = { ...MARKETING_CONSENT_KEYWORDS, [language]: mergedMarketingConsentKeywords(language) } as Record<
    SupportedLanguage,
    string[]
  >;
  const marketingKeyword = findKeyword(combinedText, marketingKeywords, language);
  if (marketingKeyword) {
    return { classification: "marketing_consent", purpose: "optional_marketing", evidence: `question/option text matched marketing-consent vocabulary ("${marketingKeyword}")` };
  }

  const categoryMatches = evidence.memberLabels.map((label) => matchJourneyCategory(label, language)).filter((c): c is JourneyPurposeCategory => Boolean(c));
  const distinctCategories = new Set(categoryMatches);
  if (distinctCategories.size >= 2) {
    return {
      classification: "journey_intent",
      purpose: "journey_intent",
      evidence: `at least two options matched distinct journey-purpose categories (${[...distinctCategories].join(", ")})`,
    };
  }

  return { classification: "ambiguous", purpose: "ambiguous", evidence: "no confident classification signal found in question text, option labels or group name tokens" };
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
