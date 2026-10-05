import { objectiveTokenCoverage, tokenize } from "../discovery/relevance.js";
import type { SupportedLanguage } from "./testData.js";

/**
 * Generic, multi-form selection scoring (see docs/architecture.md "Lead-form filling: form
 * selection"). None of this is brand-specific: the purpose keyword lists are the same
 * kind of generic, per-language vocabulary src/forms/fieldKeywords.ts already uses, and the
 * journey-relevance scoring reuses this engine's existing token-overlap primitives
 * (src/discovery/relevance.ts, the same ones src/core/semanticPageMatch.ts and
 * src/core/surfaceRelevance.ts already score pages/surfaces with).
 */

function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Generic vocabulary for "this form is the journey's lead-capture form" -- request a quote/offer, test drive, contact, dealer enquiry. Not exhaustive by design (same incremental-vocabulary approach as fieldKeywords.ts). */
const POSITIVE_PURPOSE_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["request a quote", "request an offer", "get a quote", "get an offer", "test drive", "book a test drive", "contact us", "contact a dealer", "dealer enquiry", "enquiry", "enquire"],
  fr: ["demande de devis", "demander un devis", "devis", "essai", "essayer", "contactez-nous", "contacter un concessionnaire", "demande de contact"],
  de: ["angebot anfordern", "angebot", "probefahrt", "kontaktieren sie uns", "handler kontaktieren", "handler finden", "anfrage"],
  nl: ["offerte aanvragen", "offerte", "proefrit", "neem contact op", "dealer contacteren", "aanvraag"],
  it: ["richiedi un preventivo", "preventivo", "prova su strada", "contattaci", "contatta un concessionario", "richiesta"],
  es: ["solicitar presupuesto", "presupuesto", "prueba de conduccion", "contactanos", "contactar concesionario", "solicitud"],
  pl: ["popros o oferte", "oferta", "jazda testowa", "skontaktuj sie z nami", "zapytanie"],
  pt: ["pedir orcamento", "orcamento", "test drive", "contacte-nos", "contactar concessionario", "pedido"],
};

/** Generic vocabulary for a form that is clearly *not* the journey's lead-capture form. */
const NEGATIVE_PURPOSE_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["newsletter", "subscribe", "search", "sign in", "log in", "login"],
  fr: ["newsletter", "abonnez-vous", "recherche", "connexion", "se connecter"],
  de: ["newsletter", "abonnieren", "suche", "anmelden", "einloggen"],
  nl: ["nieuwsbrief", "abonneren", "zoeken", "inloggen"],
  it: ["newsletter", "abbonati", "cerca", "accedi"],
  es: ["newsletter", "suscribete", "buscar", "iniciar sesion"],
  pl: ["newsletter", "zapisz sie", "szukaj", "zaloguj sie"],
  pt: ["newsletter", "inscreva-se", "pesquisar", "iniciar sessao"],
};

function matchesAny(normalizedText: string, keywordsByLanguage: Record<SupportedLanguage, string[]>): boolean {
  return (Object.keys(keywordsByLanguage) as SupportedLanguage[]).some((language) =>
    keywordsByLanguage[language].some((keyword) => normalizedText.includes(normalize(keyword))),
  );
}

/** What a form's journey relevance is actually compared against -- never a URL pattern or brand name, only the objective/milestone wording the task itself supplied, plus (when available) the accessible name of the CTA that led here. */
export interface FormJourneyContext {
  objective?: string;
  /** Descriptions of the currently-unsatisfied required success criteria/milestones -- see core/successEvaluator.ts's getMissingRequiredCriteriaIds. */
  activeMilestoneTexts?: string[];
  /** The previous step's clicked control's own accessible name, when the previous action was a click -- see RunState.lastClickLabel. */
  previousActionLabel?: string;
}

/** Text evidence read off a single candidate form and the page around it -- destination/page title, headings, the form's own heading/attributes, and its submit control's text. */
export interface FormTextSignals {
  pageTitle: string;
  pageHeadings: string[];
  nearestHeadingText: string;
  submitButtonText: string;
  formAttributesText: string;
}

