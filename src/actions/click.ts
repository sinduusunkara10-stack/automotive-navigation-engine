import type { Frame, Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import {
  captureInteractionSnapshot,
  classifyObservedSurfaceChange,
  detectTargetAttributableSideEffect,
  elementLocatorSelector,
  readElementState,
  resolveElementActionTarget,
  targetElementSnapshot,
  waitForInteractionSideEffect,
  CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS,
  type ClickSideEffectType,
  type ElementState,
  type InteractionSnapshot,
  type ObservedSurfaceChangeType,
  type TargetElementSnapshot,
} from "../observation/observationBuilder.js";
import { checkNavigationAllowed } from "../safety/index.js";
import {
  assessNavigationRecovery,
  robustGoto,
  waitForAdaptiveSettle,
  DEFAULT_SETTLE_CEILING_MS,
  MAX_SETTLE_CEILING_MS,
  type RobustGotoOutcome,
  type SettleOutcome,
} from "../core/robustNavigation.js";
import { recordDiagnosticError } from "../capture-modules/errors.js";
import {
  adoptOrCapturePopup,
  type AdoptOrCapturePopupResult,
  type SurfaceAdoptionRequest,
} from "../capture-modules/popupCapture.js";
import { findNewPages } from "./pagesReconciliation.js";

const CLICK_ELEMENT_TIMEOUT_MS = 5000;

// browserContext.pages() reconciliation (surface-relevance corrective work, PR 2): the
// interval *between* polling checks, not the total detection window -- that stays tied to
// this click's own settle ceiling (default DEFAULT_SETTLE_CEILING_MS/3000ms, hard cap
// MAX_SETTLE_CEILING_MS/10000ms), never a separate, independent duration of its own.
const PAGES_RECONCILIATION_POLL_MS = 250;

const ALLOWED_FALLBACK_PROTOCOLS = new Set(["http:", "https:"]);

function safePageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

// Adaptive settling (see CLAUDE.md and docs/architecture.md "Adaptive settling"): PR 1C-a's
// original click-only settle wait (previously defined here as waitForDomSettle/
// waitForPostClickReadiness, capped at CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS/1000ms) has been
// generalized into core/robustNavigation.ts's waitForAdaptiveSettle, shared by every settle
// point in the engine (post-navigation, both click-settle paths below, the low-confidence
// retry, and popup-adoption settling) with a wider, task-configurable ceiling. See that
// module for the mechanism itself.
async function waitForPostClickReadiness(page: Page, ceilingMs?: number): Promise<SettleOutcome> {
  return waitForAdaptiveSettle(page, { ceilingMs });
}

export interface ExecuteClickParams {
  page: Page;
  action: SelectedAction;
  allowedDomains: string[];
  timeoutMs: number;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  // Set by core/loop.ts when its own pre-dispatch revalidation found the target already
  // stale and had to ask the reasoning provider again before reaching this action. Purely
  // informational for diagnostics -- it never changes what this executor does.
  reObservationAttempted?: boolean;
  // destinationUrl of the target as recorded in the observation the decision was actually
  // made from (core/loop.ts). Used only as a fallback source for the generic navigation
  // recovery below when the target has gone fully detached and can no longer be read live
  // -- a live read is always preferred when the element is still attached.
  knownDestinationUrl?: string;
  /** Task-level override for the adaptive settle ceiling (task.settling.maxSettleMs) -- see core/robustNavigation.ts. */
  settleCeilingMs?: number;
  /**
   * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
   * adoption"): built fresh by core/loop.ts for every click dispatch. Absent/undefined for
   * every call site that predates this PR and for any run with Safety.allowSurfaceAdoption
   * unset -- in both cases this executor's popup handling is byte-for-byte the pre-PR-3
   * capture-only-and-close path (see adoptOrCapturePopup's own doc comment).
   */
  surfaceAdoption?: SurfaceAdoptionRequest;
}

type ClickErrorCategory =
  | "detached"
  | "hidden"
  | "disabled"
  | "intercepted"
  | "timeout"
  | "frame_unavailable"
  | "popup_opened"
  | "unknown";

// A target in one of these categories failed only because it went stale (the DOM changed)
// between when it was decided on and when it was actually acted on -- never because it was
// a genuinely wrong or unsafe decision. "disabled" is deliberately excluded: a disabled
// control is a legitimate, already-visible-as-such fact the reasoning layer could already
// see, not a race condition. "popup_opened" belongs here too: the click itself was executed
// correctly against a genuinely valid target, but it opened a new browsing context (a
// target="_blank" anchor or a window.open() handler) rather than navigating the tracked
// page -- the same "not a wrong decision, just not yet made progress on the tracked page"
// situation, so it gets the same bounded, non-fatal retry treatment rather than being
// reported as an unqualified success. Drives ActionResult.staleTarget (see core/loop.ts's
// bounded, non-fatal recovery for exactly this class of failure).
const STALE_TARGET_CATEGORIES = new Set<ClickErrorCategory>([
  "detached",
  "hidden",
  "intercepted",
  "timeout",
  "frame_unavailable",
  "popup_opened",
]);

interface ClickDiagnostics {
  targetElementId: string;
  role?: string;
  visible: boolean;
  attached: boolean;
  enabled: boolean;
  hasDestinationUrl: boolean;
  locatorResolution: "resolved" | "not_found";
  clickErrorCategory: ClickErrorCategory;
  reObservationAttempted: boolean;
  fallbackNavigationAttempted: boolean;
  fallbackNavigationUsed: boolean;
  fallbackRejectedReason?: string;
  /**
   * Overlay-click-detection fix: whether a bounded post-click check ran at all looking for
   * generic evidence (a newly-appeared dialog, or a materially different interactive
   * surface) that this click actually succeeded despite looking intercepted/timed-out --
   * and, when it ran, what it found. Absent when no such check applied (e.g. the target was
   * never actionable to begin with, so no click was ever dispatched).
   */
  clickSideEffectChecked?: boolean;
  clickSideEffectDetected?: boolean;
  clickSideEffectType?: ClickSideEffectType;
  /**
   * Fallback-verification fix: whether the destinationUrl fallback's resulting page state
   * was verified as a genuine, meaningful change (a different page path/origin, or generic
   * post-click evidence of a new interactive surface) rather than assumed equivalent to a
   * real click purely because page.url() changed. Absent when no fallback was used.
   */
  fallbackVerified?: boolean;
  fallbackVerificationReason?: string;
}

function formatClickDiagnostics(d: ClickDiagnostics): string {
  return (
    `[diagnostics targetElementId=${d.targetElementId} role=${d.role ?? "unknown"} visible=${d.visible} ` +
    `attached=${d.attached} enabled=${d.enabled} hasDestinationUrl=${d.hasDestinationUrl} ` +
    `locatorResolution=${d.locatorResolution} clickErrorCategory=${d.clickErrorCategory} ` +
    `reObservationAttempted=${d.reObservationAttempted} fallbackNavigationAttempted=${d.fallbackNavigationAttempted} ` +
    `fallbackNavigationUsed=${d.fallbackNavigationUsed}` +
    (d.fallbackRejectedReason ? ` fallbackRejectedReason=${d.fallbackRejectedReason}` : "") +
    (d.clickSideEffectChecked !== undefined ? ` clickSideEffectChecked=${d.clickSideEffectChecked}` : "") +
    (d.clickSideEffectDetected !== undefined ? ` clickSideEffectDetected=${d.clickSideEffectDetected}` : "") +
    (d.clickSideEffectType ? ` clickSideEffectType=${d.clickSideEffectType}` : "") +
    (d.fallbackVerified !== undefined ? ` fallbackVerified=${d.fallbackVerified}` : "") +
    (d.fallbackVerificationReason ? ` fallbackVerificationReason=${d.fallbackVerificationReason}` : "") +
    `]`
  );
}

/**
 * Fallback-verification fix (see CLAUDE.md and docs/architecture.md "Fallback
 * verification"): a destinationUrl fallback is a raw page.goto(), never a real click, so it
 * is only trustworthy on its own terms when it actually reached a materially different page
 * (a different origin/path/query -- an ordinary GET navigation, exactly what it's built
 * for). When the fallback only changed the URL by its fragment (or query only, or nothing
 * detectable at all -- e.g. a same-document hash the site's own click handler would
 * otherwise have used to drive further, non-navigational DOM changes), the resulting page
 * state is verified against the pre-click InteractionSnapshot and the target's own
 * before/after state, using the same target-attributable evidence a direct-click side
 * effect requires (see detectTargetAttributableSideEffect): the URL change alone never
 * counts, and neither does an unattributed whole-page mutation.
 */
async function verifyFallbackNavigation(params: {
  page: Page;
  targetElementId: string;
  targetBeforeFallback: TargetElementSnapshot;
  preClickSnapshot: InteractionSnapshot;
  urlBeforeClick: string;
  resultingUrl: string;
}): Promise<{ verified: boolean; reason: string }> {
  const { page, targetElementId, targetBeforeFallback, preClickSnapshot, urlBeforeClick, resultingUrl } = params;

  let samePathAndOrigin = false;
  try {
    const before = new URL(urlBeforeClick);
    const after = new URL(resultingUrl);
    samePathAndOrigin = before.origin === after.origin && before.pathname === after.pathname && before.search === after.search;
  } catch {
    samePathAndOrigin = false;
  }
  if (!samePathAndOrigin) {
    return { verified: true, reason: "path_changed" };
  }

  const postSnapshot = await waitForInteractionSideEffect(page, preClickSnapshot);
  // Re-read the target's own live state after the fallback navigation -- a raw page.goto()
  // to a same-document URL is a different mechanism than a real click, so this is never
  // assumed unchanged; it is verified the same way a direct click's own target state is.
  const targetAfterFallback = targetElementSnapshot(await readElementState(page, targetElementId));
  const sideEffect = detectTargetAttributableSideEffect({
    before: preClickSnapshot,
    after: postSnapshot,
    targetBefore: targetBeforeFallback,
    targetAfter: targetAfterFallback,
  });
  if (sideEffect.detected) {
    return { verified: true, reason: sideEffect.type ?? "interactive_surface_changed" };
  }
  return { verified: false, reason: "unverified_hash_or_query_only_change" };
}

function categorizeUnactionableState(state: ElementState): ClickErrorCategory {
  if (state.frameUnavailable) {
    return "frame_unavailable";
  }
  if (!state.attached) {
    return "detached";
  }
  if (!state.visible) {
    return "hidden";
  }
  if (state.disabled) {
    return "disabled";
  }
  if (state.covered) {
    return "intercepted";
  }
  return "timeout";
}

interface FallbackOutcome {
  attempted: boolean;
  outcome?: RobustGotoOutcome;
  rejectedReason?: string;
}

/**
 * Generic, safety-respecting recovery for a click that could not be executed directly.
 * Only ever eligible for a real <a href> (destinationUrl is only ever populated from
 * HTMLAnchorElement.href -- see observationBuilder.ts/readElementState), so this can
 * never turn into a form submission: it is always a plain GET navigation to a URL the
 * page itself already advertised, never inferred from anchor text or any other content.
 */
async function attemptFallbackNavigation(params: {
  page: Page;
  destinationUrl: string | undefined;
  allowedDomains: string[];
  timeoutMs: number;
}): Promise<FallbackOutcome> {
  const { page, destinationUrl, allowedDomains, timeoutMs } = params;

  if (!destinationUrl) {
    return { attempted: false, rejectedReason: "no_destination_url" };
  }

  let protocol: string;
  try {
    protocol = new URL(destinationUrl).protocol;
  } catch {
    return { attempted: false, rejectedReason: "unparseable_destination_url" };
  }
  if (!ALLOWED_FALLBACK_PROTOCOLS.has(protocol)) {
    return { attempted: false, rejectedReason: "unsafe_protocol" };
  }
  if (!checkNavigationAllowed(destinationUrl, allowedDomains)) {
    return { attempted: false, rejectedReason: "outside_allowed_domains" };
  }

  const outcome = await robustGoto({ page, url: destinationUrl, allowedDomains, timeoutMs });
  return { attempted: true, outcome };
}

/**
 * Resolves a click that cannot be (or could not be) executed directly: attempts the
 * generic destinationUrl fallback (item 7 of the action-execution-consistency fix) and
 * builds a rich, generic diagnostic message either way. Shared by the pre-click
 * revalidation short-circuit and the post-click recoverable-error handler below so both
 * paths produce identical diagnostics.
 */
async function resolveUnactionableClick(params: {
  page: Page;
  targetElementId: string;
  category: ClickErrorCategory;
  state: ElementState;
  allowedDomains: string[];
  timeoutMs: number;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  reObservationAttempted: boolean;
  originalErrorMessage?: string;
  preClickSnapshot: InteractionSnapshot;
  urlBeforeClick: string;
  /** Set only when a click was actually dispatched and a side-effect check already ran and found nothing -- purely for diagnostics completeness (requirement A.6/B.12). */
  clickSideEffectChecked?: boolean;
  /** Set only when this click produced a popup/new-context event -- see popupCapture.ts. Merged verbatim into the returned ActionResult either way. */
  openedNewContext?: boolean;
  observedNewContext?: boolean;
}): Promise<ActionResult> {
  const {
    page,
    targetElementId,
    category,
    state,
    allowedDomains,
    timeoutMs,
    captures,
    stepIndex,
    captureModules,
    reObservationAttempted,
    originalErrorMessage,
    preClickSnapshot,
    urlBeforeClick,
    clickSideEffectChecked,
    openedNewContext,
    observedNewContext,
  } = params;

  const fallback = await attemptFallbackNavigation({
    page,
    destinationUrl: state.destinationUrl,
    allowedDomains,
    timeoutMs,
  });
  const fallbackSucceeded = Boolean(fallback.attempted && fallback.outcome && fallback.outcome.status !== "failed");

  let fallbackVerification: { verified: boolean; reason: string } | undefined;
  if (fallbackSucceeded && fallback.outcome) {
    fallbackVerification = await verifyFallbackNavigation({
      page,
      targetElementId,
      targetBeforeFallback: targetElementSnapshot(state),
      preClickSnapshot,
      urlBeforeClick,
      resultingUrl: fallback.outcome.url,
    });
  }

  const diagnostics: ClickDiagnostics = {
    targetElementId,
    role: state.role,
    visible: state.visible,
    attached: state.attached,
    enabled: !state.disabled,
    hasDestinationUrl: Boolean(state.destinationUrl),
    locatorResolution: state.attached ? "resolved" : "not_found",
    clickErrorCategory: category,
    reObservationAttempted,
    fallbackNavigationAttempted: fallback.attempted,
    fallbackNavigationUsed: fallbackSucceeded,
    fallbackRejectedReason: fallback.rejectedReason,
    ...(clickSideEffectChecked !== undefined ? { clickSideEffectChecked, clickSideEffectDetected: false } : {}),
    ...(fallbackVerification
      ? { fallbackVerified: fallbackVerification.verified, fallbackVerificationReason: fallbackVerification.reason }
      : {}),
  };

  if (fallbackSucceeded && fallback.outcome) {
    // Target-attributable click-success fix: fallbackVerified is no longer diagnostic-only.
    // An unverified fallback (same path/origin, no target-attributable evidence -- see
    // verifyFallbackNavigation above) previously still reported an unqualified success on
    // the strength of the URL change alone; it now falls through to the same
    // staleTarget-classified failure path a directly-intercepted click uses, giving the
    // reasoning layer a further bounded chance (core/loop.ts's existing stale-target
    // recovery -- MAX_STALE_TARGET_RECOVERY_ATTEMPTS) instead of silently reporting
    // progress that was never actually confirmed.
    if (fallbackVerification?.verified === false) {
      if (captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          stepIndex,
          category: "navigation_failure",
          severity: "warning",
          pageUrl: fallback.outcome.url,
          actionType: "click",
          targetElementId,
          message:
            `Click target was not directly clickable (${category}); the generic destinationUrl ` +
            `navigation fallback changed the URL but produced no target-attributable evidence of a ` +
            `real state change (${fallbackVerification.reason}) -- not reporting this as a successful ` +
            `action. ${formatClickDiagnostics(diagnostics)}` +
            (originalErrorMessage ? ` Original click error: ${originalErrorMessage}` : ""),
          recoverable: true,
          stoppedRun: false,
        });
      }
      return {
        success: false,
        error:
          `click target not actionable (${category}); the destinationUrl fallback changed the URL but ` +
          `produced no verified evidence of a real state change (${fallbackVerification.reason}). ` +
          `${formatClickDiagnostics(diagnostics)}` +
          (originalErrorMessage ? ` Original click error: ${originalErrorMessage}` : ""),
        resultingUrl: fallback.outcome.url,
        fallbackVerified: false,
        fallbackVerificationReason: fallbackVerification.reason,
        staleTarget: true,
        ...(openedNewContext ? { openedNewContext, observedNewContext: Boolean(observedNewContext) } : {}),
      };
    }

    if (captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        stepIndex,
        category: "navigation_failure",
        severity: "warning",
        pageUrl: fallback.outcome.url,
        actionType: "click",
        targetElementId,
        message:
          `Click target was not directly clickable (${category}); used the generic destinationUrl ` +
          `navigation fallback instead. ${formatClickDiagnostics(diagnostics)}` +
          (originalErrorMessage ? ` Original click error: ${originalErrorMessage}` : ""),
        recoverable: true,
        stoppedRun: false,
      });
    }
    return {
      success: true,
      resultingUrl: fallback.outcome.url,
      fallbackVerified: fallbackVerification?.verified ?? true,
      ...(fallbackVerification ? { fallbackVerificationReason: fallbackVerification.reason } : {}),
      ...(openedNewContext ? { openedNewContext, observedNewContext: Boolean(observedNewContext) } : {}),
      // Click-success/milestone-evidence corrective work: a verified destinationUrl fallback
      // is one of the fixed evidence classes strong enough for core/loop.ts to forward this
      // click's LastActionEvidence to the milestone verifier -- see ActionResult.
      // verifiedSuccessType's own doc comment.
      verifiedSuccessType: "destination_fallback_verified",
    };
  }

  const fallbackDetail = fallback.attempted
    ? `fallback navigation itself failed: ${fallback.outcome?.message ?? "unknown navigation error"}`
    : `fallback navigation not attempted (${fallback.rejectedReason ?? "ineligible"})`;

  return {
    success: false,
    error:
      `click target not actionable (${category}); ${fallbackDetail}. ${formatClickDiagnostics(diagnostics)}` +
      (originalErrorMessage ? ` Original click error: ${originalErrorMessage}` : ""),
    // See STALE_TARGET_CATEGORIES above: this failure's category means the target went
    // stale between decision and dispatch, not that the decision was actually wrong --
    // core/loop.ts uses this to give Navigation Claude a bounded number of further chances
    // (a fresh observation, a new decision) instead of ending the whole run on the spot.
    ...(STALE_TARGET_CATEGORIES.has(category) ? { staleTarget: true } : {}),
    ...(openedNewContext ? { openedNewContext, observedNewContext: Boolean(observedNewContext) } : {}),
  };
}

