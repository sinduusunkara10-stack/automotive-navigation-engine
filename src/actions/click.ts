import type { Frame, Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { elementLocatorSelector } from "../observation/observationBuilder.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { assessNavigationRecovery, PAGE_SETTLE_DELAY_MS } from "../core/robustNavigation.js";
import { recordDiagnosticError } from "../capture-modules/errors.js";

const CLICK_ELEMENT_TIMEOUT_MS = 5000;

// Short, fixed grace window (mirrors PAGE_SETTLE_DELAY_MS) to let a navigation that a
// click's handler triggers a beat late (e.g. via a JS timeout/promise chain, rather than
// a plain <a href>) register before concluding the click did not navigate at all. Not
// env-configurable: it only decides whether to enter the robust-navigation wait below, it
// is never itself the wait for a slow page.
const NAVIGATION_DETECT_GRACE_MS = 250;

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
}

/**
 * Executes the `click` action. Clicking the element itself uses a short, fixed timeout
 * (unrelated to navigation -- it is about interactability, not page loading). If the
 * click causes a document navigation, that navigation is then waited on with the same
 * robust behaviour as the `navigate` action and the engine's initial navigation: only
 * "domcontentloaded" is required, a timeout is given one chance to recover if a usable
 * document was already reached, and the resulting URL (including any redirect) is
 * checked against allowedDomains before the click is reported as successful. A click that
 * never triggers navigation at all (a toggle/expand button, say) is not made to pay this
 * navigation-timeout budget -- see NAVIGATION_DETECT_GRACE_MS.
 */
export async function executeClick(params: ExecuteClickParams): Promise<ActionResult> {
  const { page, action, allowedDomains, timeoutMs, captures, stepIndex, captureModules } = params;

  if (!action.target) {
    return { success: false, error: "click action requires a target element id" };
  }

  const selector = elementLocatorSelector(action.target);
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
    return { success: false, error: error instanceof Error ? error.message : String(error) };
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