/**
 * Text used for journey-relevance anchor matching against the objective/milestones/previous
 * CTA. Deliberately excludes pageHeadings (every heading anywhere on the page): when several
 * candidate forms share one page, each heading usually belongs to one specific form, and
 * crediting every candidate with every heading on the page would let one form's heading
 * inflate or veto an unrelated form's score. nearestHeadingText already carries "this
 * candidate's own main heading" per-candidate; pageTitle is kept since it is genuinely
 * page-wide and the caller's spec explicitly names it as a relevance signal.
 */
function combinedFormText(signals: FormTextSignals): string {
  return [signals.nearestHeadingText, signals.submitButtonText, signals.formAttributesText, signals.pageTitle].filter(Boolean).join(" ");
}

/**
 * The form's own local text only -- never the page-wide title/headings, which are shared
 * across every candidate form on the page and would otherwise let one form's purpose
 * vocabulary (e.g. a "Newsletter" heading elsewhere on the page) veto or bonus a completely
 * unrelated form's score.
 */
function localFormText(signals: FormTextSignals): string {
  return [signals.nearestHeadingText, signals.submitButtonText, signals.formAttributesText].filter(Boolean).join(" ");
}

/**
 * Journey relevance: how well this form's own text matches the objective/active-milestone/
 * previous-CTA anchors (per-anchor-max token coverage, the same dilution-avoiding pattern
 * src/core/surfaceRelevance.ts and src/core/successEvaluator.ts already use -- see either
 * one's own doc comment for why blending anchors into one string before scoring is wrong),
 * plus a generic purpose-keyword signal: a form whose own text matches newsletter/search/
 * login vocabulary is never the journey's lead-capture form regardless of anchor overlap, and
 * one matching request-a-quote/offer/test-drive/contact/dealer-enquiry vocabulary gets a
 * bonus even when the task's own wording doesn't happen to share vocabulary with the page.
 */
export function scoreJourneyRelevance(context: FormJourneyContext, signals: FormTextSignals): number {
  const text = combinedFormText(signals);
  const normalizedLocalText = normalize(localFormText(signals));
  if (matchesAny(normalizedLocalText, NEGATIVE_PURPOSE_KEYWORDS)) {
    return 0;
  }
  const anchors = [context.objective, ...(context.activeMilestoneTexts ?? []), context.previousActionLabel].filter(
    (anchor): anchor is string => Boolean(anchor && anchor.trim().length > 0),
  );
  const anchorScore = anchors.length === 0 ? 0 : Math.max(...anchors.map((anchor) => objectiveTokenCoverage(anchor, text)));
  const purposeBonus = matchesAny(normalizedLocalText, POSITIVE_PURPOSE_KEYWORDS) ? 0.3 : 0;
  return Math.min(1, anchorScore + purposeBonus);
}

/** Visual prominence evidence for a single candidate form, read directly off the live page. */
export interface FormVisibilityProminenceSignals {
  visible: boolean;
  /** Inside a persistent nav/header/footer landmark -- the same chrome exclusion src/core/semanticPageMatch.ts already applies to interactive elements. */
  inChrome: boolean;
  /** Bounding-box area relative to the viewport's, clamped to [0, 1]. */
  areaRatio: number;
  hasNearbyHeading: boolean;
  hasVisibleSubmitButton: boolean;
}

/**
 * Visibility/prominence: a hidden/collapsed/off-screen form scores 0 outright; everything
 * else is a bounded sum of generic visual-prominence evidence (main-content area rather than
 * header/footer/nav chrome, a reasonably large visible area, a nearby heading, a visible
 * submit control) -- never a CSS selector or DOM-position rule specific to any one site.
 */
export function scoreVisibilityProminence(signals: FormVisibilityProminenceSignals): number {
  if (!signals.visible) {
    return 0;
  }
  let score = signals.inChrome ? 0.0 : 0.3;
  score += Math.min(0.3, signals.areaRatio);
  if (signals.hasNearbyHeading) {
    score += 0.2;
  }
  if (signals.hasVisibleSubmitButton) {
    score += 0.2;
  }
  return Math.max(0, Math.min(1, score));
}

