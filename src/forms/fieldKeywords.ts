import type { SupportedLanguage } from "./testData.js";

export type LeadFormFieldKey =
  | "title"
  | "firstName"
  | "lastName"
  | "email"
  | "landlinePhone"
  | "mobilePhone"
  | "genericPhone"
  | "postcode"
  | "dealerSearch"
  | "consentStayInTouch"
  | "consentPersonalised"
  | "consentPartners";

type KeywordsByLanguage = Record<SupportedLanguage, string[]>;

/**
 * Deterministic, per-language keyword lists used to match a field's label/name/placeholder/
 * autocomplete attribute. Generic vocabulary only (CLAUDE.md non-negotiable design rule) --
 * never a brand- or market-specific phrase.
 */
const KEYWORDS: Record<LeadFormFieldKey, KeywordsByLanguage> = {
  title: {
    en: ["title", "salutation"],
    fr: ["titre", "civilite", "civilité"],
    de: ["anrede", "titel"],
    nl: ["aanhef", "titel"],
    it: ["titolo"],
    es: ["tratamiento", "titulo", "título"],
    pl: ["tytul", "tytuł", "zwrot grzecznosciowy"],
    pt: ["tratamento", "titulo", "título"],
  },
  firstName: {
    en: ["first name", "firstname", "given name", "forename"],
    fr: ["prenom", "prénom"],
    de: ["vorname"],
    nl: ["voornaam"],
    it: ["nome"],
    es: ["nombre"],
    pl: ["imie", "imię"],
    pt: ["nome proprio", "primeiro nome", "nome"],
  },
  lastName: {
    en: ["last name", "lastname", "surname", "family name"],
    fr: ["nom de famille", "nom"],
    de: ["nachname", "familienname"],
    nl: ["achternaam"],
    it: ["cognome"],
    es: ["apellido", "apellidos"],
    pl: ["nazwisko"],
    pt: ["apelido", "sobrenome"],
  },
  email: {
    en: ["email", "e-mail"],
    fr: ["e-mail", "courriel", "adresse email"],
    de: ["e-mail", "email"],
    nl: ["e-mail", "email"],
    it: ["e-mail", "email", "posta elettronica"],
    es: ["correo electronico", "correo electrónico", "e-mail", "email"],
    pl: ["e-mail", "email", "adres e-mail"],
    pt: ["e-mail", "email", "correio eletronico", "correio eletrónico"],
  },
  landlinePhone: {
    en: ["landline", "home phone"],
    fr: ["fixe", "telephone fixe", "téléphone fixe"],
    de: ["festnetz"],
    nl: ["vast nummer", "vaste telefoon"],
    it: ["fisso", "telefono fisso"],
    es: ["fijo", "telefono fijo", "teléfono fijo"],
    pl: ["stacjonarny", "telefon stacjonarny"],
    pt: ["fixo", "telefone fixo"],
  },
  mobilePhone: {
    en: ["mobile", "cell phone", "cellphone"],
    fr: ["portable", "mobile"],
    de: ["handy", "mobil", "mobiltelefon"],
    nl: ["mobiel", "mobiele telefoon"],
    it: ["cellulare", "mobile"],
    es: ["movil", "móvil"],
    pl: ["komorkowy", "komórkowy", "telefon komorkowy"],
    pt: ["telemovel", "telemóvel"],
  },
  genericPhone: {
    en: ["phone", "phone number", "contact number"],
    fr: ["telephone", "téléphone", "numero de telephone"],
    de: ["telefon", "telefonnummer"],
    nl: ["telefoon", "telefoonnummer"],
    it: ["telefono", "numero di telefono"],
    es: ["telefono", "teléfono", "numero de telefono"],
    pl: ["telefon", "numer telefonu"],
    pt: ["telefone", "numero de telefone"],
  },
  postcode: {
    en: ["postcode", "postal code", "zip code", "zip"],
    fr: ["code postal"],
    de: ["postleitzahl", "plz"],
    nl: ["postcode"],
    it: ["cap", "codice postale"],
    es: ["codigo postal", "código postal"],
    pl: ["kod pocztowy"],
    pt: ["codigo postal", "código postal"],
  },
  dealerSearch: {
    en: ["postcode or city", "find a dealer", "find dealer", "dealer search"],
    fr: ["concessionnaire", "trouver un concessionnaire"],
    de: ["handler finden", "händler finden", "handler suchen", "händler suchen"],
    nl: ["dealer zoeken", "zoek een dealer"],
    it: ["trova concessionario", "cerca concessionario"],
    es: ["buscar concesionario", "encontrar concesionario"],
    pl: ["znajdz dealera", "znajdź dealera"],
    pt: ["encontrar concessionario", "encontrar concessionário"],
  },
  consentStayInTouch: {
    en: ["stay in touch", "keep me updated", "keep in touch"],
    fr: ["rester en contact", "me tenir informe", "me tenir informé"],
    de: ["in kontakt bleiben", "auf dem laufenden halten"],
    nl: ["op de hoogte houden", "in contact blijven"],
    it: ["restare in contatto", "tenermi aggiornato"],
    es: ["mantenerme informado", "seguir en contacto"],
    pl: ["bycie w kontakcie", "informuj mnie na biezaco", "informuj mnie na bieżąco"],
    pt: ["manter contacto", "manter-me informado"],
  },
  consentPersonalised: {
    en: ["personalised", "personalized", "tailored offers"],
    fr: ["personnalise", "personnalisé", "offres personnalisees", "offres personnalisées"],
    de: ["personalisiert", "individuelle angebote"],
    nl: ["gepersonaliseerd", "persoonlijke aanbiedingen"],
    it: ["personalizzato", "offerte personalizzate"],
    es: ["personalizado", "ofertas personalizadas"],
    pl: ["spersonalizowane", "oferty spersonalizowane"],
    pt: ["personalizado", "ofertas personalizadas"],
  },
  consentPartners: {
    en: ["partners", "third parties", "third-party"],
    fr: ["partenaires", "tiers"],
    de: ["partner", "dritte"],
    nl: ["partners", "derden"],
    it: ["partner", "terze parti"],
    es: ["socios", "terceros"],
    pl: ["partnerzy", "strony trzecie"],
    pt: ["parceiros", "terceiros"],
  },
};

export function keywordsFor(field: LeadFormFieldKey, language: SupportedLanguage): string[] {
  return KEYWORDS[field][language] ?? KEYWORDS[field].en;
}

export function allKeywordLanguages(): SupportedLanguage[] {
  return ["en", "fr", "de", "nl", "it", "es", "pl", "pt"];
}

export const LEAD_FORM_FIELD_KEYS: LeadFormFieldKey[] = [
  "title",
  "firstName",
  "lastName",
  "email",
  "landlinePhone",
  "mobilePhone",
  "genericPhone",
  "postcode",
  "dealerSearch",
  "consentStayInTouch",
  "consentPersonalised",
  "consentPartners",
];
