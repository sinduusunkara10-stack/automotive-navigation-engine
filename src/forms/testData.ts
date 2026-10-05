import formTestData from "../../config/formTestData.json" with { type: "json" };

export type SupportedMarket = "UK" | "FR" | "DE" | "AT" | "BE" | "LU" | "IT" | "NL" | "PL" | "PT" | "ES";
export type SupportedLanguage = "en" | "fr" | "de" | "nl" | "it" | "es" | "pl" | "pt";

export interface MarketPhoneAndPostcode {
  postcode: string;
  landlineNational: string;
  landlineInternational: string;
  mobileNational: string;
  mobileInternational: string;
}

const MARKET_DATA = formTestData.marketData as Record<SupportedMarket, MarketPhoneAndPostcode>;
const TITLE_BY_LANGUAGE = formTestData.titleByLanguage as Record<SupportedLanguage, string>;

export const SUPPORTED_MARKETS = Object.keys(MARKET_DATA) as SupportedMarket[];
export const SUPPORTED_LANGUAGES = Object.keys(TITLE_BY_LANGUAGE) as SupportedLanguage[];

export const FIXED_FIELDS = formTestData.fixedFields;

export function isSupportedMarket(value: string): value is SupportedMarket {
  return Object.prototype.hasOwnProperty.call(MARKET_DATA, value);
}

export function isSupportedLanguage(value: string): value is SupportedLanguage {
  return Object.prototype.hasOwnProperty.call(TITLE_BY_LANGUAGE, value);
}

export function marketDataFor(market: SupportedMarket): MarketPhoneAndPostcode {
  return MARKET_DATA[market];
}

export function titleFor(language: SupportedLanguage): string {
  return TITLE_BY_LANGUAGE[language];
}

/**
 * Country-code selector presence decides national vs. international format (see
 * docs/architecture.md's lead-form-filling section) -- a page that already exposes one is
 * assumed to want the number typed without the prefix it already renders separately.
 */
const DEFAULT_MARKET_FOR_LANGUAGE: Record<SupportedLanguage, SupportedMarket> = {
  en: "UK",
  fr: "FR",
  de: "DE",
  nl: "NL",
  it: "IT",
  es: "ES",
  pl: "PL",
  pt: "PT",
};

/**
 * A page's declared language alone can't disambiguate markets that share one (DE/AT, FR/BE/LU,
 * NL/BE) -- an explicit market hint (e.g. supplied by the task JSON or inferred upstream from
 * the run's own domain/market context) always wins; the language-keyed default is only a
 * single-market-per-language fallback for when none is supplied.
 */
export function resolveMarket(language: SupportedLanguage, explicitMarket?: string): SupportedMarket {
  if (explicitMarket && isSupportedMarket(explicitMarket)) {
    return explicitMarket;
  }
  return DEFAULT_MARKET_FOR_LANGUAGE[language];
}

export function phoneValueFor(
  market: SupportedMarket,
  kind: "landline" | "mobile",
  hasCountryCodeSelector: boolean,
): string {
  const data = marketDataFor(market);
  if (kind === "landline") {
    return hasCountryCodeSelector ? data.landlineNational : data.landlineInternational;
  }
  return hasCountryCodeSelector ? data.mobileNational : data.mobileInternational;
}
