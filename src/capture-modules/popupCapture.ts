import type { Page } from "playwright";
import type { Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import type { SurfaceAdoptionDomainPolicy } from "../types/task-request.js";
import { attachGa4NetworkCapture } from "./ga4NetworkEvents.js";
import { attachDataLayerPushCapture, captureDataLayer } from "./dataLayer.js";
import { popupContextId } from "./captureContext.js";
import { POPUP_ADOPTION_WINDOW_MS } from "../config/captureLimits.js";
import { waitForAdaptiveSettle } from "../core/robustNavigation.js";
import { decideSurfaceAdoption, DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN, type AdoptionRejectionReason } from "../core/surfaceAdoption.js";
import {
  assessSurfaceRelevance,
  type SurfaceRelevanceAmbiguityResolver,
  type SurfaceRelevanceAssessment,
} from "../core/surfaceRelevance.js";

export interface AdoptPopupForCaptureResult {
  /** True when at least one real-time capture (GA4 request or dataLayer push/snapshot) was actually recorded from the adopted popup before it closed. */
  observed: boolean;
}

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): the run-level context adoptOrCapturePopup needs to decide (via
 * decideSurfaceAdoption, core/surfaceAdoption.ts) whether a just-opened popup should be kept
 * open as the engine's new active surface instead of being capture-only-and-closed. Built
 * fresh by core/loop.ts for every click dispatch, from task.safety and the run's own current
 * RunState.adoptedSurfaceCount -- never itself mutated by this module.
 */
export interface SurfaceAdoptionRequest {
  enabled: boolean;
  domainPolicy: SurfaceAdoptionDomainPolicy | undefined;
  allowedDomains: string[];
  adoptedSurfaceCount: number;
  maxAdoptedSurfacesPerRun: number | undefined;
  /**
   * Surface-relevance assessment (PR 3): free text (task objective + success-criteria
   * descriptions + journeyType + the triggering CTA's own accessible name, all folded
   * together by core/loop.ts before this request is built) the candidate's own page signals
   * are scored against -- see core/surfaceRelevance.ts. Optional and additive: absent or
   * empty means the relevance gate is skipped entirely and adoption falls through to the
   * pre-existing domain/budget-only decision, so every test fixture and call site built
   * before PR 3 keeps its exact prior behaviour without needing to set this.
   */
  relevanceObjectiveText?: string;
  /** See core/surfaceRelevance.ts's own doc comment -- absent by default, same convention as safety/consentClassifier.ts's ConsentAmbiguityResolver. */
  relevanceAmbiguityResolver?: SurfaceRelevanceAmbiguityResolver;
  /**
   * Write-only output slot: actions/click.ts sets this the instant a popup from its own
   * click is actually adopted, since the live Page it needs to hand back to core/loop.ts
   * cannot travel through the JSON-serializable ActionResult (see ActionResult.surfaceAdopted,
   * a plain boolean marker, for what *does* go through there). core/loop.ts reads this field
   * off the same request object it passed in, immediately after dispatchAction returns, and
   * never reuses the object across steps.
   */
  adopted?: { page: Page; url: string | undefined; extendedAllowedDomain?: string };
}

export interface AdoptOrCapturePopupResult extends AdoptPopupForCaptureResult {
  /** Present only when surfaceAdoption.enabled and this popup was actually kept open -- the live Page core/loop.ts must push onto RunState as the new active surface. */
  adoptedPage?: Page;
  adoptedUrl?: string;
  /** Present only when surfaceAdoption.enabled but this popup was capture-only-and-closed anyway -- names why, for diagnostics. */
  adoptionRejectedReason?: AdoptionRejectionReason;
  /** Mirrors AdoptionDecision.extendedAllowedDomain -- see core/surfaceAdoption.ts. */
  extendedAllowedDomain?: string;
  /**
   * Present only when the relevance gate actually ran (surfaceAdoption.relevanceObjectiveText
   * was non-empty) -- full detail for diagnostics (PR 6 wires this into
   * TaskResponse.diagnostics; not yet wire-exposed as of PR 3, same treatment as
   * adoptionRejectedReason's own new "relevance_rejected" value).
   */
  relevanceAssessment?: SurfaceRelevanceAssessment;
}

