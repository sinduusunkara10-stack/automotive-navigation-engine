import type { Locator, Page } from "playwright";
import type { Captures } from "../types/task-response.js";
import type { ActionExecutorResult, ActiveSurfaceInfo } from "../types/task-response.js";
import type { SelectedAction } from "../types/actions.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { captureDataLayer } from "../capture-modules/dataLayer.js";
import { attachGa4NetworkCapture } from "../capture-modules/ga4NetworkEvents.js";
import { detectCaptcha } from "../forms/captcha.js";
import { detectPageLanguage } from "../forms/fieldMapper.js";
import { buildFillPlan, isFillTarget, isProxiedRequiredSelect, type FormFieldDescriptor, type PlannedField } from "../forms/fillPlan.js";
import { commitProxiedSelect, PROXY_ATTR_SUFFIX, type ProxiedSelectOutcome } from "../forms/selectProxy.js";
import {
  beginProbeAttempt,
  classifyClientSideCancellation,
  installSubmitProbe,
  readProbeAttempt,
  type ClientSideCancellationClassification,
  type SecondAttemptStateRefresh,
  type SubmitCancellationDiagnostics,
} from "./submitCancellationProbe.js";
import {
  buildAcknowledgementCheckboxDiagnostics,
  diffSnapshots,
  requiredAcknowledgementUnchecked,
  requiredUncommitted,
  snapshotFormState,
  type ControlStateSnapshot,
  type SnapshotWithCompanions,
} from "./formStateSnapshot.js";
import { marketDataFor, resolveMarket, type SupportedLanguage } from "../forms/testData.js";
import { resolveLocationGate, type LocationGateOutcome } from "./locationGate.js";
import type { UnmappedFieldResolver } from "../forms/unmappedFieldResolver.js";
import {
  applyOptionalConsentOptInForTest,
  rediscoverOptionalConsentGroups,
  resolveConsentGroups,
  type ConsentGroupRejection,
  type OptionalConsentOptInResult,
  type OptionalConsentRediscovery,
} from "../forms/consentGroups.js";
import { callInPageFunction } from "../forms/inPageFunction.js";
import {
  DEALER_RESULT_SELECTOR,
  DEALER_SCOPE_ATTR,
  dealerScopeFor,
  matchesLookupTriggerVocabulary,
  resolveDealerLookup,
  tagAndFindLookupTriggers,
  triggerByIndex,
  type DealerLookupOutcome,
  type TriggerFieldPairDebug,
} from "./dealerLookup.js";
import {
  buildFormDiscoveryDebug,
  isFormDiscoveryDiagnosticEnabled,
  logFormDiscoveryDiagnosticEmitted,
  logFormDiscoveryDiagnosticEnabled,
  writeFormDiscoveryDebugBackup,
} from "../diagnostics/formDiscoveryDiagnostic.js";
import { buildDealerLookupTrace } from "../diagnostics/dealerLookupDiagnostic.js";
import { startDealerLookupNetworkCapture, type SanitizedNetworkRequestEvidence } from "./dealerLookupNetwork.js";
import {
  installSubmissionObserver,
  observeSubmissionOutcome,
  resolveSubmissionObservationConfig,
  selectBusinessRequests,
  type PostSubmitObservation,
  type SubmissionObservationConfig,
} from "./submissionObserver.js";
import {
  MAX_SUBMIT_ATTEMPTS,
  classifySubmitAttempt,
  evaluateFallbackEligibility,
  firstAttemptConsentModeOf,
  submitNeverAttemptedSummary,
  type FallbackEligibilityChecks,
  type FallbackNotUsedReason,
  type SubmitAttemptSummary,
} from "./submitAttemptPlan.js";
import {
  computeFormScore,
  resolveAmbiguousFormSelection,
  selectBestForm,
  type FormCandidate,
  type FormJourneyContext,
  type FormScoreBreakdown,
  type FormSelectionAmbiguityResolver,
  type FormTextSignals,
  type FormVisibilityProminenceSignals,
} from "../forms/formRelevance.js";
import { gatherSemanticPageSignals } from "../core/semanticPageMatch.js";
import { firstSelectableOption } from "../forms/vehicleSelection.js";

const FIELD_INDEX_ATTR = "data-nav-engine-field-index";

interface SubmitAttemptStateRecord {
  attempt: number;
  beforeSubmit: SnapshotWithCompanions | null;
  afterCancellation: SnapshotWithCompanions | null;
  classification: ClientSideCancellationClassification | null;
  refresh: SecondAttemptStateRefresh | null;
}
const MAX_RETRIES = 2;
const OPTIONAL_COMMERCIAL_PURPOSES = new Set(["optional_marketing", "optional_profiling", "optional_third_party"]);

const SUCCESS_TEXT_MARKERS = [
  "thank you",
  "merci",
  "danke",
  "bedankt",
  "grazie",
  "gracias",
  "dziekujemy",
  "dziękujemy",
  "obrigado",
  "confirmation",
  "confirme",
  "confirmé",
  "bestatigt",
  "bestätigt",
  "bevestigd",
  "confermato",
  "confirmado",
  "potwierdzenie",
  "vielen dank",
  "successfully",
  "has been received",
  "has been sent",
  "bien ete enregistree",
  "bien ete envoyee",
  "bien été enregistrée",
  "bien été envoyée",
  "erfolgreich",
  "succesvol",
  "con successo",
  "con éxito",
  "con exito",
  "pomyślnie",
  "pomyslnie",
  "com sucesso",
];

const SUBMIT_TEXT_MARKERS = ["submit", "send", "soumettre", "envoyer", "senden", "versturen", "invia", "inviare", "enviar", "wyslij", "wyślij"];

/**
 * Diagnostics for the generic postcode/city -> lookup -> (auto-populate | suggestion | dealer
 * list) -> verify flow a `dealer_search` decision drives. Always present (with explicit
 * false/empty defaults) whenever a submit was attempted, even when no field was ever mapped to
 * the dealer_search decision -- see EMPTY_DEALER_SEARCH_DIAGNOSTICS.
 */
export interface DealerSearchDiagnostics {
  /** A plain (non-dealer) postcode-purpose field was also present on the chosen form -- e.g. a customer-address postcode, distinct from the dealer-lookup postcode/city field. */
  customerPostcodeFieldDetected: boolean;
  /** A field was identified as serving the dealer-lookup purpose (by keyword match or by structural adjacency to a lookup control). */
  dealerLookupFieldDetected: boolean;
  dealerLookupFieldEvidence: string;
  /** The dealer-lookup field had its own structurally-adjacent lookup control (not just a keyword match with no control found). */
  dealerLookupControlDetected: boolean;
  dealerLookupControlEvidence: string;
  dealerLookupTriggered: boolean;
  dealerLookupOutcome: "auto_populated" | "suggestion_selected" | "dealer_selected" | "unresolved" | "not_applicable";
  locationSuggestionsDetected: boolean;
  locationSuggestionSelected: boolean;
  dealerResultsDetected: boolean;
  dealerAutoPopulated: boolean;
  dealerSelected: boolean;
  dealerValueVerified: boolean;
  dealerVerificationEvidence: string;
  dealerLookupFailureReason?: string;
  /**
   * True when more than one field on the chosen form matched the generic "postcode" purpose and
   * more than one of them remained a plain fill_text decision (never upgraded to dealer_search).
   * A genuine detection failure (trigger-to-field association never fires) and an ambiguous
   * double-postcode layout look identical from requiredFieldsFilled alone -- entering the same
   * postcode text into two fields must never, by itself, be read as "the dealer dependency is
   * resolved". This is a generic defense-in-depth signal independent of the structural detection
   * above: it fires even when dealerLookupFieldDetected is false, which is exactly the case a
   * detection miss produces.
   */
  multiplePostcodeFieldsUnresolved: boolean;
  multiplePostcodeFieldsEvidence: string;
}

/**
 * Post-submit validation evidence, read fresh (after re-tagging) so a field revealed only after a
 * dynamic widget interaction is never invisible to it. invalidFieldIds/nativeValidationMessages/
 * postSubmitValidationMessages are native/visible constraint-validation evidence; the fields below
 * extend that to evidence a site's own JS can leave with no native validation message at all --
 * see validationCauseObserved.
 */
export interface PostSubmitDiagnostics {
  invalidFieldIds: string[];
  nativeValidationMessages: Record<string, string>;
  postSubmitValidationMessages: string[];
  /** Field ids carrying aria-invalid="true" after the last submit attempt, independent of whether tagAndReadFields' own requiredness evidence flagged them (findInvalidFieldIds only looks at fields it already believes are required). */
  ariaInvalidFieldIds: string[];
  /** Sanitised per-hidden-input evidence -- purpose category, a safe identifier-shaped name, and populated/changed/committed booleans. Never a value: hidden inputs routinely carry dealer identifiers, tracking/client ids and tokens. */
  hiddenFieldEvidence: HiddenFieldEvidence[];
  /** DEALER_SCOPE_ATTR-tagged widget scopes (see dealerLookup.ts) that show at least one accessible selectable result but none of them ended up checked/selected -- an unresolved dependent control, independent of whatever this run's own dealerLookupOutcome already tracked (this is a direct DOM re-scan, not a memory of what resolveDealerLookup saw earlier). */
  unresolvedDependentControlIds: string[];
  /** False only when none of the signals above (native/aria-invalid, visible validation text, or an unresolved dependent control) produced any evidence at all -- i.e. the submission was cancelled for a reason this engine could not observe. formFillOutcome then reports "validation_cause_not_observed" instead of "form_validation_failed", so a genuinely silent cancellation is never misreported as a diagnosed validation failure. */
  validationCauseObserved: boolean;
}

export type HiddenFieldPurpose = "dealer_or_location_selection" | "consent_state" | "security_token" | "tracking_or_session" | "form_routing" | "other";

export interface HiddenFieldEvidence {
  purpose: HiddenFieldPurpose;
  /** The input's own name/id reduced to an identifier shape (letters/underscore/hyphen, digits replaced, capped), or null when nothing safe remains. */
  safeName: string | null;
  presentBefore: boolean;
  presentAfter: boolean;
  populatedBefore: boolean;
  populatedAfter: boolean;
  changed: boolean;
  /** Blank (or absent) before the fill and populated after it -- the shape a widget's own committed selection takes. */
  committed: boolean;
}

/** Positional hidden-input state, compared in memory only: a value fingerprint, never the value, and never emitted. */
interface HiddenFieldStateEntry {
  key: string;
  safeName: string | null;
  purpose: HiddenFieldPurpose;
  populated: boolean;
  fingerprint: string;
}

const EMPTY_POST_SUBMIT_DIAGNOSTICS: PostSubmitDiagnostics = {
  invalidFieldIds: [],
  nativeValidationMessages: {},
  postSubmitValidationMessages: [],
  ariaInvalidFieldIds: [],
  hiddenFieldEvidence: [],
  unresolvedDependentControlIds: [],
  validationCauseObserved: false,
};

const READ_HIDDEN_FIELD_STATE_SOURCE = `(formEl) => {
  const PURPOSE_STEMS = [
    ["security_token", ["csrf", "xsrf", "token", "nonce", "captcha", "recaptcha", "signature", "hmac"]],
    ["tracking_or_session", ["utm", "gclid", "fbclid", "msclkid", "ttclid", "tracking", "track", "client", "visitor", "session", "sid", "cid", "ga", "analytics", "campaign", "source", "medium", "referrer", "referer", "abtest", "variant"]],
    ["dealer_or_location_selection", ["dealer", "retailer", "site", "outlet", "store", "shop", "agency", "concession", "pdv", "branch", "location", "geo", "lat", "lng", "lon", "postcode", "postal", "zip", "city", "place"]],
    ["consent_state", ["consent", "optin", "opt", "privacy", "gdpr", "rgpd", "marketing", "newsletter"]],
    ["form_routing", ["form", "lead", "type", "brand", "model", "market", "country", "language", "lang", "locale", "context", "page", "origin", "channel", "request"]],
  ];
  const tokensOf = (raw) => raw.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const fingerprint = (v) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < v.length; i += 1) {
      h ^= v.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };
  return Array.from(formEl.querySelectorAll('input[type="hidden"]')).map((el, i) => {
    const rawName = el.getAttribute("name") || el.getAttribute("id") || "";
    const safe = rawName.replace(/[0-9]+/g, "#").replace(/[^A-Za-z_#.\\-\\[\\]]/g, "").slice(0, 48);
    const tokens = tokensOf(rawName);
    const match = PURPOSE_STEMS.find((entry) => tokens.some((t) => entry[1].includes(t)));
    const value = el.value || "";
    return { key: i + ":" + rawName, safeName: safe.length > 0 ? safe : null, purpose: match ? match[0] : "other", populated: value.trim().length > 0, fingerprint: fingerprint(value) };
  });
}`;

async function readHiddenFieldState(form: Locator): Promise<HiddenFieldStateEntry[]> {
  return callInPageFunction<HiddenFieldStateEntry[]>(form, "__navEngineReadHiddenFieldState", READ_HIDDEN_FIELD_STATE_SOURCE, null).catch(() => []);
}

function compareHiddenFieldState(before: HiddenFieldStateEntry[] | null, after: HiddenFieldStateEntry[]): HiddenFieldEvidence[] {
  const beforeByKey = new Map((before ?? []).map((e) => [e.key, e]));
  const afterKeys = new Set(after.map((e) => e.key));
  const evidence: HiddenFieldEvidence[] = after.map((a) => {
    const b = beforeByKey.get(a.key);
    return {
      purpose: a.purpose,
      safeName: a.safeName,
      presentBefore: before === null ? false : b !== undefined,
      presentAfter: true,
      populatedBefore: b?.populated ?? false,
      populatedAfter: a.populated,
      changed: b === undefined ? a.populated : b.fingerprint !== a.fingerprint,
      committed: !(b?.populated ?? false) && a.populated,
    };
  });
  for (const b of before ?? []) {
    if (afterKeys.has(b.key)) continue;
    evidence.push({
      purpose: b.purpose,
      safeName: b.safeName,
      presentBefore: true,
      presentAfter: false,
      populatedBefore: b.populated,
      populatedAfter: false,
      changed: b.populated,
      committed: false,
    });
  }
  return evidence.slice(0, 40);
}

