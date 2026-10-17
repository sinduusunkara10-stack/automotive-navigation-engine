import type { Locator, Page } from "playwright";

import { isSameRegistrableDomain } from "../discovery/registrableDomain.js";
import type { DealerLookupNetworkCapture, SanitizedNetworkRequestEvidence } from "./dealerLookupNetwork.js";

/**
 * Post-submit observation is a bounded, adaptive state machine, never a fixed sleep: a short base
 * window that ends early on the first decisive signal, extended only while concrete progress
 * evidence exists (a correlated business request still in flight, a disabled submit control, an
 * active loading indicator, DOM changes continuing around the form), up to a hard cap long enough
 * for a lead service that confirms on the same page after about a minute.
 */
export const POST_SUBMIT_BASE_WINDOW_MS = 10_000;
export const POST_SUBMIT_EXTENSION_MS = 10_000;
export const POST_SUBMIT_HARD_CAP_MS = 75_000;
export const POST_SUBMIT_POLL_INTERVAL_MS = 250;
/** DOM changes around the form more recent than this still count as "the page is working". */
export const POST_SUBMIT_RECENT_MUTATION_MS = 2_000;

export interface SubmissionObservationConfig {
  baseWindowMs: number;
  extensionMs: number;
  hardCapMs: number;
  pollIntervalMs: number;
}

export const DEFAULT_SUBMISSION_OBSERVATION_CONFIG: SubmissionObservationConfig = {
  baseWindowMs: POST_SUBMIT_BASE_WINDOW_MS,
  extensionMs: POST_SUBMIT_EXTENSION_MS,
  hardCapMs: POST_SUBMIT_HARD_CAP_MS,
  pollIntervalMs: POST_SUBMIT_POLL_INTERVAL_MS,
};

export type SubmissionTerminalState = "succeeded" | "validation_failed" | "server_rejected" | "server_error" | "blocked_or_challenged" | "unknown_outcome";

export type SubmissionSuccessSignal =
  | "url_change"
  | "confirmation_message"
  | "success_status_surface"
  | "virtual_page_success_event"
  | "form_replaced_after_accepted_business_response";

export type SubmissionExtensionReason =
  | "business_request_in_flight"
  | "submit_control_disabled"
  | "loading_indicator_active"
  | "dom_mutations_continuing"
  | "form_replacement_in_progress";

export interface BusinessRequestEvidence {
  method: string;
  endpointPattern: string;
  resourceType: string;
  status: number | null;
  outcome: "completed" | "failed" | "pending";
  startedAtMs: number;
  durationMs: number | null;
  classificationReason: string;
}

export interface PostSubmitObservation {
  baseWindowMs: number;
  extensionMs: number;
  hardCapMs: number;
  extensionCount: number;
  extensionReasons: SubmissionExtensionReason[][];
  totalObservationMs: number;
  businessRequestDetected: boolean;
  businessRequestCount: number;
  businessRequest: BusinessRequestEvidence | null;
  businessRequestStartedAtMs: number | null;
  businessRequestFinishedAtMs: number | null;
  excludedTrackingOrThirdPartyRequestCount: number;
  confirmationDetectedAtMs: number | null;
  successSignals: SubmissionSuccessSignal[];
  formStillPresentAtEnd: boolean;
  terminalState: SubmissionTerminalState;
  terminalReason: string;
}

const BUSINESS_METHODS = new Set(["POST", "PUT", "PATCH"]);
const BUSINESS_RESOURCE_TYPES = new Set(["xhr", "fetch", "document", "other"]);

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const LOOKUP_OR_CONFIG_PURPOSES = new Set(["form_configuration", "location_lookup", "location_results", "dealer_lookup", "dealer_results", "email_validation"]);

/**
 * Decides whether one captured request is the lead submission itself rather than tracking,
 * advertising or analytics fired by the same click. Generic: not classified as tracking, sent
 * either to the page's own site (same host or registrable domain) or to the host the form's own
 * action names, over a page-initiated transport. A state-changing method is the primary tier; a
 * same-site read with no lookup/configuration purpose is a secondary tier, used only when no
 * state-changing candidate exists. Third-party hosts are never the business request unless the
 * form itself points there.
 */