/**
 * Popup/new-context capture (item A of the cross-client analytics-capture fix -- see
 * CLAUDE.md and docs/architecture.md "Generic action-attributed analytics capture"): a
 * click that opens a popup/new tab (target="_blank" anchor, or a window.open() call from a
 * click handler) used to be closed immediately, before any evidence-gathering code ever
 * ran against it -- whatever GA4 request or dataLayer.push() the click's own handler fired
 * *inside that context* was unrecoverable. This adopts the popup for a short, bounded
 * window instead: attach the same generic GA4/dataLayer-push capture already used for the
 * tracked page (as early as possible -- before waiting for anything else), give it a fixed,
 * short settle window to let an already-in-flight beacon/push land, take one best-effort
 * dataLayer snapshot, then close it. Every entry captured this way is tagged
 * `source: "popup_context"` and a `contextId` unique to the step that opened it (see
 * captureContext.ts), so it stays attributable to the CTA that opened it (stepIndex is
 * already the same for every entry produced during one step) without ever needing this
 * engine to guess at what the popup's own page was *for*.
 *
 * Never adopts the popup as the run's own tracked page -- the engine continues to navigate
 * only the one Page it started with (see actions/click.ts's existing destinationUrl
 * fallback, unchanged by this fix). This is capture-only: it never affects navigation
 * safety, allowedDomains enforcement, or which page the reasoning layer observes next.
 */