const EMPTY_DEALER_SEARCH_DIAGNOSTICS: DealerSearchDiagnostics = {
  customerPostcodeFieldDetected: false,
  dealerLookupFieldDetected: false,
  dealerLookupFieldEvidence: "",
  dealerLookupControlDetected: false,
  dealerLookupControlEvidence: "",
  dealerLookupTriggered: false,
  dealerLookupOutcome: "not_applicable",
  locationSuggestionsDetected: false,
  locationSuggestionSelected: false,
  dealerResultsDetected: false,
  dealerAutoPopulated: false,
  dealerSelected: false,
  dealerValueVerified: false,
  dealerVerificationEvidence: "",
  multiplePostcodeFieldsUnresolved: false,
  multiplePostcodeFieldsEvidence: "",
};

export interface ExecuteFillFormParams {
  page: Page;
  action: SelectedAction;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  /** Optional, injected once per run -- see unmappedFieldResolver.ts. Never required: an unresolved required field simply stays empty and surfaces via the validation-retry path. */
  unmappedFieldResolver?: UnmappedFieldResolver;
  /** Objective/active-milestone/previous-CTA evidence for multi-form journey-relevance selection -- see forms/formRelevance.ts. Absent (treated as empty) scores every candidate on visibility/prominence and field actionability alone. */
  journeyContext?: FormJourneyContext;
  /** Optional, injected once per run -- see forms/formRelevance.ts's FormSelectionAmbiguityResolver. No caller configures one yet; its absence just means the ambiguous band fails closed. */
  selectionAmbiguityResolver?: FormSelectionAmbiguityResolver;
  /** Diagnostic-only (see src/diagnostics/formDiscoveryDiagnostic.ts) -- never read by scoring/selection/fill logic. */
  taskId?: string;
  /** Diagnostic-only -- the pre-dispatch observation's own activeSurface. */
  activeSurfaceInfo?: ActiveSurfaceInfo;
  /** Overrides the post-submit observation windows (see submissionObserver.ts); production uses the defaults. */
  submissionObservationConfig?: SubmissionObservationConfig;
  /**
   * safety.allowOptionalConsentOptInFallbackForTest: permits one guarded second Submit with the
   * optional commercial consents switched to accept, for an authorised test-data journey only
   * (see submitAttemptPlan.ts for every guard). Omitted means false.
   */
  optionalConsentOptInFallbackForTest?: boolean;
}

/** Where a field's `required: true` came from -- see RawFieldDescriptor.requiredEvidence below. */
export type RequiredEvidence = "attribute" | "marker" | "none";

interface RawFieldDescriptor {
  index: number;
  tagName: string;
  type?: string;
  name?: string;
  placeholder?: string;
  autocomplete?: string;
  label?: string;
  required: boolean;
  /** How `required` was decided -- never submitted as fact without evidence (see fillForm.ts's field-level diagnostics). */
  requiredEvidence: RequiredEvidence;
  visible: boolean;
  currentValue: string;
  /** True when `currentValue` only mirrors this field's own label/placeholder text (a site rendering its placeholder into the live value instead of the `placeholder` attribute) -- never real prefilled data, so fillPlan.ts must not skip the field as "prefilled" because of it. */
  isPlaceholderMimicry: boolean;
  isPreselected?: boolean;
  options?: { value: string; label: string; disabled?: boolean }[];
  dealerLookupTriggerIndex?: string;
  selectProxyKind?: "readonly_input" | "combobox" | "button";
  isSelectProxy: boolean;
}

/**
 * Deliberately avoids any named helper function/const inside the evaluate callback --
 * tsx/esbuild wraps a nested named binding in a `__name(...)` call that doesn't exist once
 * Playwright serializes the function's source to run in the browser (ReferenceError:
 * __name is not defined). Everything stays inline in one anonymous arrow per field instead.
 */
async function tagAndReadFields(form: Locator): Promise<RawFieldDescriptor[]> {
  return form.evaluate((formEl: HTMLFormElement, attr: string) => {
    const fields = Array.from(formEl.querySelectorAll("input, select, textarea")) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    fields.forEach((el) => el.removeAttribute(`${attr}-proxy-for`));
    const described = fields.map((el, index) => {
      el.setAttribute(attr, String(index));
      const tagName = el.tagName.toLowerCase();
      const type = tagName === "input" ? (el as HTMLInputElement).type : undefined;
      let currentValue = "";
      let isPreselected: boolean | undefined;
      let options: { value: string; label: string }[] | undefined;
      if (tagName === "select") {
        const select = el as HTMLSelectElement;
        options = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() ?? "", disabled: o.disabled }));
        currentValue = select.value;
        isPreselected = select.selectedIndex > 0 && select.value.trim().length > 0;
      } else if (type === "checkbox" || type === "radio") {
        currentValue = String((el as HTMLInputElement).checked);
      } else {
        currentValue = (el as HTMLInputElement | HTMLTextAreaElement).value;
      }

      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";

      // A required native <select> that a custom widget hides (zero-size or display:none on the
      // select itself) while showing its own visible control in the same small container: the
      // visible control is the select's proxy. Never inferred inside a hidden ancestor (an
      // inactive copy) or from a container that also holds an unrelated field.
      let selectProxyKind: "readonly_input" | "combobox" | "button" | undefined;
      if (tagName === "select" && !visible) {
        let inactiveAncestor = false;
        for (let a = el.parentElement; a && a !== formEl.parentElement; a = a.parentElement) {
          const s = window.getComputedStyle(a);
          if (s.display === "none" || s.visibility === "hidden") {
            inactiveAncestor = true;
            break;
          }
        }
        let container: Element | null = inactiveAncestor ? null : el.parentElement;
        let hops = 0;
        while (container && container !== formEl && hops < 3 && !selectProxyKind) {
          if (container.querySelectorAll("select").length > 1) break;
          const proxyCandidates = Array.from(
            container.querySelectorAll('input[readonly]:not([type="hidden"]), [role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup]'),
          ).filter((c) => c !== el);
          const unrelated = Array.from(container.querySelectorAll('input:not([type="hidden"]), textarea')).filter((n) => !proxyCandidates.includes(n));
          if (unrelated.length > 0) break;
          const shownCandidates = proxyCandidates.filter((c) => {
            const r = c.getBoundingClientRect();
            const cs = window.getComputedStyle(c);
            return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
          });
          if (shownCandidates.length === 1) {
            const proxyEl = shownCandidates[0]!;
            selectProxyKind =
              proxyEl.tagName === "INPUT" ? "readonly_input" : proxyEl.tagName === "BUTTON" && proxyEl.getAttribute("role") !== "combobox" ? "button" : "combobox";
            proxyEl.setAttribute(`${attr}-proxy-for`, String(index));
          }
          container = container.parentElement;
          hops += 1;
        }
      }

      const id = el.getAttribute("id");
      const byForLabel = id ? formEl.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const closestLabel = el.closest("label");
      let labelEl: Element | null = byForLabel ?? closestLabel;
      if (!labelEl && visible) {
        // Generic fallback for a visible control whose id doesn't match any label's `for`
        // (a custom-widget-generated id, or a label pointing at a hidden duplicate backing
        // input) and that isn't wrapped in a <label> either: walk a few preceding siblings
        // of the control itself, then of its parent, looking for the first element carrying
        // its own short text -- the same bounded sibling/ancestor-walk shape
        // forms/formRelevance.ts's gatherFormSignals already uses for nearestHeadingText.
        // Never climbs past the form's own boundary -- a hidden field never needs this (it is
        // always skipped regardless of its label) and a visible field's real label is always
        // inside the form that contains it.
        let node: Element | null = el;
        let steps = 0;
        while (node && node !== formEl && steps < 6 && !labelEl) {
          let sibling: Element | null = node.previousElementSibling;
          let siblingSteps = 0;
          while (sibling && siblingSteps < 4 && !labelEl) {
            const text = sibling.textContent?.trim() ?? "";
            if (text.length > 0 && text.length < 80 && sibling.querySelector("input, select, textarea") === null) {
              labelEl = sibling;
            }
            sibling = sibling.previousElementSibling;
            siblingSteps += 1;
          }
          node = node.parentElement;
          steps += 1;
        }
      }
      const labelText = labelEl?.textContent?.trim() || el.getAttribute("aria-label") || "";

      // Generic visible required-marker detection: a bare "*" is a near-universal,
      // language-agnostic convention for "this field is required" that many sites express
      // only visually (a sibling/decorator element, or appended to the label text) without
      // ever setting the HTML `required` attribute or `aria-required`. Never brand-specific --
      // just the literal asterisk symbol, wherever it appears near this field's own label.
      const hasAttributeRequired = el.hasAttribute("required") || el.getAttribute("aria-required") === "true";
      let hasRequiredMarker = /\*\s*$/.test(labelText);
      if (!hasRequiredMarker && labelEl) {
        const markerCandidates = [labelEl.nextElementSibling, labelEl.parentElement?.querySelector(".required, .mandatory") ?? null];
        hasRequiredMarker = markerCandidates.some((candidate) => (candidate?.textContent?.trim() ?? "") === "*");
      }
      if (!hasRequiredMarker) {
        const ownMarkerSibling = el.nextElementSibling;
        hasRequiredMarker = (ownMarkerSibling?.textContent?.trim() ?? "") === "*";
      }
      const required = hasAttributeRequired || hasRequiredMarker;
      const requiredEvidence: "attribute" | "marker" | "none" = hasAttributeRequired ? "attribute" : hasRequiredMarker ? "marker" : "none";

      const normalizedValue = currentValue.trim().toLowerCase();
      const normalizedLabel = labelText.trim().toLowerCase();
      const normalizedPlaceholder = (el.getAttribute("placeholder") ?? "").trim().toLowerCase();
      const isPlaceholderMimicry =
        normalizedValue.length > 0 && (normalizedValue === normalizedLabel || normalizedValue === normalizedPlaceholder);

      el.setAttribute(`${attr}-required`, String(required));

      return {
        index,
        tagName: tagName as "input" | "select" | "textarea",
        type,
        name: el.getAttribute("name") ?? undefined,
        placeholder: el.getAttribute("placeholder") ?? undefined,
        autocomplete: el.getAttribute("autocomplete") ?? undefined,
        label: labelText,
        required,
        requiredEvidence,
        visible,
        currentValue,
        isPlaceholderMimicry,
        isPreselected,
        options,
        selectProxyKind,
        isSelectProxy: false,
      };
    });
    // A proxy can precede its select in document order, so it is only known once every select ran.
    return described.map((d, i) => ({ ...d, isSelectProxy: fields[i]!.hasAttribute(`${attr}-proxy-for`) }));
  }, FIELD_INDEX_ATTR);
}

interface RawFormSignals {
  visible: boolean;
  inChrome: boolean;
  areaRatio: number;
  hasNearbyHeading: boolean;
  hasVisibleSubmitButton: boolean;
  nearestHeadingText: string;
  submitButtonText: string;
  formAttributesText: string;
}

/**
 * Visual-prominence and local-text evidence for one candidate <form> -- see
 * forms/formRelevance.ts's FormVisibilityProminenceSignals/FormTextSignals. Everything stays
 * inline in one anonymous callback (no nested named helper), same reason as tagAndReadFields
 * above.
 */
async function gatherFormSignals(form: Locator): Promise<RawFormSignals> {
  return form.evaluate((formEl: HTMLFormElement) => {
    const rect = formEl.getBoundingClientRect();
    const style = window.getComputedStyle(formEl);
    const onScreen = rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && onScreen;
    const inChrome =
      formEl.closest('nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"]') !== null;
    const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
    const areaRatio = Math.min(1, (rect.width * rect.height) / viewportArea);

    const headingSelector = "h1, h2, h3, h4";
    let nearestHeadingText = "";
    const ownHeading = formEl.querySelector(headingSelector);
    if (ownHeading) {
      nearestHeadingText = ownHeading.textContent?.trim() ?? "";
    } else {
      let sibling: Element | null = formEl.previousElementSibling;
      let siblingSteps = 0;
      while (sibling && siblingSteps < 6 && !nearestHeadingText) {
        if (sibling.matches(headingSelector)) {
          nearestHeadingText = sibling.textContent?.trim() ?? "";
        }
        sibling = sibling.previousElementSibling;
        siblingSteps += 1;
      }
      let ancestor: Element | null = formEl.parentElement;
      let ancestorSteps = 0;
      while (ancestor && ancestorSteps < 4 && !nearestHeadingText) {
        const heading = ancestor.querySelector(headingSelector);
        if (heading) {
          nearestHeadingText = heading.textContent?.trim() ?? "";
        }
        ancestor = ancestor.parentElement;
        ancestorSteps += 1;
      }
    }
    const hasNearbyHeading = nearestHeadingText.length > 0;

    const submitEls = Array.from(formEl.querySelectorAll<HTMLElement>('button[type="submit"], input[type="submit"]'));
    let submitButtonText = "";
    let hasVisibleSubmitButton = false;
    for (const el of submitEls) {
      const elRect = el.getBoundingClientRect();
      const elStyle = window.getComputedStyle(el);
      const elVisible = elRect.width > 0 && elRect.height > 0 && elStyle.visibility !== "hidden" && elStyle.display !== "none";
      if (elVisible) {
        hasVisibleSubmitButton = true;
        submitButtonText = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || (el as HTMLInputElement).value || "";
        break;
      }
    }
    if (!hasVisibleSubmitButton && submitEls.length === 0) {
      const genericButtons = Array.from(formEl.querySelectorAll<HTMLElement>("button"));
      const lastButton = genericButtons[genericButtons.length - 1];
      if (lastButton) {
        submitButtonText = lastButton.getAttribute("aria-label")?.trim() || lastButton.textContent?.trim() || "";
      }
    }

    const formAttributesText = [
      formEl.getAttribute("aria-label") ?? "",
      formEl.getAttribute("name") ?? "",
      formEl.id ?? "",
      formEl.getAttribute("action") ?? "",
    ].join(" ");

    return { visible, inChrome, areaRatio, hasNearbyHeading, hasVisibleSubmitButton, nearestHeadingText, submitButtonText, formAttributesText };
  });
}