export function classifyBusinessRequest(
  request: Pick<SanitizedNetworkRequestEvidence, "method" | "endpointPattern" | "resourceType" | "purpose">,
  context: { pageUrl: string; formActionUrl: string | null },
): { business: boolean; tier: "primary" | "secondary" | null; reason: string } {
  if (request.purpose === "unrelated_tracking") return { business: false, tier: null, reason: "tracking_or_analytics" };
  if (!BUSINESS_RESOURCE_TYPES.has(request.resourceType)) return { business: false, tier: null, reason: `transport_${request.resourceType}` };
  const requestHost = hostOf(request.endpointPattern);
  const pageHost = hostOf(context.pageUrl);
  const actionHost = hostOf(context.formActionUrl);
  if (!requestHost) return { business: false, tier: null, reason: "unparseable_endpoint" };
  const viaAction = actionHost !== null && requestHost === actionHost;
  const sameSite = pageHost !== null && (requestHost === pageHost || isSameRegistrableDomain(requestHost, pageHost));
  if (!viaAction && !sameSite) return { business: false, tier: null, reason: "third_party_host" };
  const where = viaAction ? "form_action_host" : "same_site";
  if (BUSINESS_METHODS.has(request.method.toUpperCase()) || request.resourceType === "document") return { business: true, tier: "primary", reason: `${where}_state_changing_request` };
  if (LOOKUP_OR_CONFIG_PURPOSES.has(request.purpose)) return { business: false, tier: null, reason: `lookup_or_configuration_${request.purpose}` };
  return { business: true, tier: "secondary", reason: `${where}_read_request_without_state_changing_method` };
}

/** The business requests among one attempt's captured requests: the primary tier when any exists, otherwise the secondary tier. */
export function selectBusinessRequests<T extends Pick<SanitizedNetworkRequestEvidence, "method" | "endpointPattern" | "resourceType" | "purpose">>(
  requests: readonly T[],
  context: { pageUrl: string; formActionUrl: string | null },
): T[] {
  const tiers = requests.map((r) => ({ r, tier: classifyBusinessRequest(r, context).tier }));
  const primary = tiers.filter((x) => x.tier === "primary").map((x) => x.r);
  return primary.length > 0 ? primary : tiers.filter((x) => x.tier === "secondary").map((x) => x.r);
}

const SUCCESS_STATUS_MARKERS = [
  "thank you", "successfully", "has been received", "has been registered", "has been sent",
  "merci", "bien ete", "a ete enregistree", "a ete envoyee", "enregistree",
  "danke", "erfolgreich", "bedankt", "succesvol", "grazie", "con successo", "gracias", "con exito", "correctamente",
  "dziekujemy", "pomyslnie", "obrigado", "com sucesso",
];
const ERROR_STATUS_MARKERS = [
  "error", "invalid", "required", "failed", "try again",
  "erreur", "invalide", "obligatoire", "echec", "reessayer",
  "fehler", "ungultig", "erforderlich", "fout", "ongeldig", "verplicht", "errore", "non valido", "obbligatorio",
  "no valido", "obligatorio", "blad", "nieprawidlow", "wymagane", "erro", "invalido",
];
const SUCCESS_EVENT_TOKENS = ["success", "succeeded", "successful", "complete", "completed", "confirmation", "confirmed", "thankyou", "thanks", "thank"];

