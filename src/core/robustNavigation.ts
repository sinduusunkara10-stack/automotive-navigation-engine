import type { Page } from "playwright";
import { checkNavigationAllowed } from "../safety/index.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Bounded, not env-configurable: only meant to give client-side-rendered content a brief
// moment to paint after domcontentloaded fires, before the next buildObservation() runs.
// Kept small and fixed so it can never become an unbounded/hidden wait on top of whatever
// navigation timeout budget applies.
export const PAGE_SETTLE_DELAY_MS = 250;

export interface NavigationRecovery {
  recoverable: boolean;
  url: string;
}

/**
 * Decides whether a navigation timeout waiting for full "load"-equivalent completion can
 * be treated as recoverable: the browser must have actually reached an allowed http(s)
 * URL and rendered something a caller could plausibly act on (a title, visible body text,
 * or at least one observable interactive element). Anything short of that -- no
 * navigation happened at all, it landed outside allowedDomains, or the document is
 * effectively blank -- is not recoverable, preserving the existing critical-failure
 * behaviour. Shared by the engine's initial navigation and by in-loop action navigation
 * (navigate/click), so a redirect that lands outside allowedDomains is rejected the same
 * way regardless of which one triggered it.
 */
export async function assessNavigationRecovery(page: Page, allowedDomains: string[]): Promise<NavigationRecovery> {
  let url: string;
  try {
    url = page.url();
  } catch {
    return { recoverable: false, url: "" };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { recoverable: false, url };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { recoverable: false, url };
  }
  if (!checkNavigationAllowed(url, allowedDomains)) {
    return { recoverable: false, url };
  }

  try {
    const title = (await page.title()).trim();
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? "");
    const interactiveCount = await page.evaluate(
      () => document.querySelectorAll('a, button, [role="button"], [role="link"]').length,
    );
    const hasUsableDocument = title.length > 0 || bodyText.length > 0 || interactiveCount > 0;
    return { recoverable: hasUsableDocument, url };
  } catch {
    return { recoverable: false, url };
  }
}

export interface RobustGotoOutcome {
  status: "ok" | "recovered" | "failed";
  url: string;
  message?: string;
  /**
   * Ordered list of every URL visited following an HTTP redirect from the requested `url`
   * through to the final landed URL (inclusive of both ends). Only populated on "ok" --
   * Playwright's Response/Request chain isn't reliably available after a "recovered" timeout
   * or a "failed" navigation, and preflight domain discovery (src/discovery) only needs this
   * for a normal successful navigation.
   */
  redirectChain?: string[];
}

function buildRedirectChain(response: import("playwright").Response): string[] {
  const chain: string[] = [];
  let request: import("playwright").Request | null = response.request();
  while (request) {
    chain.unshift(request.url());
    request = request.redirectedFrom();
  }
  return chain;
}

/**
 * Performs a robust page.goto(). Waits only for "domcontentloaded" (never "load"/
 * "networkidle" as a required condition -- a page with long-polling analytics/ads traffic
 * may never fire "load" at all). On a timeout, attempts recovery via
 * assessNavigationRecovery before giving up, so a slow-but-usable real page doesn't fail
 * the whole run/step before the caller ever gets to observe/decide. Shared by the
 * engine's initial navigation (src/core/initialNavigation.ts) and the `navigate` action
 * (src/actions/navigate.ts) so both apply identical reliability behaviour.
 */
export async function robustGoto(params: {
  page: Page;
  url: string;
  allowedDomains: string[];
  timeoutMs: number;
}): Promise<RobustGotoOutcome> {
  const { page, url, allowedDomains, timeoutMs } = params;

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(PAGE_SETTLE_DELAY_MS);
    return {
      status: "ok",
      url: page.url(),
      ...(response ? { redirectChain: buildRedirectChain(response) } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) {
      return { status: "failed", url, message };
    }

    const recovery = await assessNavigationRecovery(page, allowedDomains);
    if (!recovery.recoverable) {
      return { status: "failed", url: recovery.url || url, message };
    }

    await page.waitForTimeout(PAGE_SETTLE_DELAY_MS).catch(() => {});
    return {
      status: "recovered",
      url: recovery.url,
      message:
        `Navigation exceeded ${timeoutMs}ms before reaching full "load"-equivalent completion, but a ` +
        `usable document at ${recovery.url} was already available after "domcontentloaded"; continuing. ` +
        `Original error: ${message}`,
    };
  }
}