function toDescriptor(raw: RawFieldDescriptor): FormFieldDescriptor {
  return {
    id: String(raw.index),
    tagName: raw.tagName as FormFieldDescriptor["tagName"],
    type: raw.type,
    name: raw.name,
    placeholder: raw.placeholder,
    autocomplete: raw.autocomplete,
    label: raw.label,
    required: raw.required,
    requiredEvidence: raw.requiredEvidence,
    visible: raw.visible,
    currentValue: raw.currentValue,
    isPlaceholderMimicry: raw.isPlaceholderMimicry,
    isPreselected: raw.isPreselected,
    options: raw.options,
    dealerLookupTriggerIndex: raw.dealerLookupTriggerIndex,
    selectProxyKind: raw.selectProxyKind,
    isSelectProxy: raw.isSelectProxy,
  };
}

/**
 * Combines tagAndReadFields with the separate lookup-trigger tagging pass (dealerLookup.ts),
 * resolving each field's own dealerLookupTriggerIndex by structural adjacency -- never a form-
 * wide flag, since a form can have two postcode-purpose fields (a plain customer-address postcode
 * and a dealer-locator postcode/city) sharing identical label vocabulary.
 *
 * `collectDebug` (diagnostic-only, see diagnostics/dealerLookupDiagnostic.ts) asks
 * tagAndFindLookupTriggers for its full per-pair trace in addition to the normal result; the
 * association decision itself (triggerByFieldId) is computed identically either way, from the
 * same `.candidates` this function already read before `pairDebug` existed.
 */
async function tagAndReadFieldsWithDealerLookup(
  form: Locator,
  collectDebug = false,
): Promise<{ fields: RawFieldDescriptor[]; triggerCandidates: Awaited<ReturnType<typeof tagAndFindLookupTriggers>>["candidates"]; pairDebug: TriggerFieldPairDebug[] }> {
  const raw = await tagAndReadFields(form);
  const { candidates: triggers, pairDebug } = await tagAndFindLookupTriggers(form, collectDebug);
  const triggerByFieldId = new Map<string, string>();
  // Pass 1: a trigger whose own accessible text/value matches the lookup vocabulary is the
  // strongest, most unambiguous signal (confirms the structural association isn't a coincidental
  // decoy button) -- registered first so it always wins ties over pass 2 below.
  for (const trigger of triggers) {
    if (trigger.adjacentFieldId && matchesLookupTriggerVocabulary(trigger.text) && !triggerByFieldId.has(trigger.adjacentFieldId)) {
      triggerByFieldId.set(trigger.adjacentFieldId, trigger.triggerIndex);
    }
  }
  // Pass 2 (fallback): tagAndFindLookupTriggers' own structural/ARIA association
  // (TRIGGER_FIELD_MAX_ANCESTOR_HOPS/MAX_PIXEL_DISTANCE, ARIA relationship taking priority over
  // both) already ranks evidence semantic-role-and-DOM-relationship-first, pixel distance last --
  // see its own doc comment. Requiring vocabulary-matching text on top of that was too strict: a
  // real lookup/select control is very often icon-only (empty accessible text) or carries an
  // untranslated i18n placeholder (e.g. a literal "{formButton}" key leaking from a broken
  // template) on a live production page, so it never has vocabulary text to match at all. Trust
  // the structural association by itself whenever no vocabulary-confirmed trigger has already
  // claimed that field -- vocabulary remains the deciding signal only when it's actually present.
  for (const trigger of triggers) {
    if (trigger.adjacentFieldId && !triggerByFieldId.has(trigger.adjacentFieldId)) {
      triggerByFieldId.set(trigger.adjacentFieldId, trigger.triggerIndex);
    }
  }
  return {
    fields: raw.map((field) => ({ ...field, dealerLookupTriggerIndex: triggerByFieldId.get(String(field.index)) })),
    triggerCandidates: triggers,
    pairDebug,
  };
}

async function fieldByIndex(form: Locator, index: string): Promise<Locator> {
  return form.locator(`[${FIELD_INDEX_ATTR}="${index}"]`);
}

function dealerOutcomeToDiagnostics(outcome: DealerLookupOutcome): Partial<DealerSearchDiagnostics> {
  return {
    dealerLookupTriggered: outcome.dealerLookupTriggered,
    dealerLookupOutcome: outcome.dealerLookupOutcome,
    locationSuggestionsDetected: outcome.locationSuggestionsDetected,
    locationSuggestionSelected: outcome.locationSuggestionSelected,
    dealerResultsDetected: outcome.dealerResultsDetected,
    dealerAutoPopulated: outcome.dealerAutoPopulated,
    dealerSelected: outcome.dealerSelected,
    dealerValueVerified: outcome.dealerValueVerified,
    dealerVerificationEvidence: outcome.dealerVerificationEvidence,
    dealerLookupFailureReason: outcome.dealerLookupFailureReason,
  };
}

async function applyDecision(
  page: Page,
  form: Locator,
  plannedField: PlannedField,
  hasCountryCodeSelector: boolean,
  language: SupportedLanguage,
  dealerLookupMode: "full" | "await_pending_lookup" = "full",
): Promise<{ key?: string; dealerLookup?: DealerLookupOutcome; proxiedSelect?: ProxiedSelectOutcome; checkboxActivation?: "native_check" | "label_click" }> {
  const field = await fieldByIndex(form, plannedField.descriptor.id);
  if (isProxiedRequiredSelect(plannedField.descriptor, plannedField.matchedField)) {
    return applyProxiedSelectDecision(page, form, field, plannedField, language);
  }
  switch (plannedField.decision.kind) {
    case "fill_text":
      await field.fill(plannedField.decision.value);
      return { key: plannedField.decision.field };
    case "select_option": {
      await field.selectOption({ value: plannedField.decision.value });
      return { key: plannedField.matchedField };
    }
    case "choose_first_valid_option": {
      // Any valid option is acceptable to the automation (e.g. a model/engine-style select
      // with no matched field) -- never disabled, never a generic placeholder option (see
      // forms/vehicleSelection.ts). A select with no selectable option at all is left unfilled
      // (never falsely reported as filled) so it still surfaces as a genuine gap.
      const options = plannedField.descriptor.options ?? [];
      const first = firstSelectableOption(options, language);
      if (!first) {
        return {};
      }
      await field.selectOption({ value: first.value });
      // Verify the final state actually committed the intended option rather than trusting the
      // click alone -- some sites' own JS can reset or reject a programmatic selection.
      const committedValue = await field.inputValue().catch(() => undefined);
      if (committedValue !== first.value) {
        await field.selectOption({ value: first.value }).catch(() => {});
      }
      // No matched field purpose exists for this select by definition (that's why it fell
      // through to this generic fallback) -- fall back to the field's own id so a real,
      // verified selection is never falsely left untracked as "unfilled".
      return { key: plannedField.matchedField ?? plannedField.descriptor.id };
    }
    case "select_negative_option": {
      const options = plannedField.descriptor.options ?? [];
      if (options.length > 0 && plannedField.descriptor.tagName === "select") {
        await field.selectOption({ value: options[options.length - 1]!.value });
      }
      return { key: plannedField.matchedField };
    }
    case "tick_checkbox": {
      const checkboxActivation = await tickCheckbox(page, field);
      return checkboxActivation ? { key: plannedField.matchedField, checkboxActivation } : {};
    }
    case "dealer_search": {
      // resolveDealerLookup enters the value itself, with real keyboard input -- a prior fill()
      // here would already have fired input/change without any keystroke, and on a retry would
      // reset a lookup the widget may still be running.
      const triggerIndex = plannedField.decision.triggerIndex;
      const trigger = triggerIndex ? await triggerByIndex(form, triggerIndex) : null;
      const scope = await dealerScopeFor(form, plannedField.descriptor.id);
      const outcome = await resolveDealerLookup(page, scope, trigger, field, form, { value: plannedField.decision.postcode, mode: dealerLookupMode });
      return { key: "dealerSearch", dealerLookup: outcome };
    }
    default:
      return {};
  }
}

const CHECKBOX_LABEL_ATTR = "data-nav-engine-checkbox-label";

/**
 * A required checkbox whose native box is off-screen or covered (a "visually hidden" custom
 * checkbox) cannot be pointer-checked; a visitor ticks it through its label, so that is the
 * fallback. Only a read-back of the native checked state counts as ticked.
 */