const OBSERVER_SOURCE = `(() => {
  const KEY = "__navEngineSubmitObserver";
  const SUCCESS = ${JSON.stringify(SUCCESS_STATUS_MARKERS)};
  const ERROR = ${JSON.stringify(ERROR_STATUS_MARKERS)};
  const EVENT_TOKENS = ${JSON.stringify(SUCCESS_EVENT_TOKENS)};
  const norm = (t) => (t || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
  };
  const form = document.querySelector("[data-nav-engine-submit-form]");
  const submit = document.querySelector("[data-nav-engine-submit-control]");
  const region = (form && (form.parentElement && form.parentElement.parentElement || form.parentElement)) || document.body;
  const SURFACE = '[role="dialog"], [role="alertdialog"], [role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"], dialog';
  const baselineSurfaces = new Set(Array.from(document.querySelectorAll(SURFACE)).map((el) => el));
  const baselineSurfaceText = new Map(Array.from(baselineSurfaces).map((el) => [el, visible(el) ? norm(el.innerText) : ""]));
  const dl = Array.isArray(window.dataLayer) ? window.dataLayer : null;
  const state = { regionMutations: 0, lastRegionMutationAt: 0, dataLayerStart: dl ? dl.length : 0, startedAt: Date.now() };
  const inRegion = (node) => node && (region.contains(node) || node.parentElement === document.body);
  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      if (inRegion(rec.target)) {
        state.regionMutations += 1;
        state.lastRegionMutationAt = Date.now();
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const tokens = (v) => norm(String(v)).split(/[^a-z0-9]+/).filter(Boolean);
  const isSuccessEvent = (entry) => {
    if (!entry || typeof entry !== "object") return false;
    const fields = [entry.event, entry.virtualPagePath, entry.virtualPageURL, entry.pagePath, entry.page_path, entry.page && entry.page.path];
    return fields.some((f) => typeof f === "string" && tokens(f).some((t) => EVENT_TOKENS.includes(t)));
  };
  const classifySurfaceText = (text) => ({
    success: SUCCESS.some((m) => text.includes(m)),
    error: ERROR.some((m) => text.includes(m)),
  });
  window[KEY] = {
    snapshot() {
      let statusSuccess = false;
      let statusError = false;
      let newSurfaces = 0;
      Array.from(document.querySelectorAll(SURFACE)).forEach((el) => {
        if (!visible(el)) return;
        const text = norm(el.innerText);
        if (!text) return;
        if (baselineSurfaces.has(el) && baselineSurfaceText.get(el) === text) return;
        newSurfaces += 1;
        const c = classifySurfaceText(text);
        if (c.success && !c.error) statusSuccess = true;
        if (c.error && !c.success) statusError = true;
      });
      const layer = Array.isArray(window.dataLayer) ? window.dataLayer : [];
      const fresh = layer.slice(state.dataLayerStart);
      const busyEls = Array.from(region.querySelectorAll('[aria-busy="true"], [role="progressbar"], .spinner, .loader, [class*="spinner"]')).concat(
        Array.from(document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')).filter((el) => window.getComputedStyle(el).position === "fixed"),
      );
      return {
        formConnected: Boolean(form && form.isConnected),
        formVisible: Boolean(form && visible(form)),
        regionMutations: state.regionMutations,
        msSinceRegionMutation: state.lastRegionMutationAt ? Date.now() - state.lastRegionMutationAt : null,
        newSurfaces,
        statusSuccess,
        statusError,
        dataLayerNewEvents: fresh.length,
        dataLayerSuccessEvent: fresh.some(isSuccessEvent),
        busy: busyEls.some(visible),
        submitDisabled: Boolean(submit && submit.isConnected && (submit.disabled || submit.getAttribute("aria-disabled") === "true")),
        ariaInvalidCount: form ? form.querySelectorAll('[aria-invalid="true"]').length : 0,
        nativeInvalidCount: form ? Array.from(form.elements || []).filter((el) => el.willValidate && el.validity && !el.validity.valid && el.type !== "hidden").length : 0,
      };
    },
    stop() {
      observer.disconnect();
      delete window[KEY];
    },
  };
  return true;
})()`;

interface ObserverSnapshot {
  formConnected: boolean;
  formVisible: boolean;
  regionMutations: number;
  msSinceRegionMutation: number | null;
  newSurfaces: number;
  statusSuccess: boolean;
  statusError: boolean;
  dataLayerNewEvents: number;
  dataLayerSuccessEvent: boolean;
  busy: boolean;
  submitDisabled: boolean;
  ariaInvalidCount: number;
  nativeInvalidCount: number;
}

const EMPTY_SNAPSHOT: ObserverSnapshot = {
  formConnected: true,
  formVisible: true,
  regionMutations: 0,
  msSinceRegionMutation: null,
  newSurfaces: 0,
  statusSuccess: false,
  statusError: false,
  dataLayerNewEvents: 0,
  dataLayerSuccessEvent: false,
  busy: false,
  submitDisabled: false,
  ariaInvalidCount: 0,
  nativeInvalidCount: 0,
};

/** Marks the form and submit control so the string-evaluated observer can find them without any selector of the page's own. */
export async function installSubmissionObserver(form: Locator, submit: Locator): Promise<{ ariaInvalidBefore: number }> {
  await form.evaluate((el) => el.setAttribute("data-nav-engine-submit-form", "1")).catch(() => {});
  await submit.evaluate((el) => el.setAttribute("data-nav-engine-submit-control", "1")).catch(() => {});
  const page = form.page();
  await page.mainFrame().evaluate(OBSERVER_SOURCE).catch(() => false);
  const first = await readSnapshot(page);
  return { ariaInvalidBefore: first?.ariaInvalidCount ?? 0 };
}

async function readSnapshot(page: Page): Promise<ObserverSnapshot | null> {
  const snapshot = await page
    .mainFrame()
    .evaluate("(() => { const o = window.__navEngineSubmitObserver; return o ? o.snapshot() : null; })()")
    .catch(() => null);
  return snapshot as ObserverSnapshot | null;
}

async function stopObserver(page: Page): Promise<void> {
  await page
    .mainFrame()
    .evaluate("(() => { const o = window.__navEngineSubmitObserver; if (o) o.stop(); return true; })()")
    .catch(() => {});
}