/**
 * Executes the `click` action. Before ever touching Playwright, the target's live state
 * is revalidated (item 5/6 of the action-execution-consistency fix): a target that has
 * gone stale since it was observed (removed, hidden, disabled, or covered) is never
 * blindly clicked -- it goes straight to the generic destinationUrl fallback below. If the
 * target still looks actionable but the click itself fails for a recoverable (timeout-
 * class) reason -- a race against something that changed at the exact moment of the click,
 * e.g. a toast/overlay appearing mid-gesture -- the same fallback is attempted before
 * giving up. Clicking the element itself uses a short, fixed timeout (unrelated to
 * navigation -- it is about interactability, not page loading). If the click causes a
 * document navigation, that navigation is then waited on with the same robust behaviour as
 * the `navigate` action and the engine's initial navigation: only "domcontentloaded" is
 * required, a timeout is given one chance to recover if a usable document was already
 * reached, and the resulting URL (including any redirect) is checked against
 * allowedDomains before the click is reported as successful. A click that never triggers
 * navigation at all (a toggle/expand button, say) is not made to pay this
 * navigation-timeout budget -- it only pays the same adaptive settle wait used for detecting
 * a delayed popup/new-tab below. A click that opens a new
 * browsing context instead of navigating the tracked page (target="_blank", window.open())
 * is never reported as an unqualified success either: the new context is closed and the
 * same generic destinationUrl fallback is attempted on the tracked page, since there is
 * nothing else the engine could otherwise observe changing.
 */