async function tickCheckbox(page: Page, field: Locator): Promise<"native_check" | "label_click" | null> {
  if (await field.isChecked().catch(() => false)) return "native_check";
  const native = await field
    .check({ timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (native && (await field.isChecked().catch(() => false))) return "native_check";
  const labelTagged = await field
    .evaluate((el: Element, attr: string) => {
      document.querySelectorAll(`[${attr}]`).forEach((n) => n.removeAttribute(attr));
      const label = Array.from((el as HTMLInputElement).labels ?? []).find((l) => {
        const r = l.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!label) return false;
      label.setAttribute(attr, "1");
      return true;
    }, CHECKBOX_LABEL_ATTR)
    .catch(() => false);
  if (!labelTagged) return null;
  await page
    .locator(`[${CHECKBOX_LABEL_ATTR}]`)
    .first()
    .click({ timeout: 3_000 })
    .catch(() => {});
  return (await field.isChecked().catch(() => false)) ? "label_click" : null;
}

/** Same option policy as a visible select (first selectable option, or the negative option for a consent-shaped one), committed through the select's visible proxy. */
async function applyProxiedSelectDecision(
  page: Page,
  form: Locator,
  field: Locator,
  plannedField: PlannedField,
  language: SupportedLanguage,
): Promise<{ key?: string; proxiedSelect?: ProxiedSelectOutcome }> {
  const descriptor = plannedField.descriptor;
  const options = descriptor.options ?? [];
  const decision = plannedField.decision;
  const target =
    decision.kind === "select_option"
      ? options.find((o) => o.value === decision.value)
      : decision.kind === "select_negative_option"
        ? options[options.length - 1]
        : decision.kind === "choose_first_valid_option"
          ? firstSelectableOption(options, language)
          : undefined;
  if (!target) return {};
  const proxy = form.locator(`[${FIELD_INDEX_ATTR}${PROXY_ATTR_SUFFIX}="${descriptor.id}"]`).first();
  const outcome = await commitProxiedSelect(page, field, proxy, { value: target.value, label: target.label }, {
    fieldId: descriptor.id,
    purpose: plannedField.matchedField ?? "unclassified_required_select",
    proxyKind: descriptor.selectProxyKind ?? "combobox",
  });
  return outcome.nativeValueCommitted ? { key: plannedField.matchedField ?? descriptor.id, proxiedSelect: outcome } : { proxiedSelect: outcome };
}

async function findSubmitControl(form: Locator): Promise<Locator | null> {
  const typedAll = form.locator('button[type="submit"], input[type="submit"]');
  const typedCount = await typedAll.count();
  // A form can carry another layout's hidden copy of its Submit control before the rendered one;
  // clicking that copy can never submit, so the first rendered control wins.
  for (let i = 0; i < typedCount; i += 1) {
    if (await typedAll.nth(i).isVisible().catch(() => false)) return typedAll.nth(i);
  }
  const typed = typedAll.first();
  if (typedCount > 0) return typed;
  for (const marker of SUBMIT_TEXT_MARKERS) {
    const byText = form.getByRole("button", { name: new RegExp(marker, "i") }).first();
    if ((await byText.count()) > 0) return byText;
  }
  const lastButton = form.locator("button").last();
  return (await lastButton.count()) > 0 ? lastButton : null;
}

async function findInvalidFieldIds(form: Locator): Promise<string[]> {
  return form.evaluate((formEl: HTMLFormElement, attr: string) => {
    const invalid = Array.from(formEl.querySelectorAll(`[${attr}]`)).filter((el) => {
      const input = el as HTMLInputElement;
      // Reuses the same requiredness tagAndReadFields already computed (attribute or visible
      // marker) rather than recomputing `hasAttribute("required")` alone, which would miss a
      // field required only by a visible "*" marker.
      const isRequired = el.getAttribute(`${attr}-required`) === "true";
      return isRequired && (!input.checkValidity?.() || el.getAttribute("aria-invalid") === "true");
    });
    return invalid.map((el) => el.getAttribute(attr) ?? "");
  }, FIELD_INDEX_ATTR);
}

/** A site's validation text can echo the submitted value back ("12345 is not a valid postcode"):
 * e-mail addresses and digit runs are masked before any message leaves this module. */
function redactEchoedValues(text: string): string {
  return text
    .replace(/[^\s@]+@[^\s@]+/g, "{email}")
    .replace(/\+?\d[\d\s().-]{2,}\d/g, "{number}")
    .slice(0, 300);
}

export const REDACTED_OPTION_LABEL = "{option_label}";

/** A radio's label is an answer, not a field name: on a dealer or location widget it is a dealer's
 * name or address, so it is never returned. Every other label gets the same masking as messages. */
export function diagnosticFieldLabel(label: string, type: string | undefined): string {
  if (type === "radio") return label ? REDACTED_OPTION_LABEL : "";
  return redactEchoedValues(label);
}

/**
 * Post-submit evidence, read fresh right after a submit click -- re-tagging (tagAndReadFields)
 * immediately before this is called is what lets a field a dynamic widget only revealed after
 * the submit attempt (e.g. a dealer-selection widget's own hidden "committed" field) be seen at
 * all; without that re-tag, findInvalidFieldIds can only ever see fields that already existed
 * at the start of the run, and silently reports zero invalid fields even though the site
 * cancelled the submit.
 */
async function collectPostSubmitDiagnostics(form: Locator, dealerValueAlreadyVerified: boolean, hiddenStateBeforeFill: HiddenFieldStateEntry[] | null): Promise<PostSubmitDiagnostics> {
  await tagAndReadFields(form).catch(() => []);
  const invalidFieldIds = await findInvalidFieldIds(form).catch(() => []);
  const nativeValidationMessages = await form
    .evaluate((formEl: HTMLFormElement, attr: string) => {
      const messages: Record<string, string> = {};
      Array.from(formEl.querySelectorAll(`[${attr}]`)).forEach((el) => {
        const message = (el as HTMLInputElement).validationMessage;
        if (message) messages[el.getAttribute(attr) ?? ""] = message;
      });
      return messages;
    }, FIELD_INDEX_ATTR)
    .catch(() => ({}));
  const postSubmitValidationMessages = await form
    .evaluate((formEl: HTMLFormElement, scopeAttr: string) => {
      // A dealer widget's own live region announces the selected dealer's name/address; its
      // unresolved state is reported through unresolvedDependentControlIds instead.
      const nodes = Array.from(formEl.querySelectorAll('[role="alert"], [aria-live], .error, .error-message, .invalid-feedback')).filter((n) => !n.closest(`[${scopeAttr}]`));
      return nodes.map((n) => n.textContent?.trim() ?? "").filter((t) => t.length > 0);
    }, DEALER_SCOPE_ATTR)
    .catch(() => []);
  const sanitizedValidationMessages = postSubmitValidationMessages.map(redactEchoedValues);
  const sanitizedNativeMessages = Object.fromEntries(Object.entries(nativeValidationMessages).map(([k, v]) => [k, redactEchoedValues(v as string)]));
  const ariaInvalidFieldIds = await form
    .evaluate((formEl: HTMLFormElement, attr: string) => {
      const found: string[] = [];
      Array.from(formEl.querySelectorAll(`[${attr}]`)).forEach((el) => {
        if (el.getAttribute("aria-invalid") === "true") found.push(el.getAttribute(attr) ?? "");
      });
      return found;
    }, FIELD_INDEX_ATTR)
    .catch(() => []);
  const hiddenFieldEvidence = compareHiddenFieldState(hiddenStateBeforeFill, await readHiddenFieldState(form));
  const unresolvedDependentControlIds = await form
    .evaluate(
      (formEl: HTMLFormElement, attrs: { scopeAttr: string; resultSelector: string; dealerValueAlreadyVerified: boolean }) => {
        const unresolved: string[] = [];
        Array.from(formEl.querySelectorAll(`[${attrs.scopeAttr}]`)).forEach((scope) => {
          const scopedResults = Array.from(scope.querySelectorAll(attrs.resultSelector));
          // A scope with zero selectable results is not "nothing to check" -- it is the
          // strongest possible evidence that nothing was ever committed through a selectable
          // control, UNLESS resolveDealerLookup already verified this exact dependency through
          // a different, independently-trustworthy mechanism (a hidden-input commit) -- a
          // selectable-result scan can never see that, so it must defer to that verdict rather
          // than contradict it. Previously the zero-result case was skipped entirely, which left
          // a dealer-lookup scope that never surfaced a single selectable result silently
          // unflagged here, with no safety net independent of whatever resolveDealerLookup
          // itself had classified.
          if (scopedResults.length === 0) {
            if (!attrs.dealerValueAlreadyVerified) unresolved.push(scope.getAttribute(attrs.scopeAttr) ?? "");
            return;
          }
          const committed = scopedResults.some(
            (resultEl) =>
              (resultEl as HTMLInputElement).checked === true ||
              resultEl.getAttribute("aria-checked") === "true" ||
              resultEl.getAttribute("aria-selected") === "true",
          );
          if (!committed) unresolved.push(scope.getAttribute(attrs.scopeAttr) ?? "");
        });
        return unresolved;
      },
      { scopeAttr: DEALER_SCOPE_ATTR, resultSelector: DEALER_RESULT_SELECTOR, dealerValueAlreadyVerified },
    )
    .catch(() => []);

  const validationCauseObserved =
    invalidFieldIds.length > 0 ||
    ariaInvalidFieldIds.length > 0 ||
    postSubmitValidationMessages.length > 0 ||
    Object.keys(nativeValidationMessages).length > 0 ||
    unresolvedDependentControlIds.length > 0;

  return {
    invalidFieldIds,
    nativeValidationMessages: sanitizedNativeMessages,
    postSubmitValidationMessages: sanitizedValidationMessages,
    ariaInvalidFieldIds,
    hiddenFieldEvidence,
    unresolvedDependentControlIds,
    validationCauseObserved,
  };
}

async function detectCaptchaOnPage(page: Page): Promise<boolean> {
  const iframeSrcs = await page.evaluate(() => Array.from(document.querySelectorAll("iframe")).map((f) => f.getAttribute("src") ?? ""));
  const elementAttributes = await page.evaluate(() =>
    Array.from(document.querySelectorAll("[class],[data-sitekey]")).map((el) => `${el.className ?? ""} ${el.getAttribute("data-sitekey") ?? ""}`),
  );
  const visibleText = await page.evaluate(() => document.body.innerText).catch(() => "");
  return detectCaptcha({ iframeSrcs, elementAttributes, visibleText });
}

/** Total occurrences of confirmation vocabulary in the rendered (visible) text of the page and its
 * same-origin frames. Compared before and after submit, so only newly appeared confirmation counts. */
async function countConfirmationMarkers(page: Page): Promise<number> {
  let total = 0;
  let pageOrigin = "";
  try {
    pageOrigin = new URL(page.url()).origin;
  } catch {
    pageOrigin = "";
  }
  const frames = page.frames().filter((frame) => {
    if (frame === page.mainFrame()) return true;
    try {
      return new URL(frame.url()).origin === pageOrigin;
    } catch {
      return false;
    }
  });
  for (const frame of frames) {
    const text = await frame
      .evaluate(() => document.body?.innerText ?? "")
      .then((t) => t.toLowerCase())
      .catch(() => "");
    SUCCESS_TEXT_MARKERS.forEach((marker) => {
      total += text.split(marker).length - 1;
    });
  }
  return total;
}

async function captureAnalyticsPhase(page: Page, captures: Captures, stepIndex: number, captureModules: CaptureModuleName[]): Promise<void> {
  let detach: (() => void) | undefined;
  if (captureModules.includes("ga4_network_events")) {
    detach = attachGa4NetworkCapture(page, captures, () => stepIndex, { contextId: `fill_form:${stepIndex}` });
  }
  await page.waitForTimeout(300);
  detach?.();
  if (captureModules.includes("data_layer_evidence")) {
    const entries = await captureDataLayer(page, stepIndex, { contextId: `fill_form:${stepIndex}` });
    captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), ...entries];
  }
}

type SubmissionOutcome =
  | "succeeded"
  | "validation_failed"
  | "server_rejected"
  | "blocked_or_rate_limited"
  | "server_error"
  | "unconfirmed"
  | "cancelled_unknown_cause"
  | "cancelled_before_request";

type SubmissionServerResponseCategory = "no_request" | "accepted" | "server_validation_rejected" | "blocked_or_rate_limited" | "server_error" | "not_found" | "failed_or_pending";

/** Status-class reading of the non-tracking requests a submit click started -- never their bodies.
 * 404/405 mean the endpoint itself is missing, which says nothing about the submitted data, so they
 * are kept apart from a genuine validation rejection. */
function classifySubmissionResponses(requests: SanitizedNetworkRequestEvidence[]): SubmissionServerResponseCategory {
  if (requests.length === 0) return "no_request";
  const statuses = requests.map((r) => r.status).filter((st): st is number => st !== null);
  if (statuses.some((st) => st >= 500)) return "server_error";
  if (statuses.some((st) => st === 401 || st === 403 || st === 429)) return "blocked_or_rate_limited";
  if (statuses.some((st) => st === 400 || st === 409 || st === 422)) return "server_validation_rejected";
  if (statuses.some((st) => st === 404 || st === 405)) return "not_found";
  if (statuses.some((st) => st >= 200 && st < 300)) return "accepted";
  return "failed_or_pending";
}

function scorePlan(plan: PlannedField[]): number {
  return plan.filter((p) => p.decision.kind !== "skip").length;
}

export async function executeFillForm(params: ExecuteFillFormParams): Promise<ActionExecutorResult> {
  const { page, captures, stepIndex, captureModules, unmappedFieldResolver, selectionAmbiguityResolver, taskId, activeSurfaceInfo, submissionObservationConfig } = params;
  const fallbackFlagEnabled = params.optionalConsentOptInFallbackForTest === true;
  const journeyContext: FormJourneyContext = params.journeyContext ?? {};
  const diagnosticRunId = taskId ?? "unknown";
  logFormDiscoveryDiagnosticEnabled({ runId: diagnosticRunId, taskId: diagnosticRunId });

  /**
   * Builds and logs the opt-in formDiscoveryDebug payload (see src/diagnostics/
   * formDiscoveryDiagnostic.ts) for one exit point, a no-op when the env var is unset. Never
   * throws into the caller -- a diagnostic failure must never turn a real result into an error.
   */
  async function emitDiagnostic(
    captureStage: string,
    candidateIndexes: number[],
    scoresByIndex: Map<number, FormScoreBreakdown>,
    selection: {
      selectedFormIndex: number | null;
      runnerUpIndex: number | null;
      runnerUpScore: number | null;
      belowConfidenceThreshold: boolean;
      ambiguous: boolean;
      rejectionReason: string;
    },
  ): Promise<ActionExecutorResult["formDiscoveryDebug"]> {
    if (!isFormDiscoveryDiagnosticEnabled()) return undefined;
    try {
      const debug = await buildFormDiscoveryDebug({
        page,
        taskId: diagnosticRunId,
        journeyContext,
        currentLastClickLabel: journeyContext.previousActionLabel,
        activeSurfaceInfo,
        captureStage,
        candidateIndexes,
        scoresByIndex,
        selection,
      });
      logFormDiscoveryDiagnosticEmitted({ runId: diagnosticRunId, taskId: diagnosticRunId, failureReason: captureStage });
      await writeFormDiscoveryDebugBackup(debug);
      return debug;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("FORM_DISCOVERY_DIAGNOSTIC_BUILD_FAILED", e);
      return undefined;
    }
  }

  if (await detectCaptchaOnPage(page)) {
    return { success: false, formFillOutcome: "blocked_captcha" };
  }

  const htmlLang = await page.evaluate(() => document.documentElement.lang || undefined).catch(() => undefined);
  const actionMarketParam = typeof params.action?.params?.market === "string" ? (params.action.params.market as string) : undefined;
  const language: SupportedLanguage = detectPageLanguage(htmlLang);
  const market = resolveMarket(language, actionMarketParam);

  // A generic location/postcode gate (see actions/locationGate.ts) can block the rest of the
  // page's content entirely, including the lead form itself -- resolved first, using the
  // task's own existing configured workflow postcode, before even counting <form> elements
  // (the gate's own input deliberately lives outside any <form>, so a page showing only a gate
  // and no lead form yet would otherwise hit the "no form found" branch below without ever
  // being given the chance to pass it).
  const locationGateOutcome: LocationGateOutcome = await resolveLocationGate(page, market, marketDataFor(market).postcode, language);

  const forms = page.locator("form");
  const formsOnPage = await forms.count();
  if (formsOnPage === 0) {
    const formDiscoveryDebug = await emitDiagnostic("no_form_found", [], new Map(), {
      selectedFormIndex: null,
      runnerUpIndex: null,
      runnerUpScore: null,
      belowConfidenceThreshold: false,
      ambiguous: false,
      rejectionReason: "no <form> element on the page",
    });
    return { success: false, error: "no_form_found", formLocationGateDiagnostics: locationGateOutcome, formDiscoveryDebug };
  }

  /**
   * A page can have several <form> elements (search, newsletter, cookie/consent, the actual
   * lead form) in any document order. Field count alone is not a reliable signal -- a
   * newsletter signup can easily have more fillable fields than the correct request-a-quote
   * form (the production bug this scoring replaced). Every candidate is scored on journey
   * relevance (does its own text match the objective/active-milestone/previous-CTA anchors,
   * and generic request-a-quote/offer/test-drive/contact vocabulary, never newsletter/search/
   * login vocabulary), visual prominence (visible, in the main content area, a reasonably
   * large area, a nearby heading, a visible submit control), and field actionability as
   * supporting evidence only -- see forms/formRelevance.ts.
   */
  const pageSignals = await gatherSemanticPageSignals(page);
  const candidateEvidence: {
    index: number;
    hasCountryCodeSelector: boolean;
    dealerSearchWidgetDetected: boolean;
    textSignals: FormTextSignals;
    score: ReturnType<typeof computeFormScore>;
    /** The real per-candidate field count, independent of what a form_discovery_failed branch below reports -- see the misleading-reporting fix below. */
    realFieldsDiscovered: number;
    /** The real per-candidate count of visible, required fields -- same reporting-accuracy fix. */
    realRequiredFieldsDetected: number;
  }[] = [];
  for (let i = 0; i < formsOnPage; i += 1) {
    const candidate = forms.nth(i);
    const hasCountryCodeSelectorCandidate = (await candidate.locator('select[name*="country" i], select[name*="dial" i]').count()) > 0;
    const { fields: raw } = await tagAndReadFieldsWithDealerLookup(candidate);
    const descriptors = raw.map(toDescriptor);
    // Structural, generic, per-field dealer-lookup detection (see dealerLookup.ts) -- never a
    // form-wide flag, since a form can have two postcode-purpose fields (a plain customer-
    // address postcode and a dealer-locator postcode/city) sharing identical label vocabulary.
    const dealerSearchWidgetDetectedCandidate = descriptors.some((d) => Boolean(d.dealerLookupTriggerIndex));
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector: hasCountryCodeSelectorCandidate });
    const actionableFieldCount = scorePlan(plan);
    const formSignals = await gatherFormSignals(candidate);

    const textSignals: FormTextSignals = {
      pageTitle: pageSignals.title,
      pageHeadings: pageSignals.headings,
      nearestHeadingText: formSignals.nearestHeadingText,
      submitButtonText: formSignals.submitButtonText,
      formAttributesText: formSignals.formAttributesText,
    };
    const visibilitySignals: FormVisibilityProminenceSignals = {
      visible: formSignals.visible,
      inChrome: formSignals.inChrome,
      areaRatio: formSignals.areaRatio,
      hasNearbyHeading: formSignals.hasNearbyHeading,
      hasVisibleSubmitButton: formSignals.hasVisibleSubmitButton,
    };

    candidateEvidence.push({
      index: i,
      hasCountryCodeSelector: hasCountryCodeSelectorCandidate,
      dealerSearchWidgetDetected: dealerSearchWidgetDetectedCandidate,
      textSignals,
      realFieldsDiscovered: descriptors.length,
      realRequiredFieldsDetected: descriptors.filter((d) => d.required && isFillTarget(d)).length,
      score: computeFormScore({
        journeyContext,
        textSignals,
        visibilitySignals,
        fieldsDiscovered: descriptors.length,
        actionableFieldCount,
      }),
    });
  }

  const candidates: FormCandidate[] = candidateEvidence.map((c) => ({ index: c.index, score: c.score }));
  let selection = selectBestForm(candidates);

  if (selection.ambiguous && selectionAmbiguityResolver) {
    const resolved = await resolveAmbiguousFormSelection(
      { candidates: candidateEvidence.map((c) => ({ index: c.index, textSignals: c.textSignals, score: c.score })), journeyContext },
      selectionAmbiguityResolver,
    );
    if (resolved) {
      selection = {
        ...selection,
        chosenIndex: resolved.chosenIndex,
        ambiguous: false,
        selectedFormReason: `Claude-assisted tiebreak (independently verified): ${resolved.rationale}`,
      };
    }
  }

  const chosenEvidence = candidateEvidence.find((c) => c.index === selection.chosenIndex)!;
  const formSelectionDiagnostics = {
    journeyRelevanceScore: chosenEvidence.score.journeyRelevanceScore,
    visibilityProminenceScore: chosenEvidence.score.visibilityProminenceScore,
    fieldActionabilityScore: chosenEvidence.score.fieldActionabilityScore,
    totalFormScore: chosenEvidence.score.totalFormScore,
    selectedFormReason: selection.selectedFormReason,
    rejectedFormsAndReasons: selection.rejectedFormsAndReasons,
  };

  // Safety: an ambiguous selection the resolver couldn't (or wasn't asked to) resolve is
  // never guessed away, and a selection below the confidence threshold is never filled or
  // submitted at all -- "do not submit when confidence is below a defined threshold".
  if (selection.belowConfidenceThreshold || selection.ambiguous) {
    const runnerUp = selection.rejectedFormsAndReasons[0];
    const formDiscoveryDebug = await emitDiagnostic(
      "form_discovery_failed:below_confidence_or_ambiguous",
      candidateEvidence.map((c) => c.index),
      new Map(candidateEvidence.map((c) => [c.index, c.score])),
      {
        selectedFormIndex: selection.chosenIndex,
        runnerUpIndex: runnerUp?.index ?? null,
        runnerUpScore: runnerUp?.totalFormScore ?? null,
        belowConfidenceThreshold: selection.belowConfidenceThreshold,
        ambiguous: selection.ambiguous,
        rejectionReason: selection.selectedFormReason,
      },
    );
    return {
      success: false,
      formFillOutcome: "form_discovery_failed",
      formMarketDetected: market,
      formLanguageDetected: language,
      formLocationGateDiagnostics: locationGateOutcome,
      formDiscoveryDebug,
      formDiscoveryDiagnostics: {
        formsOnPage,
        selectedFormIndex: selection.chosenIndex,
        // Corrected reporting: the candidate's real discovered/required-field counts, not a
        // hard-coded 0 -- selection being rejected (belowConfidenceThreshold/ambiguous) never
        // implies the candidate had no fields; it means no fill/submit was attempted on it.
        fieldsDiscovered: chosenEvidence.realFieldsDiscovered,
        requiredFieldsDetected: chosenEvidence.realRequiredFieldsDetected,
        requiredFieldsFilled: 0,
        dealerSearchWidgetDetected: chosenEvidence.dealerSearchWidgetDetected,
        unmappedRequiredFieldIds: [],
        skippedFieldReasons: [],
        fieldDiagnostics: [],
        ...formSelectionDiagnostics,
        selectedFormReason: selection.ambiguous
          ? `ambiguous: ${selection.selectedFormReason} (no verified tiebreak available)`
          : selection.selectedFormReason,
      },
    };
  }

  const form = forms.nth(selection.chosenIndex);
  const hasCountryCodeSelector = chosenEvidence.hasCountryCodeSelector;
  const preSubmitHiddenSnapshot = await readHiddenFieldState(form);
  const submitProbeInstalled = await installSubmitProbe(page);
  const fillStartSnapshot = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());

  const fieldsFilled = new Set<string>();
  let claudeCallUsed = false;
  let retries = 0;
  let dealerLookupOutcome: DealerLookupOutcome | undefined;
  // Diagnostic-only (see diagnostics/dealerLookupDiagnostic.ts): the trigger-to-field association
  // trace captured from the chosen form's very first full field pass only -- never from a later
  // partial catch-up/poll pass (onlyIndices set), which only re-reads a subset of fields and would
  // give an incomplete picture of every candidate pair considered.
  let dealerLookupDebugCapture: { triggerCandidates: Awaited<ReturnType<typeof tagAndReadFieldsWithDealerLookup>>["triggerCandidates"]; pairDebug: TriggerFieldPairDebug[] } | undefined;

  const proxiedSelectOutcomes = new Map<string, ProxiedSelectOutcome>();
  const checkboxActivations = new Map<string, "native_check" | "label_click">();

  async function fillAllRequired(onlyIndices?: Set<string>): Promise<{ plan: PlannedField[]; filledIds: Set<string> }> {
    const shouldCollectDebug = !onlyIndices && !dealerLookupDebugCapture && isFormDiscoveryDiagnosticEnabled();
    const { fields: raw, triggerCandidates, pairDebug } = await tagAndReadFieldsWithDealerLookup(form, shouldCollectDebug);
    if (shouldCollectDebug) {
      dealerLookupDebugCapture = { triggerCandidates, pairDebug };
    }
    const descriptors = raw.map(toDescriptor).filter((d) => !onlyIndices || onlyIndices.has(d.id));
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector });
    const filledIds = new Set<string>();

    const needingClaude = plan.filter((p) => p.decision.kind === "needs_claude");
    let resolved: Map<string, string> | undefined;
    if (needingClaude.length > 0 && unmappedFieldResolver) {
      claudeCallUsed = true;
      const resolutions = await unmappedFieldResolver.resolve(
        needingClaude.map((p) => p.descriptor),
        { language, market },
      );
      resolved = new Map(resolutions.map((r) => [r.fieldId, r.value]));
    }

    for (const plannedField of plan) {
      if (plannedField.decision.kind === "needs_claude") {
        const value = resolved?.get(plannedField.descriptor.id);
        if (value !== undefined) {
          const field = await fieldByIndex(form, plannedField.descriptor.id);
          await field.fill(value);
          fieldsFilled.add("claude_resolved");
          filledIds.add(plannedField.descriptor.id);
        }
        continue;
      }
      // A field already carrying a genuine, non-placeholder value (e.g. a model/engine select
      // the page itself preselected before this action ran) needs no action from this engine
      // at all -- counting it as resolved here is what "preserve a valid preselection" actually
      // means for the readiness gate below, which otherwise has no other way to know a required
      // field it never touched is already satisfied.
      if (plannedField.decision.kind === "skip" && plannedField.decision.reason === "prefilled") {
        filledIds.add(plannedField.descriptor.id);
        continue;
      }
      const outcome = await applyDecision(page, form, plannedField, hasCountryCodeSelector, language);
      if (outcome.dealerLookup) dealerLookupOutcome = outcome.dealerLookup;
      if (outcome.proxiedSelect) proxiedSelectOutcomes.set(outcome.proxiedSelect.fieldId, outcome.proxiedSelect);
      if (outcome.checkboxActivation) checkboxActivations.set(plannedField.descriptor.id, outcome.checkboxActivation);
      if (outcome.key) {
        fieldsFilled.add(outcome.key);
        filledIds.add(plannedField.descriptor.id);
      }
    }
    return { plan, filledIds };
  }

  let { plan: initialPlan, filledIds: initialFilledIds } = await fillAllRequired();

  // Generic dependent-control catch-up: selecting one <select> can cause the page's own JS to
  // populate or enable a DEPENDENT <select> (e.g. a narrower choice whose options only exist
  // once a broader one is picked) that had no selectable options at the initial scan. Bounded
  // polling re-checks every still-required, still-unfilled select within a bounded budget --
  // never brand/field-specific, just re-running the same generic fill plan against freshly-read
  // options. An empty poll does not end it: the page's own population delay can outlast one poll
  // interval, which made this a timing race on a loaded machine.
  const MAX_DEPENDENT_SELECT_POLLS = 10;
  for (let attempt = 0; attempt < MAX_DEPENDENT_SELECT_POLLS; attempt += 1) {
    const pendingSelectIds = new Set(
      initialPlan
        .filter((p) => p.descriptor.tagName === "select" && p.descriptor.required && isFillTarget(p.descriptor) && !initialFilledIds.has(p.descriptor.id))
        .map((p) => p.descriptor.id),
    );
    if (pendingSelectIds.size === 0) break;
    await page.waitForTimeout(150);
    const { plan: pollPlan, filledIds: pollFilledIds } = await fillAllRequired(pendingSelectIds);
    if (pollFilledIds.size === 0) continue;
    initialFilledIds = new Set([...initialFilledIds, ...pollFilledIds]);
    const pollById = new Map(pollPlan.map((p) => [p.descriptor.id, p]));
    initialPlan = initialPlan.map((p) => pollById.get(p.descriptor.id) ?? p);
  }

  const dealerFieldPlanned = initialPlan.find((p) => p.matchedField === "dealerSearch");
  const customerPostcodeFieldPlanned = initialPlan.find((p) => p.matchedField === "postcode" && p.decision.kind === "fill_text");
  const dealerFieldHasAdjacentControl =
    dealerFieldPlanned !== undefined && dealerFieldPlanned.decision.kind === "dealer_search" && Boolean(dealerFieldPlanned.decision.triggerIndex);
  // Safety net, independent of the structural detection above: if structural detection missed a
  // real dealer-lookup field (e.g. the trigger/field association never fired), it is very likely
  // that more than one field still matched the generic "postcode" purpose and stayed a plain
  // fill_text decision -- a real customer-address postcode plus the missed dealer-locator one.
  // Typed postcode text alone must never be read as a resolved dealer dependency.
  const plainPostcodeFieldsPlanned = initialPlan.filter((p) => p.matchedField === "postcode" && p.decision.kind === "fill_text");
  const multiplePostcodeFieldsUnresolved = plainPostcodeFieldsPlanned.length > 1;
  const dealerDiscoveryDiagnostics = {
    customerPostcodeFieldDetected: Boolean(customerPostcodeFieldPlanned),
    dealerLookupFieldDetected: Boolean(dealerFieldPlanned),
    dealerLookupFieldEvidence: dealerFieldPlanned
      ? `field "${dealerFieldPlanned.descriptor.label || dealerFieldPlanned.descriptor.id}" matched the dealer-lookup postcode/city purpose`
      : "",
    dealerLookupControlDetected: dealerFieldHasAdjacentControl,
    dealerLookupControlEvidence: dealerFieldPlanned
      ? dealerFieldHasAdjacentControl
        ? "a structurally-adjacent lookup control (generic search/find/go/ok/select/choose vocabulary) was found next to this field"
        : "the field matched dealer-lookup vocabulary directly; no adjacent lookup control was structurally found, falling back to Enter"
      : "",
    multiplePostcodeFieldsUnresolved,
    multiplePostcodeFieldsEvidence: multiplePostcodeFieldsUnresolved
      ? `${plainPostcodeFieldsPlanned.length} fields (${plainPostcodeFieldsPlanned.map((p) => p.descriptor.id).join(",")}) matched the postcode purpose and none was upgraded to dealer_search -- a dependent-location dependency cannot be ruled out from typed postcode text alone`
      : "",
  };

  // Resolve every currently-visible consent radio group (see forms/consentGroups.ts) before
  // computing final discovery diagnostics -- a consent question is very often expressed as
  // Oui/Non-style radios whose own option labels carry no matchable keyword at all, so this never
  // goes through the per-field matchLeadFormField pipeline above.
  const consentResult = await resolveConsentGroups(page, form, language, fieldByIndex, journeyContext);
  const preSubmitActionableOptional = consentResult.consentGroupDiagnostics.filter((g) => OPTIONAL_COMMERCIAL_PURPOSES.has(g.purpose)).length;
  const preSubmitNonActionableOptional: ConsentGroupRejection[] = consentResult.consentGroupRejections.filter(
    (r) => OPTIONAL_COMMERCIAL_PURPOSES.has(r.purpose) && r.rejectionStage !== "responsive_dedupe",
  );

  // Consent selections (or the dealer lookup) can generically reveal new required text/select
  // fields -- one bounded catch-up pass, filling only fields not already resolved, so a field a
  // widget only reveals after an earlier interaction is never invisible to the readiness gate.
  const { fields: rawAfterConsent } = await tagAndReadFieldsWithDealerLookup(form);
  const descriptorsAfterConsent = rawAfterConsent.map(toDescriptor);
  const newlyRequiredIds = new Set(
    descriptorsAfterConsent.filter((d) => d.required && isFillTarget(d) && !initialFilledIds.has(d.id)).map((d) => d.id),
  );
  let finalFilledIds = initialFilledIds;
  if (newlyRequiredIds.size > 0) {
    const { filledIds: catchUpFilledIds } = await fillAllRequired(newlyRequiredIds);
    finalFilledIds = new Set([...initialFilledIds, ...catchUpFilledIds]);
  }

  const requiredFields = initialPlan.filter((p) => p.descriptor.required && isFillTarget(p.descriptor));
  const requiredFieldsFilled = requiredFields.filter((p) => finalFilledIds.has(p.descriptor.id)).length;
  const actionableFields = initialPlan.filter((p) => p.decision.kind !== "skip");
  const formDiscoveryDiagnostics = {
    formsOnPage,
    selectedFormIndex: selection.chosenIndex,
    fieldsDiscovered: initialPlan.length,
    requiredFieldsDetected: requiredFields.length,
    requiredFieldsFilled,
    dealerSearchWidgetDetected: dealerDiscoveryDiagnostics.dealerLookupFieldDetected,
    unmappedRequiredFieldIds: requiredFields.filter((p) => !finalFilledIds.has(p.descriptor.id)).map((p) => p.descriptor.id),
    skippedFieldReasons: initialPlan
      .filter((p): p is PlannedField & { decision: { kind: "skip"; reason: string } } => p.decision.kind === "skip")
      .map((p) => ({ id: p.descriptor.id, reason: p.decision.reason })),
    fieldDiagnostics: initialPlan.map((p) => ({
      id: p.descriptor.id,
      label: diagnosticFieldLabel(p.descriptor.label ?? "", p.descriptor.type),
      type: p.descriptor.tagName === "input" ? p.descriptor.type ?? "text" : p.descriptor.tagName,
      visible: p.descriptor.visible,
      requiredEvidence: p.descriptor.requiredEvidence ?? "none",
      valueState: (p.descriptor.isPlaceholderMimicry
        ? "placeholder_mimicry"
        : p.descriptor.currentValue.trim().length > 0
          ? "has_value"
          : "empty") as "empty" | "has_value" | "placeholder_mimicry",
      matchedField: p.matchedField,
      decision: p.decision.kind,
      filled: finalFilledIds.has(p.descriptor.id),
    })),
    proxiedSelectDiagnostics: [...proxiedSelectOutcomes.values()],
    ...formSelectionDiagnostics,
  };

  function buildDealerSearchDiagnostics(): DealerSearchDiagnostics {
    return {
      ...EMPTY_DEALER_SEARCH_DIAGNOSTICS,
      ...dealerDiscoveryDiagnostics,
      ...(dealerLookupOutcome ? dealerOutcomeToDiagnostics(dealerLookupOutcome) : {}),
    };
  }

  // Safety: never submit having filled nothing. The chosen form's fieldActionabilityScore
  // (computed at selection time, before any fill attempt) and the actual post-fill-attempt
  // outcome are checked independently -- either one alone catching zero fillable/filled
  // fields is enough to stop here, rather than only the narrower "detected >=1 required
  // field but filled none" case, which a required-detection gap (or any other discovery
  // miss) can silently defeat by making requiredFields.length itself 0.
  if (
    formSelectionDiagnostics.fieldActionabilityScore === 0 ||
    actionableFields.length === 0 ||
    finalFilledIds.size === 0 ||
    (requiredFields.length > 0 && requiredFieldsFilled === 0)
  ) {
    const runnerUpZero = selection.rejectedFormsAndReasons[0];
    const formDiscoveryDebug = await emitDiagnostic(
      "form_discovery_failed:zero_actionable_or_filled",
      candidateEvidence.map((c) => c.index),
      new Map(candidateEvidence.map((c) => [c.index, c.score])),
      {
        selectedFormIndex: selection.chosenIndex,
        runnerUpIndex: runnerUpZero?.index ?? null,
        runnerUpScore: runnerUpZero?.totalFormScore ?? null,
        belowConfidenceThreshold: false,
        ambiguous: false,
        rejectionReason:
          formSelectionDiagnostics.fieldActionabilityScore === 0
            ? "selected form's fieldActionabilityScore is 0"
            : actionableFields.length === 0
              ? "zero actionable fields in the fill plan"
              : finalFilledIds.size === 0
                ? "zero fields were actually filled"
                : "required fields were detected but none were filled",
      },
    );
    return {
      success: false,
      formFillOutcome: "form_discovery_failed",
      formMarketDetected: market,
      formLanguageDetected: language,
      formLocationGateDiagnostics: locationGateOutcome,
      formClaudeCallUsed: claudeCallUsed,
      formDiscoveryDiagnostics,
      formDiscoveryDebug,
    };
  }

  // "Never submit when the page indicates a dealer-selection step but no dealer selection has
  // been verified" -- rather than submitting anyway and retrying afterwards (the old, user-
  // rejected behaviour that let a site's own client-side cancellation reach production), the
  // dealer lookup itself is retried, bounded, BEFORE Submit is ever clicked. Only once it
  // verifies (or the bound is exhausted, in which case Submit is never clicked at all) does
  // control reach the readiness gate below.
  // A retry runs only when resolveDealerLookup reported a deterministic correction -- today, only
  // "a lookup request was observably still in flight", answered by re-polling without re-entering
  // the value. Re-running the identical input sequence after a lookup that completed without a
  // result would reproduce the same evidence while resetting the widget, so it is never done.
  while (
    dealerLookupOutcome !== undefined &&
    dealerLookupOutcome.dealerLookupTriggered &&
    !dealerLookupOutcome.dealerValueVerified &&
    dealerLookupOutcome.executionTrace.retryRecommendation !== "none" &&
    retries < MAX_RETRIES
  ) {
    retries += 1;
    await rerunDealerSearch(dealerLookupOutcome.executionTrace.retryRecommendation);
  }
  const dealerRetryExplanation =
    dealerLookupOutcome && !dealerLookupOutcome.dealerValueVerified
      ? dealerLookupOutcome.executionTrace.retryRecommendation === "none"
        ? `no deterministic correction available (${dealerLookupOutcome.executionTrace.lookupFailureClassification ?? "unclassified"})`
        : "the lookup was still in flight after the bounded re-polls"
      : "";

  // Generic pre-submit readiness gate (see the "Required implementation" spec this follows):
  // submit is allowed only when every required text/select field resolved, the dealer dependency
  // (if any) is resolved and verified, and every currently-visible required consent group is
  // resolved. A failure here means submit is never clicked at all.
  const unresolvedRequiredFinal = descriptorsAfterConsent.filter((d) => d.required && isFillTarget(d) && !finalFilledIds.has(d.id));
  const afterFillSnapshot = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());
  const dealerDependencyUnresolved =
    dealerLookupOutcome !== undefined && dealerLookupOutcome.dealerLookupTriggered && !dealerLookupOutcome.dealerValueVerified;
  const preSubmitReadinessFailures: string[] = [];
  if (unresolvedRequiredFinal.length > 0) {
    preSubmitReadinessFailures.push(`unresolved_required_fields:${unresolvedRequiredFinal.map((d) => d.id).join(",")}`);
  }
  if (dealerDependencyUnresolved) {
    preSubmitReadinessFailures.push("dealer_dependency_unresolved");
  }
  if (multiplePostcodeFieldsUnresolved) {
    preSubmitReadinessFailures.push(`multiple_postcode_fields_unresolved:${plainPostcodeFieldsPlanned.map((p) => p.descriptor.id).join(",")}`);
  }
  if (consentResult.unresolvedRequiredConsentGroups.length > 0) {
    preSubmitReadinessFailures.push(`unresolved_required_consent_groups:${consentResult.unresolvedRequiredConsentGroups.join(",")}`);
  }
  const preSubmitReadinessPassed = preSubmitReadinessFailures.length === 0;

  if (!preSubmitReadinessPassed) {
    const dealerLookupTrace = await buildDealerLookupTrace({
      page,
      form,
      taskId: diagnosticRunId,
      captureStage: "pre_submit_readiness_failed",
      plan: initialPlan,
      triggerCandidates: dealerLookupDebugCapture?.triggerCandidates ?? [],
      pairDebug: dealerLookupDebugCapture?.pairDebug ?? [],
      dealerLookupOutcome,
      preSubmitReadinessPassed: false,
      preSubmitReadinessFailures,
    }).catch(() => undefined);
    return {
      success: false,
      formFillOutcome: "form_validation_failed",
      formRetriesUsed: retries,
      formValidationMissingFields: unresolvedRequiredFinal.map((d) => d.id),
      formFieldsFilled: [...fieldsFilled],
      formMarketDetected: market,
      formLanguageDetected: language,
      formLocationGateDiagnostics: locationGateOutcome,
      formClaudeCallUsed: claudeCallUsed,
      formDiscoveryDiagnostics,
      formDealerSearchDiagnostics: buildDealerSearchDiagnostics(),
      formConsentDiagnostics: consentResult,
      dealerLookupTrace,
      formPostSubmitDiagnostics: {
        submitCanceled: true,
        invalidFieldIds: unresolvedRequiredFinal.map((d) => d.id),
        nativeValidationMessages: {},
        postSubmitValidationMessages: [],
        ariaInvalidFieldIds: [],
        hiddenFieldEvidence: [],
        unresolvedDependentControlIds: [],
        validationCauseObserved: true,
        retryDecision: dealerDependencyUnresolved
          ? `not retried further: submit was never attempted after ${retries}/${MAX_RETRIES} dealer-lookup retries, the dependency never verified -- ${dealerRetryExplanation}`
          : multiplePostcodeFieldsUnresolved
            ? "not retried: submit was never attempted, the pre-submit readiness gate failed (multiple unresolved postcode-purpose fields)"
            : "not retried: submit was never attempted, the pre-submit readiness gate failed",
        preSubmitReadinessPassed: false,
        preSubmitReadinessFailures,
        submitAttempted: false,
        submitControlIdentity: "not_applicable: submit was never attempted",
        submitActivationMethod: null,
        submissionRequestStarted: false,
        submissionNetworkRequests: [] as SanitizedNetworkRequestEvidence[],
        submissionCanceledBeforeRequest: true,
        submitControlEnabled: null,
        submissionServerResponseCategory: "no_request" as const,
        validationSurfaceDetected: false,
        validationSurfaceType: null as "field_validation" | "visible_message" | "unresolved_dependent_control" | null,
        dealerCommitEvidence: dealerLookupOutcome?.executionTrace.hiddenFieldCommitDetected ?? null,
        submissionOutcome: "cancelled_before_request" as const,
        submissionOutcomeReason: "the pre-submit readiness gate failed, so submit was never clicked at all",
        retryEligible: false,
        retryReason: dealerDependencyUnresolved
          ? `not retried further: submit was never attempted after ${retries}/${MAX_RETRIES} dealer-lookup retries, the dependency never verified -- ${dealerRetryExplanation}`
          : multiplePostcodeFieldsUnresolved
            ? "not retried: submit was never attempted, the pre-submit readiness gate failed (multiple unresolved postcode-purpose fields)"
            : "not retried: submit was never attempted, the pre-submit readiness gate failed",
        postSubmitObservation: null,
        submitAttemptSummary: submitNeverAttemptedSummary(
          fallbackFlagEnabled,
          firstAttemptConsentModeOf(preSubmitActionableOptional, preSubmitNonActionableOptional.length),
          consentResult.optionalDeclineNotCommittedGroups.length === 0,
          { actionable: preSubmitActionableOptional, nonActionable: preSubmitNonActionableOptional },
        ),
      },
    };
  }

  const submitControl = await findSubmitControl(form);
  if (!submitControl) {
    return { success: false, error: "no_submit_control_found", formDiscoveryDiagnostics };
  }
  const submit: Locator = submitControl;

  const beforeUrl = page.url();

  // Generic descriptor of the control actually activated -- tag/type and its own static button
  // text (never a typed or submitted value), so a cancellation's diagnostics can at least say
  // what was clicked without guessing from a brand-specific selector.
  const submitControlIdentity = await submit
    .evaluate((el: Element) => {
      const tag = el.tagName.toLowerCase();
      const type = (el as HTMLInputElement).type ?? "";
      const text = (el.textContent ?? (el as HTMLInputElement).value ?? "").trim().slice(0, 60);
      return `${tag}${type ? `[type="${type}"]` : ""}${text ? `:"${text}"` : ""}`;
    })
    .catch(() => "unknown");
  const submitActivationMethod = "click" as const;

  async function rerunDealerSearch(mode: "full" | "await_pending_lookup"): Promise<void> {
    const { fields: raw } = await tagAndReadFieldsWithDealerLookup(form);
    const descriptors = raw.map(toDescriptor);
    const plan = buildFillPlan(descriptors, { language, market, hasCountryCodeSelector });
    // The field already holds the typed value by now, so a fresh plan classifies it "prefilled"
    // and drops the dealer_search decision; without falling back to the original decision every
    // retry silently did nothing.
    const freshDescriptor = dealerFieldPlanned ? descriptors.find((d) => d.id === dealerFieldPlanned.descriptor.id) : undefined;
    const dealerField =
      plan.find((p) => p.decision.kind === "dealer_search") ??
      (dealerFieldPlanned && freshDescriptor && dealerFieldPlanned.decision.kind === "dealer_search"
        ? { ...dealerFieldPlanned, descriptor: freshDescriptor }
        : undefined);
    if (!dealerField) return;
    const outcome = await applyDecision(page, form, dealerField, hasCountryCodeSelector, language, mode);
    if (outcome.dealerLookup) dealerLookupOutcome = outcome.dealerLookup;
  }

  const observationConfig = resolveSubmissionObservationConfig(submissionObservationConfig);
  // With the test-only opt-in enabled, a silent first attempt is the one case that can lead to a
  // second Submit, so it is watched up to the hard cap: a confirmation arriving after the 50 s
  // minimum must never be mistaken for a cancellation and answered with a duplicate lead.
  const firstAttemptConfig: SubmissionObservationConfig = fallbackFlagEnabled ? { ...observationConfig, baseWindowMs: observationConfig.hardCapMs } : observationConfig;

  const attemptRecords: SubmitAttemptStateRecord[] = [];

  /**
   * A later attempt never trusts what the earlier one left behind: the form is re-tagged from the
   * live DOM (a site may have re-rendered or replaced it), and any required control that was
   * committed before the previous Submit but no longer is gets filled again -- the same fill, not
   * another Submit.
   */
  async function refreshStateBeforeAttempt(): Promise<SecondAttemptStateRefresh> {
    await tagAndReadFields(form).catch(() => []);
    const previous = attemptRecords[attemptRecords.length - 1]?.beforeSubmit?.controls ?? null;
    const current = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());
    const previouslyCommitted = new Set((previous ?? []).filter((c) => c.committed).map((c) => c.fieldId));
    const stale = current ? requiredUncommitted(current.controls).filter((id) => previouslyCommitted.has(id)) : [];
    let refilled: string[] = [];
    if (stale.length > 0) {
      const { filledIds } = await fillAllRequired(new Set(stale));
      refilled = [...filledIds];
    }
    return { fieldsRetagged: true, staleRequiredFieldIds: stale, refilledFieldIds: refilled };
  }

  async function attemptSubmit(config: SubmissionObservationConfig): Promise<{
    postSubmit: PostSubmitDiagnostics;
    succeeded: boolean;
    afterUrl: string;
    networkRequests: SanitizedNetworkRequestEvidence[];
    businessRequests: SanitizedNetworkRequestEvidence[];
    submitControlEnabled: boolean;
    submitBlockedBeforeClick: boolean;
    confirmationAppeared: boolean;
    observation: PostSubmitObservation | null;
  }> {
    const attemptNumber = attemptRecords.length + 1;
    const refresh = attemptNumber > 1 ? await refreshStateBeforeAttempt() : null;
    if (attemptNumber === 1) await tagAndReadFields(form).catch(() => []);
    const beforeSubmit = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());
    const record: SubmitAttemptStateRecord = { attempt: attemptNumber, beforeSubmit, afterCancellation: null, classification: null, refresh };
    attemptRecords.push(record);
    // A control disabled until the last field's change/blur fires is a real pattern: give the
    // page that one commit event, briefly and bounded, instead of letting click() wait out its
    // ~30s actionability timeout and then throw with no diagnosable cause.
    let submitControlEnabled = await submit.isEnabled().catch(() => false);
    if (!submitControlEnabled) {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});
      const deadline = Date.now() + 1500;
      while (!submitControlEnabled && Date.now() < deadline) {
        await page.waitForTimeout(150);
        submitControlEnabled = await submit.isEnabled().catch(() => false);
      }
    }
    if (!submitControlEnabled) {
      const postSubmit = await collectPostSubmitDiagnostics(form, dealerLookupOutcome?.dealerValueVerified ?? false, preSubmitHiddenSnapshot);
      record.afterCancellation = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());
      record.classification = {
        ...classifyClientSideCancellation({
          attempt: attemptNumber,
          probe: null,
          pageUrl: beforeUrl,
          formActionUrl: null,
          businessRequestObservedOnNetwork: false,
          succeeded: false,
          challengeDetected: false,
          requiredAcknowledgementUncheckedIds: beforeSubmit ? requiredAcknowledgementUnchecked(beforeSubmit.controls) : [],
          requiredUncommittedFieldIds: beforeSubmit ? requiredUncommitted(beforeSubmit.controls) : [],
        }),
        cancellationStage: "submit_event_never_fired",
        cancellationReason: "the Submit control stayed disabled after a final commit event, so it was never clicked",
      };
      return {
        postSubmit,
        succeeded: false,
        afterUrl: page.url(),
        networkRequests: [],
        businessRequests: [],
        submitControlEnabled,
        submitBlockedBeforeClick: true,
        confirmationAppeared: false,
        observation: null,
      };
    }
    const confirmationBefore = await countConfirmationMarkers(page);
    const formActionUrl = await form
      .evaluate((el: Element) => {
        const action = el.getAttribute("action");
        if (!action) return null;
        try {
          return new URL(action, document.baseURI).href;
        } catch {
          return null;
        }
      })
      .catch(() => null);
    // Marked before the observer starts, so the probe's own attribute writes never count as page activity.
    await beginProbeAttempt(page, form, submit, attemptNumber);
    const { ariaInvalidBefore } = await installSubmissionObserver(form, submit);
    // Started before the click -- correlates purely by "happened during this submit attempt's
    // window", never by URL/brand. Never a request/response body, never a typed or submitted value.
    const capture = startDealerLookupNetworkCapture(page, { includeDocumentRequests: true });
    capture.setStep("submit_click");
    await submit.click({ timeout: 10_000 }).catch(() => {});
    const { observation, urlChanged, confirmationAppeared: observedConfirmation } = await observeSubmissionOutcome({
      page,
      capture,
      beforeUrl,
      formActionUrl,
      confirmationBefore,
      ariaInvalidBefore,
      countConfirmationMarkers,
      detectChallenge: detectCaptchaOnPage,
      config,
    });
    const allRequests = [...capture.snapshot()];
    const networkRequests = await capture.stop().catch(() => []);
    const businessRequests = selectBusinessRequests(allRequests, { pageUrl: beforeUrl, formActionUrl });
    const afterUrl = page.url();
    // A URL change already proves the submit went through -- `form` now refers to whatever
    // (if anything) matches the same index on the page we navigated to, not the form that was
    // submitted, so reading post-submit diagnostics from it here would just be evaluating
    // against a gone/unrelated element until Playwright's default action timeout gives up.
    const postSubmit: PostSubmitDiagnostics = urlChanged
      ? {
          invalidFieldIds: [],
          nativeValidationMessages: {},
          postSubmitValidationMessages: [],
          ariaInvalidFieldIds: [],
          hiddenFieldEvidence: [],
          unresolvedDependentControlIds: [],
          validationCauseObserved: true,
        }
      : observation.terminalState === "succeeded" && !observation.formStillPresentAtEnd
        ? EMPTY_POST_SUBMIT_DIAGNOSTICS
        : await collectPostSubmitDiagnostics(form, dealerLookupOutcome?.dealerValueVerified ?? false, preSubmitHiddenSnapshot);
    // Confirmation counts only when it newly appeared after the click -- marker text already on the
    // page before the click proves nothing.
    const confirmationAppeared = !urlChanged && postSubmit.invalidFieldIds.length === 0 && observedConfirmation;
    const succeeded = postSubmit.invalidFieldIds.length === 0 && observation.terminalState === "succeeded";
    const probe = urlChanged ? null : await readProbeAttempt(page);
    if (!urlChanged && !succeeded) record.afterCancellation = await snapshotFormState(form, FIELD_INDEX_ATTR, new Map());
    const businessSeen = businessRequests.length > 0 || observation.businessRequestDetected;
    record.classification = classifyClientSideCancellation({
      attempt: attemptNumber,
      probe,
      pageUrl: beforeUrl,
      formActionUrl,
      businessRequestObservedOnNetwork: businessSeen || urlChanged,
      succeeded,
      challengeDetected: observation.terminalState === "blocked_or_challenged" && !businessSeen,
      requiredAcknowledgementUncheckedIds: beforeSubmit ? requiredAcknowledgementUnchecked(beforeSubmit.controls) : [],
      requiredUncommittedFieldIds: beforeSubmit ? requiredUncommitted(beforeSubmit.controls) : [],
    });
    return { postSubmit, succeeded, afterUrl, networkRequests, businessRequests, submitControlEnabled, submitBlockedBeforeClick: false, confirmationAppeared, observation };
  }

  let attempt = await attemptSubmit(firstAttemptConfig);
  const firstAttempt = attempt;
  let submitClicks = attempt.submitBlockedBeforeClick ? 0 : 1;
  let correctiveRetriesAfterSubmit = 0;
  await captureAnalyticsPhase(page, captures, stepIndex, captureModules);

  let retryDecision = "not needed: the first submit succeeded";

  // Never treat requiredFieldsFilled/initial fill success as proof a dynamic widget's
  // dependent selection (e.g. a dealer-results list) is complete -- only a verified,
  // re-read post-submit state decides whether a retry has a real corrective action
  // available: an unverified dealer selection, or at least one invalid field to re-read and
  // re-fill. With neither, a retry would just resubmit the exact same state, so it's refused
  // rather than burning the bounded retry budget pretending to fix something.
  while (!attempt.succeeded && retries < MAX_RETRIES) {
    const dealerUncommitted =
      dealerLookupOutcome !== undefined &&
      dealerLookupOutcome.dealerLookupTriggered &&
      !dealerLookupOutcome.dealerValueVerified &&
      dealerLookupOutcome.executionTrace.retryRecommendation !== "none";
    const correctiveActionAvailable = !attempt.submitBlockedBeforeClick && (dealerUncommitted || attempt.postSubmit.invalidFieldIds.length > 0);
    // A business request the site accepted, or that was still pending, may already have created
    // the lead: resubmitting could duplicate it, so no retry is ever attempted after one.
    const businessRequestMayHaveLanded =
      attempt.observation !== null &&
      attempt.observation.businessRequestDetected &&
      (attempt.observation.businessRequest?.outcome === "pending" ||
        (attempt.observation.businessRequest?.status !== null &&
          attempt.observation.businessRequest?.status !== undefined &&
          attempt.observation.businessRequest.status < 400));

    if (businessRequestMayHaveLanded) {
      retryDecision = "not retried: a business submission request was already sent and not rejected, so resubmitting could duplicate the lead";
      break;
    }
    if (!correctiveActionAvailable) {
      retryDecision = "not retried: the submit was cancelled but no invalid field or uncommitted dealer selection was found to correct";
      break;
    }
    if (submitClicks >= MAX_SUBMIT_ATTEMPTS) {
      retryDecision = `not retried: the ceiling of ${MAX_SUBMIT_ATTEMPTS} Submit clicks per form was reached`;
      break;
    }

    retries += 1;
    correctiveRetriesAfterSubmit += 1;
    if (dealerUncommitted) {
      await rerunDealerSearch("await_pending_lookup");
      retryDecision = `retried ${retries}/${MAX_RETRIES}: re-ran the dealer lookup/select/verify flow after an uncommitted selection`;
    } else {
      await fillAllRequired(new Set(attempt.postSubmit.invalidFieldIds));
      retryDecision = `retried ${retries}/${MAX_RETRIES}: re-read live validation state and re-filled ${attempt.postSubmit.invalidFieldIds.join(", ")}`;
    }
    attempt = await attemptSubmit(observationConfig);
    if (!attempt.submitBlockedBeforeClick) submitClicks += 1;
  }

  // Test-only optional-consent opt-in: one more Submit, only when the first attempt demonstrably
  // never reached the business-submission stage (see submitAttemptPlan.ts). Never a third.
  const firstAttemptOutcome = classifySubmitAttempt(firstAttempt, consentResult.optionalDeclineNotCommittedGroups.length > 0);
  let fallbackEligibilityChecks: FallbackEligibilityChecks | null = null;
  let fallbackEligible = false;
  let fallbackUsed = false;
  let fallbackDecision = "not considered: the first submit succeeded";
  let fallbackNotUsedReason: FallbackNotUsedReason | null = "first_attempt_succeeded";
  let optIn: OptionalConsentOptInResult | null = null;
  // The fallback decision always re-reads the live DOM: the pre-submit scan may have run before the
  // optional controls were rendered or reachable, and an empty first scan proves nothing.
  let rediscovery: OptionalConsentRediscovery | null = null;
  let actionableOptionalGroupCount = preSubmitActionableOptional;
  let nonActionableOptionalGroups: ConsentGroupRejection[] = preSubmitNonActionableOptional;
  if (!firstAttempt.succeeded && fallbackFlagEnabled) {
    rediscovery = await rediscoverOptionalConsentGroups(page, form, language);
    actionableOptionalGroupCount = rediscovery.actionableOptionalGroupIds.length;
    nonActionableOptionalGroups = rediscovery.nonActionableOptionalGroups;
  }
  const optionalGroupsPresent = actionableOptionalGroupCount + nonActionableOptionalGroups.length > 0;
  if (!firstAttempt.succeeded) {
    const evaluated = evaluateFallbackEligibility({
      firstAttempt,
      firstAttemptOutcome,
      challengeVisibleNow: await detectCaptchaOnPage(page).catch(() => true),
      formVisibleNow: await form.isVisible().catch(() => false),
      submitEnabledNow: await submit.isEnabled().catch(() => false),
      optionalConsentGroupPresent: optionalGroupsPresent,
      // A group that renders nothing at all (another form variant) cannot be answered by anyone and
      // does not hold the fallback back; a rendered group the engine cannot reach does.
      optionalConsentGroupsActionable: actionableOptionalGroupCount > 0 && nonActionableOptionalGroups.every((r) => r.rejectionStage === "member_visibility"),
      fallbackFlagEnabled,
      submitAttemptsSoFar: submitClicks,
      correctiveRetriesAfterSubmit,
    });
    fallbackEligibilityChecks = evaluated.checks;
    fallbackEligible = evaluated.eligible;
    const failed = Object.entries(evaluated.checks).filter(([, ok]) => !ok).map(([name]) => name);
    if (!fallbackEligible) {
      fallbackNotUsedReason = !fallbackFlagEnabled
        ? "fallback_flag_disabled"
        : !optionalGroupsPresent
          ? "no_optional_consent_groups"
          : !evaluated.checks.optionalConsentGroupsActionable
            ? "optional_consent_groups_detected_but_not_actionable"
            : "eligibility_guard_failed";
      fallbackDecision = `not used (${fallbackNotUsedReason}): ${failed.join(", ")} did not hold`;
    } else {
      optIn = await applyOptionalConsentOptInForTest(form, language, fieldByIndex);
      if (!optIn.allVerified) {
        fallbackNotUsedReason = "optional_consent_opt_in_not_verified";
        fallbackDecision = "not used: at least one optional consent did not read back as accepted, so Submit was not clicked again";
      } else {
        fallbackUsed = true;
        fallbackNotUsedReason = null;
        fallbackDecision = "used once: test_only_optional_consent_fallback -- every optional consent read back as accepted before the second Submit";
        retryDecision = `retried once with the test-only optional-consent opt-in after the first attempt was classified ${firstAttemptOutcome}`;
        attempt = await attemptSubmit(observationConfig);
        if (!attempt.submitBlockedBeforeClick) submitClicks += 1;
      }
    }
  }
  function buildSubmitCancellationDiagnostics(): SubmitCancellationDiagnostics {
    const purposes = new Map<string, string>();
    for (const p of initialPlan) {
      const purpose = p.matchedField ?? (p.descriptor.selectProxyKind && !p.descriptor.visible ? "unclassified_required_select" : undefined);
      if (purpose) purposes.set(p.descriptor.id, purpose);
    }
    const label = (snapshot: SnapshotWithCompanions | null): ControlStateSnapshot[] | null =>
      snapshot
        ? snapshot.controls.map((c) => ({ ...c, purpose: purposes.get(c.fieldId) ?? (c.proxyRole === "select_proxy" ? "select_proxy_display" : c.type === "hidden" ? "hidden_field" : "unclassified") }))
        : null;
    const relabel = (snapshot: SnapshotWithCompanions | null): SnapshotWithCompanions | null => (snapshot ? { ...snapshot, controls: label(snapshot)! } : null);
    const attempts = attemptRecords.map((r) => ({
      attempt: r.attempt,
      cancellationStage: r.classification?.cancellationStage ?? null,
      cancellationReason: r.classification?.cancellationReason ?? "not classified",
      evidence: r.classification?.evidence ?? null,
      stateRefreshBeforeAttempt: r.refresh,
      preSubmitSnapshot: label(r.beforeSubmit),
      postCancellationSnapshot: label(r.afterCancellation),
    }));
    const first = attempts[0];
    const second = attempts[1];
    const snapshotDifferences = [
      ...diffSnapshots("attempt1_before_submit_vs_attempt1_after_cancellation", first?.preSubmitSnapshot ?? null, first?.postCancellationSnapshot ?? null),
      ...diffSnapshots("attempt1_after_cancellation_vs_attempt2_before_submit", first?.postCancellationSnapshot ?? null, second?.preSubmitSnapshot ?? null),
      ...diffSnapshots("attempt2_before_submit_vs_attempt2_after_cancellation", second?.preSubmitSnapshot ?? null, second?.postCancellationSnapshot ?? null),
      ...diffSnapshots("attempt1_before_submit_vs_attempt2_before_submit", first?.preSubmitSnapshot ?? null, second?.preSubmitSnapshot ?? null),
    ];
    return {
      probeInstalled: submitProbeInstalled,
      attempts,
      snapshotDifferences,
      acknowledgementCheckboxes: buildAcknowledgementCheckboxDiagnostics({
        fillStart: relabel(fillStartSnapshot),
        afterFill: relabel(afterFillSnapshot),
        beforeSubmit: attemptRecords.map((r) => relabel(r.beforeSubmit)),
        engineActivations: checkboxActivations,
      }),
    };
  }

  const submitAttemptSummary: SubmitAttemptSummary = {
    firstAttemptConsentMode: firstAttemptConsentModeOf(preSubmitActionableOptional, preSubmitNonActionableOptional.length),
    firstAttemptConsentCommitted: consentResult.optionalDeclineNotCommittedGroups.length === 0,
    firstAttemptObservationMs: firstAttempt.observation?.totalObservationMs ?? null,
    firstAttemptBusinessRequestDetected: firstAttempt.observation?.businessRequestDetected ?? false,
    firstAttemptOutcome,
    fallbackFlagEnabled,
    fallbackEligibilityChecks,
    fallbackEligible,
    fallbackUsed,
    fallbackOutcomeTag: fallbackUsed ? "test_only_optional_consent_fallback" : null,
    fallbackDecision,
    fallbackNotUsedReason,
    fallbackConsentGroups: optIn?.groups ?? [],
    optionalGroupRediscoveryCount: (rediscovery?.rediscoveryCount ?? 0) + (optIn?.rediscoveryCount ?? 0),
    actionableOptionalGroupCount,
    nonActionableOptionalGroupCount: nonActionableOptionalGroups.length,
    nonActionableOptionalGroups,
    secondAttemptConsentMode: fallbackUsed ? "opt_in_test_only" : null,
    secondAttemptConsentCommitted: fallbackUsed ? (optIn?.allVerified ?? false) : null,
    secondAttemptObservationMs: attempt !== firstAttempt ? (attempt.observation?.totalObservationMs ?? null) : null,
    secondAttemptBusinessRequestDetected: attempt !== firstAttempt ? (attempt.observation?.businessRequestDetected ?? false) : null,
    secondAttemptOutcome: attempt !== firstAttempt ? classifySubmitAttempt(attempt, false) : null,
    confirmationDetectedAtMs: attempt.observation?.confirmationDetectedAtMs ?? null,
    totalSubmitAttempts: submitClicks,
    firstAttemptObservation: attempt !== firstAttempt ? firstAttempt.observation : null,
  };

  // Always present, even when the dealer_search decision never ran at all (e.g. no dealer
  // widget was structurally detected on this form) -- a promised diagnostic field must appear
  // with explicit false defaults rather than being silently omitted from the serialized
  // response, which previously made "the dealer flow never activated" indistinguishable from
  // "it activated and every step came back false".
  const formDealerSearchDiagnostics = buildDealerSearchDiagnostics();
  // Only the correlated business request counts: tracking, advertising and third-party analytics
  // fired by the same click are never "the submission request".
  const submissionRequests = attempt.businessRequests;
  const submissionRequestStarted = submissionRequests.length > 0;
  const submissionServerResponseCategory = classifySubmissionResponses(submissionRequests);
  const observedTerminal = attempt.observation?.terminalState ?? null;
  const submissionCanceledBeforeRequest = !attempt.succeeded && !submissionRequestStarted;
  // Carries the dealer lookup's own hidden-identifier-commit evidence through to submission
  // time, for correlation -- null when no dealer_search decision ever ran on this form.
  const dealerCommitEvidence = dealerLookupOutcome?.executionTrace.hiddenFieldCommitDetected ?? null;
  const finalDealerUncommitted = dealerLookupOutcome !== undefined && dealerLookupOutcome.dealerLookupTriggered && !dealerLookupOutcome.dealerValueVerified;
  // Whether a further retry would have had a real corrective action available -- independent of
  // whether the retry budget was already spent (retryDecision/retryReason explains that part).
  const retryEligible = !attempt.succeeded && (finalDealerUncommitted || attempt.postSubmit.invalidFieldIds.length > 0);
  const validationSurfaceType: "field_validation" | "visible_message" | "unresolved_dependent_control" | null = !attempt.succeeded
    ? attempt.postSubmit.ariaInvalidFieldIds.length > 0 || Object.keys(attempt.postSubmit.nativeValidationMessages).length > 0
      ? "field_validation"
      : attempt.postSubmit.postSubmitValidationMessages.length > 0
        ? "visible_message"
        : attempt.postSubmit.unresolvedDependentControlIds.length > 0
          ? "unresolved_dependent_control"
          : null
    : null;
  const submissionOutcome: SubmissionOutcome = attempt.succeeded
    ? "succeeded"
    : attempt.submitBlockedBeforeClick
      ? "cancelled_before_request"
      : observedTerminal === "blocked_or_challenged" || submissionServerResponseCategory === "blocked_or_rate_limited"
        ? "blocked_or_rate_limited"
        : observedTerminal === "server_rejected" || submissionServerResponseCategory === "server_validation_rejected"
          ? "server_rejected"
          : observedTerminal === "server_error" || submissionServerResponseCategory === "server_error"
            ? "server_error"
            : observedTerminal === "validation_failed" || attempt.postSubmit.validationCauseObserved
              ? "validation_failed"
              : submissionCanceledBeforeRequest
                ? "cancelled_before_request"
                : submissionServerResponseCategory === "accepted" || submissionServerResponseCategory === "failed_or_pending"
                  ? "unconfirmed"
                  : "cancelled_unknown_cause";
  const submissionOutcomeReason = attempt.succeeded
    ? attempt.afterUrl !== beforeUrl
      ? "submit resulted in a URL change"
      : `positive completion evidence appeared after submit (${attempt.observation?.successSignals.join(", ") ?? "confirmation"})`
    : attempt.submitBlockedBeforeClick
      ? "the submit control stayed disabled after a final blur/commit event, so it was never clicked"
      : submissionOutcome === "blocked_or_rate_limited" && observedTerminal === "blocked_or_challenged" && attempt.observation?.businessRequest?.status == null
        ? "a challenge/CAPTCHA surface appeared after submit"
        : submissionOutcome === "validation_failed"
        ? "a native/aria-invalid field, visible validation text, or an unresolved dependent control was observed after submit"
        : submissionOutcome === "server_rejected"
          ? "the submission request was answered with a client-error status that rejects the submitted data (400/409/422)"
          : submissionOutcome === "blocked_or_rate_limited"
            ? "the submission request was answered with an authorisation, anti-bot or rate-limit status (401/403/429)"
            : submissionOutcome === "server_error"
              ? "the submission request was answered with a server error (5xx)"
              : submissionCanceledBeforeRequest
                ? "no business submission request (same-site or form-action state-changing request) was observed after submit, and nothing was in progress when observation ended"
                : submissionOutcome === "unconfirmed"
                  ? `the business submission request was ${submissionServerResponseCategory === "accepted" ? "accepted (2xx)" : "still pending or failed in transport"} but no confirmation state followed within the adaptive observation window -- the outcome cannot be confirmed either way`
                  : "submit was cancelled but no diagnosable cause was observed, even though a network request was sent";
  const formPostSubmitDiagnostics = {
    submitCanceled: !attempt.succeeded,
    invalidFieldIds: attempt.postSubmit.invalidFieldIds,
    nativeValidationMessages: attempt.postSubmit.nativeValidationMessages,
    postSubmitValidationMessages: attempt.postSubmit.postSubmitValidationMessages,
    ariaInvalidFieldIds: attempt.postSubmit.ariaInvalidFieldIds,
    hiddenFieldEvidence: attempt.postSubmit.hiddenFieldEvidence,
    unresolvedDependentControlIds: attempt.postSubmit.unresolvedDependentControlIds,
    validationCauseObserved: attempt.postSubmit.validationCauseObserved,
    retryDecision,
    preSubmitReadinessPassed: true,
    preSubmitReadinessFailures: [] as string[],
    submitAttempted: true,
    submitControlIdentity,
    submitActivationMethod,
    submissionRequestStarted,
    submissionNetworkRequests: attempt.networkRequests,
    submissionCanceledBeforeRequest,
    submitControlEnabled: attempt.submitControlEnabled,
    submissionServerResponseCategory,
    validationSurfaceDetected: attempt.postSubmit.validationCauseObserved,
    validationSurfaceType,
    dealerCommitEvidence,
    submissionOutcome,
    submissionOutcomeReason,
    retryEligible,
    retryReason: retryDecision,
    postSubmitObservation: attempt.observation,
    submitAttemptSummary,
    submitCancellationDiagnostics: buildSubmitCancellationDiagnostics(),
  };

  if (!attempt.succeeded) {
    const runnerUpValidation = selection.rejectedFormsAndReasons[0];
    const formDiscoveryDebugValidation = await emitDiagnostic(
      attempt.postSubmit.validationCauseObserved ? "form_validation_failed" : "validation_cause_not_observed",
      candidateEvidence.map((c) => c.index),
      new Map(candidateEvidence.map((c) => [c.index, c.score])),
      {
        selectedFormIndex: selection.chosenIndex,
        runnerUpIndex: runnerUpValidation?.index ?? null,
        runnerUpScore: runnerUpValidation?.totalFormScore ?? null,
        belowConfidenceThreshold: false,
        ambiguous: false,
        rejectionReason: "selected and filled, but the site's own submit validation cancelled it",
      },
    );
    const dealerLookupTrace = await buildDealerLookupTrace({
      page,
      form,
      taskId: diagnosticRunId,
      captureStage: "post_submit_validation_failed",
      plan: initialPlan,
      triggerCandidates: dealerLookupDebugCapture?.triggerCandidates ?? [],
      pairDebug: dealerLookupDebugCapture?.pairDebug ?? [],
      dealerLookupOutcome,
      preSubmitReadinessPassed: true,
      preSubmitReadinessFailures: [],
    }).catch(() => undefined);
    return {
      success: false,
      // A cancelled submission whose cause this engine could actually observe (a native/aria
      // invalid field, visible validation text, or an unresolved dependent control it can point
      // to) is reported as "form_validation_failed"; one with no such evidence at all must never
      // be reported the same way -- that would claim a diagnosed cause where none exists.
      formFillOutcome: attempt.postSubmit.validationCauseObserved ? "form_validation_failed" : "validation_cause_not_observed",
      formRetriesUsed: retries,
      formValidationMissingFields: attempt.postSubmit.invalidFieldIds,
      formFieldsFilled: [...fieldsFilled],
      formMarketDetected: market,
      formLanguageDetected: language,
      formLocationGateDiagnostics: locationGateOutcome,
      formClaudeCallUsed: claudeCallUsed,
      formDiscoveryDiagnostics,
      formDealerSearchDiagnostics,
      formConsentDiagnostics: consentResult,
      dealerLookupTrace,
      formPostSubmitDiagnostics,
      formDiscoveryDebug: formDiscoveryDebugValidation,
    };
  }

  await captureAnalyticsPhase(page, captures, stepIndex + 1, captureModules);

  const runnerUpSuccess = selection.rejectedFormsAndReasons[0];
  const formDiscoveryDebugSuccess = await emitDiagnostic(
    "submitted",
    candidateEvidence.map((c) => c.index),
    new Map(candidateEvidence.map((c) => [c.index, c.score])),
    {
      selectedFormIndex: selection.chosenIndex,
      runnerUpIndex: runnerUpSuccess?.index ?? null,
      runnerUpScore: runnerUpSuccess?.totalFormScore ?? null,
      belowConfidenceThreshold: false,
      ambiguous: false,
      rejectionReason: "not rejected -- selected, filled, and submitted successfully",
    },
  );
  const dealerLookupTraceSuccess = await buildDealerLookupTrace({
    page,
    form,
    taskId: diagnosticRunId,
    captureStage: "submitted",
    plan: initialPlan,
    triggerCandidates: dealerLookupDebugCapture?.triggerCandidates ?? [],
    pairDebug: dealerLookupDebugCapture?.pairDebug ?? [],
    dealerLookupOutcome,
    preSubmitReadinessPassed: true,
    preSubmitReadinessFailures: [],
  }).catch(() => undefined);

  return {
    success: true,
    resultingUrl: attempt.afterUrl,
    formFillOutcome: "submitted",
    formSuccessDetection: attempt.afterUrl !== beforeUrl ? "url_change" : "on_screen_message",
    formRetriesUsed: retries,
    formFieldsFilled: [...fieldsFilled],
    formMarketDetected: market,
    formLanguageDetected: language,
    formLocationGateDiagnostics: locationGateOutcome,
    formClaudeCallUsed: claudeCallUsed,
    formDiscoveryDiagnostics,
    formDealerSearchDiagnostics,
    formConsentDiagnostics: consentResult,
    dealerLookupTrace: dealerLookupTraceSuccess,
    formPostSubmitDiagnostics,
    formDiscoveryDebug: formDiscoveryDebugSuccess,
  };
}