function businessResponseState(request: BusinessRequestEvidence | null): SubmissionTerminalState | null {
  if (!request || request.status === null) return null;
  const st = request.status;
  if (st === 401 || st === 403 || st === 429) return "blocked_or_challenged";
  if (st === 400 || st === 409 || st === 422) return "server_rejected";
  if (st >= 500) return "server_error";
  return null;
}

export interface ObserveSubmissionParams {
  page: Page;
  capture: DealerLookupNetworkCapture;
  beforeUrl: string;
  formActionUrl: string | null;
  confirmationBefore: number;
  ariaInvalidBefore: number;
  countConfirmationMarkers: (page: Page) => Promise<number>;
  detectChallenge: (page: Page) => Promise<boolean>;
  config?: SubmissionObservationConfig;
}

export interface ObserveSubmissionResult {
  observation: PostSubmitObservation;
  urlChanged: boolean;
  confirmationAppeared: boolean;
}

/**
 * Runs after the submit click. Polls frequently; returns the moment a decisive success or failure
 * signal appears. HTTP 2xx alone is never success: an accepted business response only counts
 * together with the form being replaced on the page.
 */
export async function observeSubmissionOutcome(params: ObserveSubmissionParams): Promise<ObserveSubmissionResult> {
  const { page, capture, beforeUrl, formActionUrl, confirmationBefore, ariaInvalidBefore } = params;
  const config = params.config ?? DEFAULT_SUBMISSION_OBSERVATION_CONFIG;
  const start = Date.now();
  // The capture starts just before the click, so every request it holds belongs to this attempt --
  // including the ones the click itself fired synchronously, before this function was entered.
  const captureStart = 0;
  let deadline = start + config.baseWindowMs;
  const hardDeadline = start + config.hardCapMs;
  const extensionReasons: SubmissionExtensionReason[][] = [];
  const successSignals: SubmissionSuccessSignal[] = [];
  let terminalState: SubmissionTerminalState | null = null;
  let terminalReason = "";
  let confirmationDetectedAtMs: number | null = null;
  let lastChallengeCheck = 0;
  let snapshot = EMPTY_SNAPSHOT;
  let urlChanged = false;
  let confirmationAppeared = false;
  let business: BusinessRequestEvidence | null = null;
  let businessCount = 0;
  let thirdPartyExcluded = 0;

  const readBusiness = (): void => {
    const candidates = capture.snapshot().filter((e) => e.startedAtMs >= captureStart);
    const classified = candidates.map((e) => ({ e, c: classifyBusinessRequest(e, { pageUrl: beforeUrl, formActionUrl }) }));
    const primary = classified.filter((x) => x.c.tier === "primary");
    const businessEntries = primary.length > 0 ? primary : classified.filter((x) => x.c.tier === "secondary");
    thirdPartyExcluded = classified.filter((x) => x.c.reason === "third_party_host" || x.c.reason === "tracking_or_analytics").length;
    businessCount = businessEntries.length;
    // The first rejecting answer outranks an earlier accepted one (a pre-check then the real submit).
    const decisive = businessEntries.find((x) => x.e.status !== null && x.e.status >= 400) ?? businessEntries[0];
    business = decisive
      ? {
          method: decisive.e.method,
          endpointPattern: decisive.e.endpointPattern,
          resourceType: decisive.e.resourceType,
          status: decisive.e.status,
          outcome: decisive.e.outcome,
          startedAtMs: decisive.e.startedAtMs - captureStart,
          durationMs: decisive.e.durationMs,
          classificationReason: decisive.c.reason,
        }
      : null;
  };
  const businessPending = (): boolean =>
    capture
      .snapshot()
      .some((e) => e.startedAtMs >= captureStart && e.outcome === "pending" && classifyBusinessRequest(e, { pageUrl: beforeUrl, formActionUrl }).business);

  let documentReloaded = false;

  while (true) {
    const elapsed = Date.now() - start;
    readBusiness();
    if (page.url() !== beforeUrl) {
      urlChanged = true;
      successSignals.push("url_change");
      confirmationDetectedAtMs = elapsed;
      terminalState = "succeeded";
      terminalReason = "the page navigated to a different URL after submit";
      break;
    }
    let current = await readSnapshot(page);
    if (current === null) {
      // A same-URL document reload discards the in-page observer; the reloaded document no longer
      // carries the marked form, so the re-installed observer reports it as gone.
      documentReloaded = true;
      await page.mainFrame().evaluate(OBSERVER_SOURCE).catch(() => false);
      current = await readSnapshot(page);
    }
    snapshot = current ?? { ...EMPTY_SNAPSHOT, formConnected: !documentReloaded };
    const confirmationNow = await params.countConfirmationMarkers(page).catch(() => confirmationBefore);
    confirmationAppeared = confirmationNow > confirmationBefore;
    const signals = successSignalsFrom(snapshot, confirmationAppeared, business);
    if (signals.length > 0 && !snapshot.statusError) {
      successSignals.push(...signals);
      confirmationDetectedAtMs = elapsed;
      terminalState = "succeeded";
      terminalReason = `positive completion evidence: ${signals.join(", ")}`;
      break;
    }

    const responseState = businessResponseState(business);
    if (responseState) {
      terminalState = responseState;
      terminalReason = `the correlated business request was answered with HTTP ${(business as BusinessRequestEvidence | null)?.status}`;
      break;
    }
    if (snapshot.ariaInvalidCount > ariaInvalidBefore || snapshot.statusError) {
      terminalState = "validation_failed";
      terminalReason = snapshot.statusError ? "a new alert/status surface reported an error" : "a field was newly marked aria-invalid after submit";
      break;
    }
    if (Date.now() - lastChallengeCheck > 2_000) {
      lastChallengeCheck = Date.now();
      if (await params.detectChallenge(page).catch(() => false)) {
        terminalState = "blocked_or_challenged";
        terminalReason = "a challenge/CAPTCHA appeared after submit";
        break;
      }
    }

    if (Date.now() >= deadline) {
      const reasons: SubmissionExtensionReason[] = [];
      if (businessPending()) reasons.push("business_request_in_flight");
      if (snapshot.submitDisabled) reasons.push("submit_control_disabled");
      if (snapshot.busy) reasons.push("loading_indicator_active");
      if (snapshot.msSinceRegionMutation !== null && snapshot.msSinceRegionMutation < POST_SUBMIT_RECENT_MUTATION_MS) reasons.push("dom_mutations_continuing");
      if (!snapshot.formVisible && snapshot.formConnected) reasons.push("form_replacement_in_progress");
      if (reasons.length > 0 && Date.now() < hardDeadline) {
        extensionReasons.push(reasons);
        deadline = Math.min(hardDeadline, Date.now() + config.extensionMs);
      } else {
        terminalState = "unknown_outcome";
        const b = business as BusinessRequestEvidence | null;
        terminalReason =
          reasons.length > 0
            ? `the hard cap was reached while progress was still observed (${reasons.join(", ")})`
            : b === null
              ? "no business submission request was observed and nothing was in progress when the observation window ended"
              : b.outcome === "pending"
                ? "the business request was still pending, with no other progress signal, when the observation window ended"
                : `the business request finished (${b.status ?? b.outcome}) but no completion state followed before progress stopped`;
        break;
      }
    }
    await page.waitForTimeout(config.pollIntervalMs);
  }

  readBusiness();
  await stopObserver(page);
  const b = business as BusinessRequestEvidence | null;
  return {
    urlChanged,
    confirmationAppeared,
    observation: {
      baseWindowMs: config.baseWindowMs,
      extensionMs: config.extensionMs,
      hardCapMs: config.hardCapMs,
      extensionCount: extensionReasons.length,
      extensionReasons,
      totalObservationMs: Date.now() - start,
      businessRequestDetected: businessCount > 0,
      businessRequestCount: businessCount,
      businessRequest: b,
      businessRequestStartedAtMs: b ? b.startedAtMs : null,
      businessRequestFinishedAtMs: b && b.durationMs !== null ? b.startedAtMs + b.durationMs : null,
      excludedTrackingOrThirdPartyRequestCount: thirdPartyExcluded,
      confirmationDetectedAtMs,
      successSignals,
      formStillPresentAtEnd: snapshot.formConnected && snapshot.formVisible,
      terminalState: terminalState ?? "unknown_outcome",
      terminalReason,
    },
  };
}

function successSignalsFrom(snapshot: ObserverSnapshot, confirmationAppeared: boolean, business: BusinessRequestEvidence | null): SubmissionSuccessSignal[] {
  const signals: SubmissionSuccessSignal[] = [];
  if (confirmationAppeared) signals.push("confirmation_message");
  if (snapshot.statusSuccess) signals.push("success_status_surface");
  if (snapshot.dataLayerSuccessEvent) signals.push("virtual_page_success_event");
  const accepted = business !== null && business.status !== null && business.status >= 200 && business.status < 300;
  if (accepted && (!snapshot.formConnected || !snapshot.formVisible)) signals.push("form_replaced_after_accepted_business_response");
  return signals;
}