export async function adoptPopupForCapture(params: {
  popup: Page;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
}): Promise<AdoptPopupForCaptureResult> {
  const { popup, captures, stepIndex, captureModules } = params;
  const wantsGa4 = captureModules.includes("ga4_network_events");
  const wantsDataLayer = captureModules.includes("data_layer_evidence");

  if (!wantsGa4 && !wantsDataLayer) {
    // Neither capture module was requested -- nothing to instrument; close immediately,
    // matching the pre-existing behaviour for a task that never asked for this evidence.
    await popup.close().catch(() => {});
    return { observed: false };
  }

  const contextId = popupContextId(stepIndex);
  const beforeGa4Count = captures.ga4_network_events?.length ?? 0;
  const beforeDataLayerCount = captures.data_layer_evidence?.length ?? 0;

  let detachGa4: (() => void) | undefined;
  let detachPush: (() => void) | undefined;

  try {
    // Attached before anything else in this function waits on anything -- as early as
    // possible relative to the popup event firing (item A.3 of the fix), so a request/push
    // that lands during the popup's own initial load is never missed.
    if (wantsGa4) {
      detachGa4 = attachGa4NetworkCapture(popup, captures, () => stepIndex, {
        contextId,
        forcedSource: "popup_context",
      });
    }
    if (wantsDataLayer) {
      detachPush = await attachDataLayerPushCapture(popup, captures, () => stepIndex, {
        contextId,
        forcedSource: "popup_context",
      });
    }

    // Bounded settle window: long enough for an already-in-flight beacon/push to land,
    // short enough not to meaningfully slow down a run that opens several such contexts.
    // Never fails the run if the popup navigates slowly or not at all -- both awaits are
    // best-effort. Adaptive settling (see CLAUDE.md and docs/architecture.md "Adaptive
    // settling"): the previous fixed POPUP_ADOPTION_WINDOW_MS wait is now this settle's
    // ceiling rather than an unconditional delay, so a popup whose beacon/push lands (and
    // whose DOM goes quiet) well before that window elapses no longer holds the run up for
    // the full fixed duration -- the common case, since a popup's own analytics activity
    // typically fires immediately on load, not near the end of a multi-second wait.
    await popup.waitForLoadState("domcontentloaded", { timeout: POPUP_ADOPTION_WINDOW_MS }).catch(() => {});
    await waitForAdaptiveSettle(popup, { ceilingMs: POPUP_ADOPTION_WINDOW_MS });

    if (wantsDataLayer) {
      const snapshot = await captureDataLayer(popup, stepIndex, { contextId, forcedSource: "popup_context" }).catch(
        () => [],
      );
      for (const entry of snapshot) {
        if (entry.raw.length === 0) {
          continue;
        }
        captures.data_layer_evidence = [...(captures.data_layer_evidence ?? []), entry];
      }
    }
  } finally {
    detachGa4?.();
    detachPush?.();
    await popup.close().catch(() => {});
  }

  const afterGa4Count = captures.ga4_network_events?.length ?? 0;
  const afterDataLayerCount = captures.data_layer_evidence?.length ?? 0;
  return { observed: afterGa4Count > beforeGa4Count || afterDataLayerCount > beforeDataLayerCount };
}

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): the single entry point actions/click.ts's popup handler now calls instead of
 * adoptPopupForCapture directly. When `surfaceAdoption` is absent/disabled, behaviour is
 * byte-for-byte the pre-PR-3 capture-only-and-close path (see
 * tests/integration/crossClientAnalyticsCapture.test.ts's own regression coverage). When
 * enabled, the popup is given a bounded chance to reach a real document (so its landing
 * hostname can actually be checked), decideSurfaceAdoption (core/surfaceAdoption.ts) is
 * consulted, and:
 *   - adopted: the popup is left open (never closed, never instrumented with the
 *     capture-only GA4/dataLayer listeners above -- once adopted it becomes the engine's own
 *     active surface and is captured/observed exactly like the main page from the next step
 *     on) after one settle wait so its own initial render has a chance to finish;
 *   - rejected: falls through to the exact same capture-only-and-close path as before,
 *     tagged with the specific rejection reason for diagnostics.
 */
export async function adoptOrCapturePopup(params: {
  popup: Page;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  surfaceAdoption?: SurfaceAdoptionRequest;
  /** Bounds the relevance gate's own bounded resettle pass -- see core/surfaceRelevance.ts. Same value actions/click.ts's own settle waits use for this click. */
  settleCeilingMs?: number;
}): Promise<AdoptOrCapturePopupResult> {
  const { popup, captures, stepIndex, captureModules, surfaceAdoption, settleCeilingMs } = params;

  if (!surfaceAdoption?.enabled) {
    return adoptPopupForCapture({ popup, captures, stepIndex, captureModules });
  }

  await popup.waitForLoadState("domcontentloaded", { timeout: POPUP_ADOPTION_WINDOW_MS }).catch(() => {});
  let popupUrl: string | undefined;
  try {
    popupUrl = popup.url();
  } catch {
    popupUrl = undefined;
  }

  // Surface-relevance assessment (PR 3, see CLAUDE.md and docs/architecture.md "Surface
  // adoption"): consulted before decideSurfaceAdoption, which remains the single,
  // untouched, authoritative source for the domain/budget decision itself. Cheaply
  // pre-checks the same budget decideSurfaceAdoption will check anyway, so a candidate that
  // would be rejected for budget reasons regardless never pays for relevance scoring. A
  // relevance-rejected candidate is returned immediately here and never reaches
  // decideSurfaceAdoption at all -- it therefore never increments adoptedSurfaceCount
  // (that only ever happens via core/loop.ts's RunState.pushSurface on a genuine adoption),
  // satisfying "relevance-rejected surfaces must not consume maxAdoptedSurfacesPerRun" by
  // construction. Skipped entirely (byte-for-byte prior behaviour) when the caller never set
  // relevanceObjectiveText -- see SurfaceAdoptionRequest's own doc comment.
  let relevanceAssessment: SurfaceRelevanceAssessment | undefined;
  if (surfaceAdoption.relevanceObjectiveText) {
    const budget = surfaceAdoption.maxAdoptedSurfacesPerRun ?? DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN;
    const budgetExhausted = surfaceAdoption.adoptedSurfaceCount >= budget;
    if (!budgetExhausted) {
      relevanceAssessment = await assessSurfaceRelevance({
        page: popup,
        objectiveText: surfaceAdoption.relevanceObjectiveText,
        settleCeilingMs,
        ambiguityResolver: surfaceAdoption.relevanceAmbiguityResolver,
      });
      if (!relevanceAssessment.relevant) {
        const captureResult = await adoptPopupForCapture({ popup, captures, stepIndex, captureModules });
        return { ...captureResult, adoptionRejectedReason: "relevance_rejected", relevanceAssessment };
      }
    }
  }

  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: surfaceAdoption.domainPolicy,
    popupUrl,
    allowedDomains: surfaceAdoption.allowedDomains,
    adoptedSurfaceCount: surfaceAdoption.adoptedSurfaceCount,
    maxAdoptedSurfacesPerRun: surfaceAdoption.maxAdoptedSurfacesPerRun,
  });

  if (decision.adopt) {
    await waitForAdaptiveSettle(popup, { ceilingMs: POPUP_ADOPTION_WINDOW_MS });
    return {
      observed: false,
      adoptedPage: popup,
      adoptedUrl: popupUrl,
      ...(decision.extendedAllowedDomain ? { extendedAllowedDomain: decision.extendedAllowedDomain } : {}),
      ...(relevanceAssessment ? { relevanceAssessment } : {}),
    };
  }

  const captureResult = await adoptPopupForCapture({ popup, captures, stepIndex, captureModules });
  return { ...captureResult, adoptionRejectedReason: decision.reason, ...(relevanceAssessment ? { relevanceAssessment } : {}) };
}
