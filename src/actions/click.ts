import type { Frame, Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import {
  captureInteractionSnapshot,
  detectTargetAttributableSideEffect,
  elementLocatorSelector,
  readElementState,
  resolveElementActionTarget,
  targetElementSnapshot,
  waitForInteractionSideEffect,
  type ClickSideEffectType,
  type ElementState,
  type InteractionSnapshot,
  type TargetElementSnapshot,
} from "../observation/observationBuilder.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { assessNavigationRecovery, robustGoto, PAGE_SETTLE_DELAY_MS, type RobustGotoOutcome } from "../core/robustNavigation.js";
import { recordDiagnosticError } from "../capture-modules/errors.js";
import { adoptPopupForCapture } from "../capture-modules/popupCapture.js";

const CLICK_ELEMENT_TIMEOUT_MS = 5000;

// Short, fixed grace window (mirrors PAGE_SETTLE_DELAY_MS) to let a navigation that a
// click's handler triggers a beat late (e.g. via a JS timeout/promise chain, rather than
// a plain <a href>) register before concluding the click did not navigate at all. Not
// env-configurable: it only decides whether to enter the robust-navigation wait below, it
// is never itself the wait for a slow page.
const NAVIGATION_DETECT_GRACE_MS = 250;

const ALLOWED_FALLBACK_PROTOCOLS = new Set(["http:", "https:"]);

function safePageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
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
 * navigation-timeout budget -- see NAVIGATION_DETECT_GRACE_MS. A click that opens a new
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
  // Started the instant the "popup" event fires -- before returning control to the event
  // loop for anything else -- so GA4/dataLayer capture is attached to the new context as
  // early as possible (item A.3 of the popup/new-context capture fix), well before a fast
  // local/CDN-hosted destination page could otherwise load and fire its own beacon/push
  // unobserved. Whichever branch below ends up handling this click simply awaits this
  // already-in-flight promise rather than starting adoption itself.
  let popupAdoption: Promise<{ observed: boolean }> | undefined;
  const onPopup = (popup: Page) => {
    popupOpened = popup;
    popupAdoption = adoptPopupForCapture({ popup, captures, stepIndex, captureModules }).catch(() => ({
      observed: false,
    }));
  };
  // Registered before the click so a navigation (or popup) that commits fast is never missed.
  page.on("framenavigated", onFrameNavigated);
  page.on("popup", onPopup);

  try {
    await clickTarget.click(selector, { timeout: CLICK_ELEMENT_TIMEOUT_MS });
  } catch (error) {
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
              `evidence (${sideEffect.type}) that the click actually succeeded and the target became ` +
              `covered by the very interactive surface it opened; reporting success without using the ` +
              `destinationUrl fallback. Original click error: ${message}`,
            recoverable: true,
            stoppedRun: false,
          });
        }
        return {
          success: true,
          resultingUrl: safePageUrl(page) ?? urlBeforeClick,
          clickSideEffectDetected: true,
          ...(openedNewContext ? { openedNewContext, observedNewContext } : {}),
        };
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

  if (!mainFrameNavigated) {
    await page.waitForTimeout(NAVIGATION_DETECT_GRACE_MS).catch(() => {});
  }
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
    const { observed: observedNewContext } = popupAdoption ? await popupAdoption : { observed: false };
    const postPopupState = await readElementState(page, targetElementId);
    return resolveUnactionableClick({
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
  }

  if (!mainFrameNavigated) {
    // Generic settle wait, same fixed budget as the post-navigation case below -- lets a
    // CSS transition/animation a click triggered without a document navigation (e.g.
    // dismissing an overlay) finish before the caller's next observation runs. Applies to
    // every non-navigating click uniformly; nothing here knows or cares what kind of
    // element was clicked.
    await page.waitForTimeout(PAGE_SETTLE_DELAY_MS).catch(() => {});
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
    return {
      success: true,
      resultingUrl: safePageUrl(page) ?? urlBeforeClick,
      ...(sideEffect.detected ? { clickSideEffectDetected: true } : {}),
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

  await page.waitForTimeout(PAGE_SETTLE_DELAY_MS).catch(() => {});

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

  return { success: true, resultingUrl: outcomeUrl };
}