/** Field actionability is supporting evidence only (see WEIGHTS below) -- how much of what the form offers the deterministic fill plan can actually act on. */
export function scoreFieldActionability(fieldsDiscovered: number, actionableFieldCount: number): number {
  if (fieldsDiscovered === 0) {
    return 0;
  }
  return Math.min(1, actionableFieldCount / fieldsDiscovered);
}

export interface FormScoreBreakdown {
  journeyRelevanceScore: number;
  visibilityProminenceScore: number;
  fieldActionabilityScore: number;
  totalFormScore: number;
}

/** Field actionability never dominates: a form with more fillable fields is not automatically the right form (the production bug this module fixes) -- journey relevance and visual prominence together carry 85% of the weight. */
const WEIGHTS = { journey: 0.5, visibility: 0.35, fieldActionability: 0.15 } as const;

export function computeFormScore(input: {
  journeyContext: FormJourneyContext;
  textSignals: FormTextSignals;
  visibilitySignals: FormVisibilityProminenceSignals;
  fieldsDiscovered: number;
  actionableFieldCount: number;
}): FormScoreBreakdown {
  const journeyRelevanceScore = scoreJourneyRelevance(input.journeyContext, input.textSignals);
  const visibilityProminenceScore = scoreVisibilityProminence(input.visibilitySignals);
  const fieldActionabilityScore = scoreFieldActionability(input.fieldsDiscovered, input.actionableFieldCount);
  const totalFormScore = Math.min(
    1,
    WEIGHTS.journey * journeyRelevanceScore + WEIGHTS.visibility * visibilityProminenceScore + WEIGHTS.fieldActionability * fieldActionabilityScore,
  );
  return { journeyRelevanceScore, visibilityProminenceScore, fieldActionabilityScore, totalFormScore };
}

/** A form never gets submitted on a score below this -- "do not submit when confidence is below a defined threshold" (deliberately the same adopt/reject-band shape as src/core/surfaceRelevance.ts's RELEVANCE_ADOPT_THRESHOLD/RELEVANCE_REJECT_THRESHOLD; unvalidated initial calibration, not production-proven). */
export const FORM_SELECTION_ADOPT_THRESHOLD = 0.4;
/** Below this, a candidate is clearly not in play at all -- used only to decide whether the gap between the top two candidates counts as "ambiguous" below. */
export const FORM_SELECTION_REJECT_THRESHOLD = 0.15;
/** Two candidates within this margin of each other are too close for the deterministic score alone to safely distinguish. */
const AMBIGUITY_MARGIN = 0.1;

export interface FormCandidate {
  index: number;
  score: FormScoreBreakdown;
}

export interface RejectedFormReason {
  index: number;
  totalFormScore: number;
  reason: string;
}

export interface FormSelectionResult {
  chosenIndex: number;
  confidence: number;
  belowConfidenceThreshold: boolean;
  ambiguous: boolean;
  selectedFormReason: string;
  rejectedFormsAndReasons: RejectedFormReason[];
}

/**
 * Deterministic selection among already-scored candidates. Never submits on its own -- the
 * caller (src/actions/fillForm.ts) decides what belowConfidenceThreshold/ambiguous mean for
 * whether to fill/submit; this function only ranks and explains.
 */