export async function executeClick(params: ExecuteClickParams): Promise<ActionResult> {
  const {
    page,
    action,
    allowedDomains,
    timeoutMs,
    captures,
    stepIndex,
    captureModules,
    reObservationAttempted,
    knownDestinationUrl,
    settleCeilingMs,
    surfaceAdoption,
  } = params;

  if (!action.target) {
    return { success: false, error: "click action requires a target element id" };
  }

  const targetElementId = action.target;
  const selector = elementLocatorSelector(targetElementId);

  // Captured unconditionally, before anything else touches the page -- both the
  // overlay-click side-effect check and the destinationUrl fallback-verification check
  // below need a true "before" baseline, regardless of which path this call ends up
  // taking. Lightweight (a single lightweight evaluate call, main document only -- see
  // observation/observationBuilder.ts's own doc comment on InteractionSnapshot).
  const urlBeforeClick = safePageUrl(page) ?? "";
  const preClickSnapshot = await captureInteractionSnapshot(page).catch(
    (): InteractionSnapshot => ({ hasDialog: false, interactiveIdentities: [] }),
  );

  const preClickState = await readElementState(page, targetElementId);
  if (!preClickState.actionable) {
    return resolveUnactionableClick({
      page,
      targetElementId,
      category: categorizeUnactionableState(preClickState),
      state: { ...preClickState, destinationUrl: preClickState.destinationUrl ?? knownDestinationUrl },
      allowedDomains,
      timeoutMs,
      captures,
      stepIndex,
      captureModules,
      reObservationAttempted: reObservationAttempted ?? false,
      preClickSnapshot,
      urlBeforeClick,
    });
  }

  // Resolved fresh right before dispatch (never a cached handle from the readElementState
  // call above) -- a same-origin child frame can itself be removed in the gap between the
  // two, same as any other element going stale. See observation/frames.ts.
  const clickTarget = await resolveElementActionTarget(page, targetElementId);
  if (!clickTarget) {
    return resolveUnactionableClick({
      page,
      targetElementId,
      category: "frame_unavailable",
      state: { ...preClickState, destinationUrl: preClickState.destinationUrl ?? knownDestinationUrl },
      allowedDomains,
      timeoutMs,
      captures,
      stepIndex,
      captureModules,
      reObservationAttempted: reObservationAttempted ?? false,
      preClickSnapshot,
      urlBeforeClick,
    });
  }

  let mainFrameNavigated = false;
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      mainFrameNavigated = true;
    }
  };
  // Generic, brand/site-agnostic detection of a click that opens a new browsing context
  // (a target="_blank" anchor, or a window.open() call from a click handler) instead of
  // navigating the tracked page itself -- Playwright never fires "framenavigated" on this
  // page's main frame for that case, so without this the click below would otherwise be
  // reported an unqualified success with the URL/title left completely unchanged.
  let popupOpened: Page | undefined;
  // Started the instant a popup candidate is claimed (by either the "popup" event below or
  // the pages()-reconciliation poll) -- before returning control to the event loop for
  // anything else -- so GA4/dataLayer capture is attached to the new context as early as
  // possible (item A.3 of the popup/new-context capture fix), well before a fast local/
  // CDN-hosted destination page could otherwise load and fire its own beacon/push unobserved.
  // Whichever branch below ends up handling this click simply awaits this already-in-flight
  // promise rather than starting adoption itself.
  let popupAdoption: Promise<AdoptOrCapturePopupResult> | undefined;
  // browserContext.pages() reconciliation (surface-relevance corrective work, PR 2): both
  // discovery mechanisms below (the "popup" event and the polling loop) route through this
  // single claim function so at most one candidate is ever adopted per click (the existing,
  // unchanged one-popup-per-click model) and the same page is never processed twice if both
  // mechanisms happen to observe it.
  const claimedPopupCandidates = new Set<Page>();
  const claimPopupCandidate = (candidate: Page) => {
    if (popupOpened || claimedPopupCandidates.has(candidate) || candidate.isClosed()) {
      return;
    }
    claimedPopupCandidates.add(candidate);
    popupOpened = candidate;
    popupAdoption = adoptOrCapturePopup({
      popup: candidate,
      captures,
      stepIndex,
      captureModules,
      surfaceAdoption,
      settleCeilingMs,
    }).catch(() => ({ observed: false }));
  };
  const onPopup = (popup: Page) => claimPopupCandidate(popup);
  // Registered before the click so a navigation (or popup) that commits fast is never missed.
  page.on("framenavigated", onFrameNavigated);
  page.on("popup", onPopup);

  // browserContext.pages() reconciliation (surface-relevance corrective work, PR 2 -- see
  // CLAUDE.md and docs/architecture.md "Surface adoption"): a backstop alongside the "popup"
  // event above, polling browserContext.pages() on a fixed interval for a new Page the
  // "popup" event might have missed -- including one that opens after the tracked page has
  // already gone fully DOM-quiet, which is exactly the gap PR 1's own doc comment (below)
  // documents as still open at the end of that PR. Snapshotting context.pages() here, before
  // the click, means anything already open (the tracked page itself included) is never
  // mistaken for a new candidate. Only runs when this run actually requested surface adoption
  // (surfaceAdoption?.enabled) -- a task that never sets allowSurfaceAdoption pays nothing
  // extra here, since nothing downstream would ever use a discovered page anyway.
  const context = page.context();
  const prePagesSnapshot = context.pages();
  const clickDispatchedAt = Date.now();
  const pagesReconciliationTimer: NodeJS.Timeout | undefined = surfaceAdoption?.enabled
    ? setInterval(() => {
        for (const candidate of findNewPages(prePagesSnapshot, context.pages())) {
          claimPopupCandidate(candidate);
        }
      }, PAGES_RECONCILIATION_POLL_MS)
    : undefined;

  try {
    await clickTarget.click(selector, { timeout: CLICK_ELEMENT_TIMEOUT_MS });
  } catch (error) {
    clearInterval(pagesReconciliationTimer);
    page.off("framenavigated", onFrameNavigated);
    page.off("popup", onPopup);
    const openedNewContext = Boolean(popupOpened);
    const observedNewContext = popupAdoption ? (await popupAdoption).observed : false;
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) {
      return {
        success: false,
        error: message,
        ...(openedNewContext ? { openedNewContext, observedNewContext } : {}),
      };
    }

    const postFailureState = await readElementState(page, targetElementId);
    const category = categorizeUnactionableState(postFailureState);

    // Overlay-click-detection fix (see CLAUDE.md and docs/architecture.md "Overlay-click
    // side effect detection"): a click that timed out because the target became
    // covered/intercepted is not necessarily a failed click -- it can equally mean the
    // click *succeeded* and the overlay it opened is now sitting on top of its own trigger,
    // which is exactly what Playwright's own actionability retry loop reports as
    // "intercepts pointer events". Before ever discarding that state and falling through to
    // the generic destinationUrl fallback (which, for a same-document hash-only href, can
    // never reproduce a click handler's own DOM effects -- see actions/click.ts's module
    // doc comment), check for generic evidence that a real interaction-state change already
    // happened. Deliberately narrow: only attempted for "intercepted" (the category is
    // reached specifically because the post-failure re-check found the target now covered
    // by some other element -- see categorizeUnactionableState), never for the broader
    // catch-all "timeout" (a click can time out for reasons -- e.g. pointer-events: none --
    // with no plausible connection to a new interactive surface having appeared) or
    // "disabled" (a legitimate, already-visible fact, not a race). Target-attributable
    // click-success fix: the evidence checked here must be attributable to the clicked
    // target itself (its own aria-expanded/covered state changing, or it disappearing) --
    // an unrelated element elsewhere on the page changing at the same moment (e.g. a
    // cookie/consent overlay re-rendering independently of this click) no longer counts;
    // see detectTargetAttributableSideEffect.
    if (category === "intercepted") {
      const postClickSnapshot = await waitForInteractionSideEffect(page, preClickSnapshot);
      const sideEffect = detectTargetAttributableSideEffect({
        before: preClickSnapshot,
        after: postClickSnapshot,
        targetBefore: targetElementSnapshot(preClickState),
        targetAfter: targetElementSnapshot(postFailureState),
      });
      if (sideEffect.detected) {
        // Corrective fix (half-window settle/surface-signal gap -- see CLAUDE.md and
        // docs/architecture.md "Surfaces, drawers and half-windows"): detectTargetAttributableSideEffect
        // above can return detected:true the instant the target's own hit-test becomes
        // covered -- e.g. a drawer's backdrop mounting -- well before the drawer's own
        // content (a "Request a Quote"-style control) has finished rendering. Two gaps
        // previously existed here, both fixed together since they compound: (1) this path
        // never gave the page the same bounded, DOM-mutation-quiet settle window
        // waitForPostClickReadiness already gives the *other* click-success path, so the
        // very next observation could be taken before the surface's own content had
        // rendered; (2) this path never computed classifyObservedSurfaceChange at all, so
        // ActionResult.surfaceChangeDetected/surfaceChangeType were silently left unset --
        // starving core/loop.ts's low-confidence recovery (gated on exactly that field) of
        // the one signal it needs to recognise this exact situation.
        const settleDiagnostic = await waitForPostClickReadiness(page, settleCeilingMs);
        const settledSnapshot = await captureInteractionSnapshot(page).catch(() => postClickSnapshot);
        const observedSurfaceChange = classifyObservedSurfaceChange(preClickSnapshot, settledSnapshot);
        const reportableSurfaceChangeType: ObservedSurfaceChangeType | undefined =
          observedSurfaceChange.type === "dialog_appeared" ||
          observedSurfaceChange.type === "dialog_changed" ||
          observedSurfaceChange.type === "layer_panel_appeared"
            ? observedSurfaceChange.type
            : undefined;

        // Click-success/milestone-evidence corrective work (2026-09-21, see BMW live-site
        // investigation): sideEffect.detected alone -- the target's own covered/disappeared/
        // aria-expanded state flipping, with no corroboration -- is not sufficient evidence
        // this click actually opened a real surface. It can equally mean the target was
        // covered or replaced by something unrelated to the click succeeding (a re-render, a
        // lazy-load reflow, a transient hover layer Playwright's own actionability retries
        // can themselves induce). A standards-based dialog signal (detectDialogSideEffect,
        // reused inside detectTargetAttributableSideEffect -- sideEffect.type
        // "dialog_appeared"/"dialog_changed") stays trusted unconditionally, exactly as
        // before: that markup is a page-author-declared fact, not a heuristic. The weaker
        // covered/disappeared/aria-expanded signal now additionally requires the same
        // settled, corroborating classification already computed above for an unrelated
        // purpose (reportableSurfaceChangeType) to agree -- a genuine dialog or a settled,
        // multi-control panel that survived the same bounded settle wait every other
        // click-success path already goes through. Never anything BMW/site-specific: purely
        // structural signals the engine already computes.
        const isStandardsBasedDialogSignal = sideEffect.type === "dialog_appeared" || sideEffect.type === "dialog_changed";
        const verifiedSuccessType: ActionResult["verifiedSuccessType"] = isStandardsBasedDialogSignal
          ? "dialog"
          : reportableSurfaceChangeType === "dialog_appeared" || reportableSurfaceChangeType === "dialog_changed"
            ? "dialog"
            : reportableSurfaceChangeType === "layer_panel_appeared"
              ? "settled_panel"
              : undefined;

        if (verifiedSuccessType) {
          if (captureModules.includes("errors")) {
            recordDiagnosticError(captures, {
              stepIndex,
              category: "stale_target_recovery",
              severity: "info",
              pageUrl: safePageUrl(page),
              actionType: "click",
              targetElementId,
              message:
                `Click target appeared to fail (${category}), but a bounded post-click check found generic ` +
                `evidence (${sideEffect.type}), corroborated by a settled ${verifiedSuccessType} signal, that ` +
                `the click actually succeeded and the target became covered by the very interactive surface ` +
                `it opened; reporting success without using the destinationUrl fallback. Original click error: ${message}`,
              recoverable: true,
              stoppedRun: false,
            });
          }
          return {
            success: true,
            resultingUrl: safePageUrl(page) ?? urlBeforeClick,
            clickSideEffectDetected: true,
            verifiedSuccessType,
            ...(reportableSurfaceChangeType ? { surfaceChangeDetected: true, surfaceChangeType: reportableSurfaceChangeType } : {}),
            ...(openedNewContext ? { openedNewContext, observedNewContext } : {}),
            settleDiagnostic,
          };
        }

        // Uncorroborated: the target's own state changed, but neither a standards-based
        // dialog nor a settled multi-control panel backs it up. Do not report success on
        // this evidence alone -- fall through to the same destinationUrl fallback and bounded
        // stale-target recovery every other unactionable-click category already uses.
        if (captureModules.includes("errors")) {
          recordDiagnosticError(captures, {
            stepIndex,
            category: "stale_target_recovery",
            severity: "info",
            pageUrl: safePageUrl(page),
            actionType: "click",
            targetElementId,
            message:
              `Click target appeared to fail (${category}); a bounded post-click check found only weak, ` +
              `uncorroborated evidence (${sideEffect.type}) that the target's own state changed, with no ` +
              `standards-based dialog or settled panel to corroborate it -- not reporting this as a ` +
              `successful action; continuing to the destinationUrl fallback. Original click error: ${message}`,
            recoverable: true,
            stoppedRun: false,
          });
        }
      }
    }

    return resolveUnactionableClick({
      page,
      targetElementId,
      category,
      // Prefer the freshest destinationUrl, falling back to the pre-click read and then
      // to the decision-time observation for a target that has since gone fully detached
      // and can no longer be read live at all.
      state: {
        ...postFailureState,
        destinationUrl: postFailureState.destinationUrl ?? preClickState.destinationUrl ?? knownDestinationUrl,
      },
      allowedDomains,
      timeoutMs,
      captures,
      stepIndex,
      captureModules,
      reObservationAttempted: reObservationAttempted ?? false,
      originalErrorMessage: message,
      preClickSnapshot,
      urlBeforeClick,
      clickSideEffectChecked: category === "intercepted",
      openedNewContext,
      observedNewContext,
    });
  }

  // Delayed surface detection (surface-relevance corrective work, PR 1 -- see CLAUDE.md and
  // docs/architecture.md "Surface adoption"): the popup listener must stay armed for at least
  // as long as this click's own settle wait actually runs, not a fixed short grace window --
  // previously it was torn down after a fixed 250ms window regardless of what the settle wait
  // below would otherwise have done, so a popup opening any time after 250ms was missed even
  // while the page was still demonstrably busy (DOM mutating / interactive-element count
  // changing). Reusing the exact same wait the non-popup success path already needs (rather
  // than a second, independent timer) ties detection lifetime to the same "is anything still
  // happening" signal already used for settling -- no new constant. Computed once here, while
  // the listener is still armed, and reused below as this click's own settleDiagnostic when no
  // popup was found, rather than waiting a second time.
  let preliminarySettleDiagnostic: SettleOutcome | undefined;
  if (!mainFrameNavigated) {
    preliminarySettleDiagnostic = await waitForPostClickReadiness(page, settleCeilingMs);
    // browserContext.pages() reconciliation (surface-relevance corrective work, PR 2): the
    // settle probe above can (and often does, on an otherwise DOM-quiet page) resolve well
    // before this click's own settle ceiling -- that early exit is exactly the gap PR 1's own
    // history documents as still open (a popup with no correlated tracked-page activity, the
    // real shape of the production evidence that originally surfaced this whole area). When
    // reconciliation is active, keep polling for the *remainder* of the same ceiling budget
    // already committed to above (clickDispatchedAt + ceilingMs) -- never a second, additional
    // full ceiling stacked on top of the settle probe's own wait -- until either a candidate is
    // claimed or the ceiling is reached. Deliberate, opt-in latency trade-off, not a free
    // improvement: a run with allowSurfaceAdoption enabled now waits up to its full settle
    // ceiling on every non-navigating, non-popup click rather than returning as soon as the
    // tracked page itself looks quiet -- see this PR's own report for that cost stated
    // explicitly, not asserted away.
    if (pagesReconciliationTimer) {
      const ceilingMs = Math.min(settleCeilingMs ?? DEFAULT_SETTLE_CEILING_MS, MAX_SETTLE_CEILING_MS);
      const deadline = clickDispatchedAt + ceilingMs;
      while (!popupOpened && Date.now() < deadline) {
        await page.waitForTimeout(Math.min(PAGES_RECONCILIATION_POLL_MS, Math.max(deadline - Date.now(), 0))).catch(() => {});
      }
    }
  }
  clearInterval(pagesReconciliationTimer);
  page.off("framenavigated", onFrameNavigated);
  page.off("popup", onPopup);

  if (!mainFrameNavigated && popupOpened) {
    const popup = popupOpened;
    const popupUrl = safePageUrl(popup);
    // Popup/new-context capture (see capture-modules/popupCapture.ts): rather than closing
    // this context unobserved, it was already adopted (see popupAdoption above, started the
    // instant the "popup" event fired) for a short, bounded window so any GA4
    // request/dataLayer push it fires (exactly the evidence a "Request a Quote"/"View
    // Offer Details"-style CTA that opens a new tab would otherwise lose entirely) is
    // still captured, tagged with its own popup_context/contextId provenance, before it is
    // closed. Navigation safety/allowedDomains handling below is unchanged: the engine
    // still only ever continues navigating the one tracked `page`.
    const popupOutcome = popupAdoption ? await popupAdoption : { observed: false };
    // Surface adoption (Phase 3 PR 3): the one case above stops being true. When
    // adoptOrCapturePopup actually kept this popup open (surfaceAdoption was enabled and
    // decideSurfaceAdoption approved it), this click is a genuine success -- it just didn't
    // navigate the *tracked* page, because it deliberately opened a new one that the engine
    // is about to make its new active surface instead. The live Page is handed back via
    // surfaceAdoption.adopted (never through this JSON-serializable ActionResult -- see
    // SurfaceAdoptionRequest's own doc comment); core/loop.ts reads it immediately after
    // this call returns and turns it into a RunState.pushSurface.
    if (popupOutcome.adoptedPage && surfaceAdoption) {
      surfaceAdoption.adopted = {
        page: popupOutcome.adoptedPage,
        url: popupOutcome.adoptedUrl,
        ...(popupOutcome.extendedAllowedDomain ? { extendedAllowedDomain: popupOutcome.extendedAllowedDomain } : {}),
      };
      return {
        success: true,
        resultingUrl: popupOutcome.adoptedUrl ?? popupUrl,
        surfaceAdopted: true,
        openedNewContext: true,
        // Click-success/milestone-evidence corrective work: an adopted surface already
        // cleared PR 3's relevance gate -- strong enough evidence for core/loop.ts to forward
        // LastActionEvidence to the milestone verifier. See ActionResult.verifiedSuccessType.
        verifiedSuccessType: "new_context_adopted",
        // Surface-relevance corrective work (PR 6): wire the same relevance/consent evidence
        // adoptOrCapturePopup already computed onto the JSON-serializable ActionResult, so an
        // adopted candidate reports *why* it cleared the gate, not only that it was adopted.
        ...(popupOutcome.relevanceAssessment
          ? { relevanceScore: popupOutcome.relevanceAssessment.score, relevanceTier: popupOutcome.relevanceAssessment.tier }
          : {}),
        ...(popupOutcome.consentOnlyCandidateHandling?.actionSucceeded ? { consentActionTaken: true } : {}),
        ...(popupOutcome.extendedAllowedDomain ? { extendedAllowedDomain: popupOutcome.extendedAllowedDomain } : {}),
      };
    }
    const observedNewContext = popupOutcome.observed;
    const postPopupState = await readElementState(page, targetElementId);
    const unactionableResult = await resolveUnactionableClick({
      page,
      targetElementId,
      category: "popup_opened",
      state: {
        ...postPopupState,
        destinationUrl: postPopupState.destinationUrl ?? preClickState.destinationUrl ?? knownDestinationUrl,
      },
      allowedDomains,
      timeoutMs,
      captures,
      stepIndex,
      captureModules,
      reObservationAttempted: reObservationAttempted ?? false,
      originalErrorMessage:
        `click opened a new browsing context (popup/tab)${popupUrl ? ` at ${popupUrl}` : ""} instead of ` +
        `navigating the tracked page; the tracked page's URL and title are unchanged`,
      preClickSnapshot,
      urlBeforeClick,
      openedNewContext: true,
      observedNewContext,
    });
    // "adoption_disabled" is deliberately never reachable here: this whole popupAdoption
    // path only ever calls decideSurfaceAdoption (core/surfaceAdoption.ts) with
    // allowSurfaceAdoption: true (see adoptOrCapturePopup's own early-return guard) --
    // ActionResult.adoptionRejectedReason's narrower three-value type reflects that.
    const reportableReason =
      popupOutcome.adoptionRejectedReason === "domain_rejected" ||
      popupOutcome.adoptionRejectedReason === "budget_exhausted" ||
      popupOutcome.adoptionRejectedReason === "relevance_rejected"
        ? popupOutcome.adoptionRejectedReason
        : undefined;
    return {
      ...unactionableResult,
      ...(reportableReason ? { adoptionRejectedReason: reportableReason } : {}),
      // Surface-relevance corrective work (PR 6): reported on a rejected candidate too, not
      // only an adopted one -- this is the evidence for *why* relevance_rejected fired.
      ...(popupOutcome.relevanceAssessment
        ? { relevanceScore: popupOutcome.relevanceAssessment.score, relevanceTier: popupOutcome.relevanceAssessment.tier }
        : {}),
      ...(popupOutcome.consentOnlyCandidateHandling?.actionSucceeded ? { consentActionTaken: true } : {}),
    };
  }

  if (!mainFrameNavigated) {
    // PR 1C-a (replace fixed timing dependency), generalized by the Phase 3 adaptive-
    // settling pass: bounded, DOM-mutation/interactive-element-aware readiness wait in place
    // of a fixed sleep -- see waitForPostClickReadiness above. Applies to every non-navigating
    // click uniformly; nothing here knows or cares what kind of element was clicked. Already
    // computed above (preliminarySettleDiagnostic) while the popup listener was still armed --
    // never re-run.
    const settleDiagnostic = preliminarySettleDiagnostic as SettleOutcome;
    // One additional, single lightweight snapshot (no extra polling/wait budget beyond the
    // settle wait just above) so a click that succeeded outright -- never even looking
    // intercepted -- but opened a same-document modal/drawer is still correctly reported as
    // having produced a real interaction-state change, for core/loop.ts's route-memory
    // classification (requirement E) as much as for the overlay-detection case above.
    const postSnapshot = await captureInteractionSnapshot(page).catch(() => preClickSnapshot);
    const postClickTargetState = await readElementState(page, targetElementId).catch(() => preClickState);
    const sideEffect = detectTargetAttributableSideEffect({
      before: preClickSnapshot,
      after: postSnapshot,
      targetBefore: targetElementSnapshot(preClickState),
      targetAfter: targetElementSnapshot(postClickTargetState),
    });
    // PR 1C-a (drawer/modal/half-window detection beyond role="dialog"/aria-modal, post-click
    // surface awareness): a *separate*, deliberately lower-stakes classification from the
    // target-attributed sideEffect above -- see classifyObservedSurfaceChange's own doc
    // comment for why it is safe to use the broader, non-target-attributed panel/elements-
    // count heuristic here. Only the two confident types (a dialog, or a large co-occurring
    // panel) are surfaced -- the weaker, elements-count-only "elements_appeared" case is used
    // solely for the readiness wait's own early exit, never reported onward, to keep this new
    // prompt-context signal itself conservative.
    const observedSurfaceChange = classifyObservedSurfaceChange(preClickSnapshot, postSnapshot);
    const reportableSurfaceChangeType: ObservedSurfaceChangeType | undefined =
      observedSurfaceChange.type === "dialog_appeared" ||
      observedSurfaceChange.type === "dialog_changed" ||
      observedSurfaceChange.type === "layer_panel_appeared"
        ? observedSurfaceChange.type
        : undefined;
    // Click-success/milestone-evidence corrective work: this click dispatched cleanly (no
    // Playwright-level error at all), which is already stronger evidence than the recovered-
    // from-failure path above -- but a plain click with no further observable effect (a
    // toggle/checkbox, say) still isn't strong enough on its own to let LastActionEvidence
    // corroborate a milestone describing a destination reached. Only tag it when the same
    // settled dialog/panel corroboration used above is also present here.
    const verifiedSuccessType: ActionResult["verifiedSuccessType"] =
      reportableSurfaceChangeType === "dialog_appeared" || reportableSurfaceChangeType === "dialog_changed"
        ? "dialog"
        : reportableSurfaceChangeType === "layer_panel_appeared"
          ? "settled_panel"
          : undefined;
    return {
      success: true,
      resultingUrl: safePageUrl(page) ?? urlBeforeClick,
      ...(sideEffect.detected ? { clickSideEffectDetected: true } : {}),
      ...(reportableSurfaceChangeType ? { surfaceChangeDetected: true, surfaceChangeType: reportableSurfaceChangeType } : {}),
      ...(verifiedSuccessType ? { verifiedSuccessType } : {}),
      settleDiagnostic,
    };
  }

  let outcomeUrl: string;
  let recoveredMessage: string | undefined;

  try {
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    outcomeUrl = page.url();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) {
      return { success: false, error: message };
    }

    const recovery = await assessNavigationRecovery(page, allowedDomains);
    if (!recovery.recoverable) {
      return { success: false, error: message, ...(recovery.url ? { resultingUrl: recovery.url } : {}) };
    }

    outcomeUrl = recovery.url;
    recoveredMessage =
      `Click navigation exceeded ${timeoutMs}ms before reaching full "load"-equivalent completion, but a ` +
      `usable document at ${recovery.url} was already available after "domcontentloaded"; continuing. ` +
      `Original error: ${message}`;
  }

  if (!checkNavigationAllowed(outcomeUrl, allowedDomains)) {
    return { success: false, error: `click navigation landed outside allowedDomains: ${outcomeUrl}`, resultingUrl: outcomeUrl };
  }

  const settleDiagnostic = await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });

  if (recoveredMessage && captureModules.includes("errors")) {
    recordDiagnosticError(captures, {
      stepIndex,
      category: "navigation_failure",
      severity: "warning",
      pageUrl: outcomeUrl,
      actionType: "click",
      targetElementId: action.target,
      message: recoveredMessage,
      recoverable: true,
      stoppedRun: false,
    });
  }

  return {
    success: true,
    resultingUrl: outcomeUrl,
    settleDiagnostic,
    // Click-success/milestone-evidence corrective work: a confirmed, allowedDomains-checked
    // same-tab navigation is the strongest evidence class -- see ActionResult.
    // verifiedSuccessType's own doc comment.
    verifiedSuccessType: "same_tab_navigation",
  };
}
