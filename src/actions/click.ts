import type { Frame, Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { elementLocatorSelector, readElementState, type ElementState } from "../observation/observationBuilder.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { assessNavigationRecovery, robustGoto, PAGE_SETTLE_DELAY_MS, type RobustGotoOutcome } from "../core/robustNavigation.js";
import { recordDiagnosticError } from "../capture-modules/errors.js";

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

type ClickErrorCategory = "detached" | "hidden" | "disabled" | "intercepted" | "timeout" | "unknown";

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
}

function formatClickDiagnostics(d: ClickDiagnostics): string {
  return (
    `[diagnostics targetElementId=${d.targetElementId} role=${d.role ?? "unknown"} visible=${d.visible} ` +
    `attached=${d.attached} enabled=${d.enabled} hasDestinationUrl=${d.hasDestinationUrl} ` +
    `locatorResolution=${d.locatorResolution} clickErrorCategory=${d.clickErrorCategory} ` +
    `reObservationAttempted=${d.reObservationAttempted} fallbackNavigationAttempted=${d.fallbackNavigationAttempted} ` +
    `fallbackNavigationUsed=${d.fallbackNavigationUsed}` +
    (d.fallbackRejectedReason ? ` fallbackRejectedReason=${d.fallbackRejectedReason}` : "") +
    `]`
  );
}

function categorizeUnactionableState(state: ElementState): ClickErrorCategory {
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
  } = params;

  const fallback = await attemptFallbackNavigation({
    page,
    destinationUrl: state.destinationUrl,
    allowedDomains,
    timeoutMs,
  });
  const fallbackSucceeded = Boolean(fallback.attempted && fallback.outcome && fallback.outcome.status !== "failed");

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
  };

  if (fallbackSucceeded && fallback.outcome) {
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
    return { success: true, resultingUrl: fallback.outcome.url };
  }

  const fallbackDetail = fallback.attempted
    ? `fallback navigation itself failed: ${fallback.outcome?.message ?? "unknown navigation error"}`
    : `fallback navigation not attempted (${fallback.rejectedReason ?? "ineligible"})`;

  return {
    success: false,
    error:
      `click target not actionable (${category}); ${fallbackDetail}. ${formatClickDiagnostics(diagnostics)}` +
      (originalErrorMessage ? ` Original click error: ${originalErrorMessage}` : ""),
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
 * navigation-timeout budget -- see NAVIGATION_DETECT_GRACE_MS.
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
    });
  }

  const urlBeforeClick = safePageUrl(page) ?? "";

  let mainFrameNavigated = false;
  const onFrameNavigated = (frame: Frame) => {
    if (frame === page.mainFrame()) {
      mainFrameNavigated = true;
    }
  };
  // Registered before the click so a navigation that commits fast is never missed.
  page.on("framenavigated", onFrameNavigated);

  try {
    await page.click(selector, { timeout: CLICK_ELEMENT_TIMEOUT_MS });
  } catch (error) {
    page.off("framenavigated", onFrameNavigated);
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) {
      return { success: false, error: message };
    }

    const postFailureState = await readElementState(page, targetElementId);
    return resolveUnactionableClick({
      page,
      targetElementId,
      category: categorizeUnactionableState(postFailureState),
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
    });
  }

  if (!mainFrameNavigated) {
    await page.waitForTimeout(NAVIGATION_DETECT_GRACE_MS).catch(() => {});
  }
  page.off("framenavigated", onFrameNavigated);

  if (!mainFrameNavigated) {
    return { success: true, resultingUrl: safePageUrl(page) ?? urlBeforeClick };
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