export function selectBestForm(candidates: FormCandidate[]): FormSelectionResult {
  if (candidates.length === 0) {
    throw new Error("selectBestForm requires at least one candidate");
  }
  const ranked = [...candidates].sort((a, b) => b.score.totalFormScore - a.score.totalFormScore);
  const winner = ranked[0]!;
  const runnerUp = ranked[1];

  const rejectedFormsAndReasons: RejectedFormReason[] = ranked
    .filter((candidate) => candidate.index !== winner.index)
    .map((candidate) => ({
      index: candidate.index,
      totalFormScore: candidate.score.totalFormScore,
      reason:
        candidate.score.totalFormScore <= FORM_SELECTION_REJECT_THRESHOLD
          ? "low journey relevance, visibility/prominence, and field actionability"
          : "scored lower than the selected form",
    }));

  const belowConfidenceThreshold = winner.score.totalFormScore < FORM_SELECTION_ADOPT_THRESHOLD;
  const ambiguous =
    !belowConfidenceThreshold &&
    runnerUp !== undefined &&
    runnerUp.score.totalFormScore > FORM_SELECTION_REJECT_THRESHOLD &&
    winner.score.totalFormScore - runnerUp.score.totalFormScore < AMBIGUITY_MARGIN;

  const selectedFormReason = belowConfidenceThreshold
    ? `no candidate form reached the confidence threshold (best score ${winner.score.totalFormScore.toFixed(2)} < ${FORM_SELECTION_ADOPT_THRESHOLD})`
    : `highest total form score (${winner.score.totalFormScore.toFixed(2)}): journey relevance ${winner.score.journeyRelevanceScore.toFixed(2)}, visibility/prominence ${winner.score.visibilityProminenceScore.toFixed(2)}, field actionability ${winner.score.fieldActionabilityScore.toFixed(2)}`;

  return { chosenIndex: winner.index, confidence: winner.score.totalFormScore, belowConfidenceThreshold, ambiguous, selectedFormReason, rejectedFormsAndReasons };
}

/** Compact, per-candidate evidence handed to an ambiguity resolver -- never raw page HTML, cookies, or personal data, only the same text signals this module already scored. */
export interface FormSelectionAmbiguityContext {
  candidates: { index: number; textSignals: FormTextSignals; score: FormScoreBreakdown }[];
  journeyContext: FormJourneyContext;
}

export interface FormSelectionAmbiguityResolution {
  chosenIndex: number;
  rationale: string;
  confidence: number;
}

/**
 * Optional, generic model-assist hook for the ambiguous middle band only -- structurally the
 * same bounded, independently-verified-before-trust shape as
 * src/core/surfaceRelevance.ts's SurfaceRelevanceAmbiguityResolver and
 * src/safety/consentClassifier.ts's ConsentAmbiguityResolver. Never a standalone judge: see
 * resolveAmbiguousFormSelection below for the verification every resolution is put through.
 * No caller configures one yet (same as src/forms/unmappedFieldResolver.ts) -- its absence
 * means the ambiguous band simply fails closed, never that selection is unsafe without it.
 */
export interface FormSelectionAmbiguityResolver {
  resolve(context: FormSelectionAmbiguityContext): Promise<FormSelectionAmbiguityResolution>;
}

const MIN_FORM_SELECTION_AMBIGUITY_CONFIDENCE = 0.7;

/**
 * Exported (unlike a purely internal helper) so its independent-verification behaviour can be
 * unit-tested directly without a real resolver -- mirrors
 * resolveAmbiguousSurfaceRelevance/resolveAmbiguousConsentSurface being exported for the same
 * reason.
 */
export async function resolveAmbiguousFormSelection(
  context: FormSelectionAmbiguityContext,
  resolver: FormSelectionAmbiguityResolver,
): Promise<{ chosenIndex: number; rationale: string } | undefined> {
  let resolution: FormSelectionAmbiguityResolution;
  try {
    resolution = await resolver.resolve(context);
  } catch {
    return undefined;
  }

  if (resolution.confidence < MIN_FORM_SELECTION_AMBIGUITY_CONFIDENCE || resolution.rationale.trim().length === 0) {
    return undefined;
  }

  const chosen = context.candidates.find((candidate) => candidate.index === resolution.chosenIndex);
  if (!chosen) {
    return undefined;
  }

  // Independent verification: the resolution must cite something actually present in the
  // evidence it was given -- never trusted blindly, mirroring resolveAmbiguousSurfaceRelevance's
  // own evidence-citation check.
  const evidenceTokens = new Set(
    tokenize(
      [chosen.textSignals.pageTitle, chosen.textSignals.nearestHeadingText, chosen.textSignals.submitButtonText, chosen.textSignals.formAttributesText].join(
        " ",
      ),
    ),
  );
  const rationaleTokens = tokenize(resolution.rationale);
  const citesEvidence = rationaleTokens.some((token) => evidenceTokens.has(token));
  if (!citesEvidence) {
    return undefined;
  }

  return { chosenIndex: resolution.chosenIndex, rationale: resolution.rationale };
}
