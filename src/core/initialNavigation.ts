import type { Page } from "playwright";
import { checkNavigationAllowed } from "../safety/index.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Bounded, not env-configurable: only meant to give client-side-rendered content a brief
// moment to paint after domcontentloaded fires, before the loop's first buildObservation()
// runs. Kept small and fixed so it can never become an unbounded/hidden wait on top of
// INITIAL_NAVIGATION_TIMEOUT_MS.
const PAGE_SETTLE_DELAY_MS = 250;

export interface InitialNavigationRecovery {
  recoverable: boolean;
  url: string;
}

/**
 * Decides whether a page.goto() timeout waiting for full "load"-equivalent completion can
 * be treated as recoverable: the browser must have actually reached an allowed http(s)
 * URL and rendered something a caller could plausibly act on (a title, visible body text,
 * or at least one observable interactive element). Anything short of that -- no
 * navigation happened at all, it landed outside allowedDomains, or the document is
 * effectively blank -- is not recoverable, preserving the existing critical-failure
 * behaviour.
 */
export async function assessInitialNavigationRecovery(
  page: Page,
  allowedDomains: string[],
): Promise<InitialNavigationRecovery> {
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

export interface InitialNavigationOutcome {
  status: "ok" | "recovered" | "failed";
  url: string;
  message?: string;
}

/**
 * Performs the engine's initial page.goto(). Waits only for "domcontentloaded" (never
 * "load"/"networkidle" as a required condition -- a page with long-polling analytics/ads
 * traffic may never fire "load" at all). On a timeout, attempts recovery via
 * assessInitialNavigationRecovery before giving up, so a slow-but-usable real page (e.g. a
 * hosted OEM site) doesn't fail the whole run before the engine ever gets to observe/decide.
 */
export async function navigateInitialPage(params: {
  page: Page;
  startUrl: string;
  allowedDomains: string[];
  timeoutMs: number;
}): Promise<InitialNavigationOutcome> {
  const { page, startUrl, allowedDomains, timeoutMs } = params;

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(PAGE_SETTLE_DELAY_MS);
    return { status: "ok", url: page.url() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/timeout/i.test(message)) {
      return { status: "failed", url: startUrl, message };
    }

    const recovery = await assessInitialNavigationRecovery(page, allowedDomains);
    if (!recovery.recoverable) {
      return { status: "failed", url: recovery.url || startUrl, message };
    }

    await page.waitForTimeout(PAGE_SETTLE_DELAY_MS).catch(() => {});
    return {
      status: "recovered",
      url: recovery.url,
      message:
        `Initial navigation exceeded ${timeoutMs}ms before reaching full "load"-equivalent ` +
        `completion, but a usable document at ${recovery.url} was already available after ` +
        `"domcontentloaded"; continuing the run. Original error: ${message}`,
    };
  }
}
