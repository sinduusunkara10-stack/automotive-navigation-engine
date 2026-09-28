import type { Page } from "playwright";
import type { ActionResult } from "../types/task-response.js";

const BLANK_STATE_URL = "about:blank";

/**
 * Explicit go_back outcome states (production incident: decision_point_restore_failed,
 * runId run_b3743f06-1667-443e-b9fa-e804aa5caecf -- see docs/journey-memory.md). Distinct
 * from ActionResult.success alone so a caller (core/loop.ts's branch-return-hop and
 * anchor-hop restoration) can tell "the browser genuinely never moved / landed somewhere
 * unusable" apart from "history navigation committed but Playwright's own load-completion
 * wait timed out before this executor could verify it live" -- the latter is not, by
 * itself, a failed restoration; it hands off to the caller's own readiness/re-observation
 * pipeline (see core/loop.ts) rather than being reported as a hard failure on the spot.
 */
export type GoBackOutcome =
  | "no_navigation"
  | "navigation_committed_restoration_unverified"
  | "restoration_verified"
  | "blank_or_unusable_page"
  | "restoration_failed";

export interface GoBackDiagnostics {
  urlBeforeGoBack: string;
  urlAfterGoBack?: string;
  urlChanged: boolean;
  navigationCommitted: boolean;
  timeoutUsedMs: number;
  playwrightThrew: boolean;
  errorCategory?: "timeout" | "other";
  pageTitleAfter?: string;
  outcome: GoBackOutcome;
}

async function safeTitle(page: Page): Promise<string | undefined> {
  try {
    return await page.title();
  } catch {
    return undefined;
  }
}

/**
 * Executes the `go_back` action using the same configurable actionNavigationTimeoutMs
 * mechanism click/navigate already use (never the previous hardcoded 5000ms), and
 * `waitUntil: "commit"` (Playwright 1.56, see package.json) rather than the default
 * "load" -- "commit" only requires the browser to have committed to the new document
 * (the URL has changed and a network response started), which is enough to know history
 * genuinely moved without paying for a slow SPA's full "load"-equivalent completion. Real,
 * live verification of the resulting page still only ever comes from the caller's own
 * readiness/re-observation pipeline (core/loop.ts + core/robustNavigation.ts's
 * waitForAdaptiveSettle) -- a changed URL alone is never reported as
 * "restoration_verified" here.
 *
 * Refuses to even attempt navigation when the page is already at about:blank (a reliable,
 * generic signal for "there was nothing meaningful to go back to" -- verified empirically
 * against real Chromium/Playwright behaviour, see this module's git history), and treats a
 * resulting about:blank/content-free page the same way, regardless of whether Playwright
 * itself threw.
 */
export async function executeGoBack(page: Page, timeoutMs: number): Promise<ActionResult> {
  const urlBeforeGoBack = page.url();

  if (urlBeforeGoBack === BLANK_STATE_URL) {
    const diagnostics: GoBackDiagnostics = {
      urlBeforeGoBack,
      urlChanged: false,
      navigationCommitted: false,
      timeoutUsedMs: timeoutMs,
      playwrightThrew: false,
      outcome: "no_navigation",
    };
    return {
      success: false,
      error:
        "go_back was not attempted: the page is already at a blank, content-free state with no meaningful prior navigation to return to.",
      goBackOutcome: diagnostics.outcome,
      goBackDiagnostics: diagnostics,
    };
  }

  let playwrightThrew = false;
  let errorCategory: "timeout" | "other" | undefined;
  let throwMessage: string | undefined;
  try {
    await page.goBack({ timeout: timeoutMs, waitUntil: "commit" });
  } catch (error) {
    playwrightThrew = true;
    throwMessage = error instanceof Error ? error.message : String(error);
    errorCategory = /timeout/i.test(throwMessage) ? "timeout" : "other";
  }

  let urlAfterGoBack: string | undefined;
  try {
    urlAfterGoBack = page.url();
  } catch {
    urlAfterGoBack = undefined;
  }
  const urlChanged = urlAfterGoBack !== undefined && urlAfterGoBack !== urlBeforeGoBack;
  const navigationCommitted = urlAfterGoBack !== undefined && urlAfterGoBack !== BLANK_STATE_URL && urlChanged;
  const pageTitleAfter = await safeTitle(page);

  // A non-timeout throw (navigation aborted, page/context closed, etc.) is never treated
  // as "committed but unverified" -- there is no plausible in-flight navigation for the
  // caller's readiness pipeline to wait on.
  if (playwrightThrew && errorCategory !== "timeout") {
    const diagnostics: GoBackDiagnostics = {
      urlBeforeGoBack,
      urlAfterGoBack,
      urlChanged,
      navigationCommitted: false,
      timeoutUsedMs: timeoutMs,
      playwrightThrew,
      errorCategory,
      pageTitleAfter,
      outcome: "restoration_failed",
    };
    return {
      success: false,
      error: throwMessage,
      ...(urlAfterGoBack ? { resultingUrl: urlAfterGoBack } : {}),
      goBackOutcome: diagnostics.outcome,
      goBackDiagnostics: diagnostics,
    };
  }

  if (urlAfterGoBack === undefined || urlAfterGoBack === BLANK_STATE_URL) {
    const diagnostics: GoBackDiagnostics = {
      urlBeforeGoBack,
      urlAfterGoBack,
      urlChanged,
      navigationCommitted: false,
      timeoutUsedMs: timeoutMs,
      playwrightThrew,
      errorCategory,
      pageTitleAfter,
      outcome: "blank_or_unusable_page",
    };
    return {
      success: false,
      error:
        throwMessage ??
        "go_back reached a blank, content-free page state; treating this as a failed recovery, not journey progress.",
      ...(urlAfterGoBack ? { resultingUrl: urlAfterGoBack } : {}),
      goBackOutcome: diagnostics.outcome,
      goBackDiagnostics: diagnostics,
    };
  }

  if (playwrightThrew && errorCategory === "timeout") {
    if (!navigationCommitted) {
      // The URL is unchanged (or unreadable): history genuinely didn't move within the
      // budget -- fail safely rather than handing the caller an unverified, unchanged page.
      const diagnostics: GoBackDiagnostics = {
        urlBeforeGoBack,
        urlAfterGoBack,
        urlChanged,
        navigationCommitted: false,
        timeoutUsedMs: timeoutMs,
        playwrightThrew,
        errorCategory,
        pageTitleAfter,
        outcome: "restoration_failed",
      };
      return {
        success: false,
        error: throwMessage,
        resultingUrl: urlAfterGoBack,
        goBackOutcome: diagnostics.outcome,
        goBackDiagnostics: diagnostics,
      };
    }

    // URL genuinely changed to something non-blank/usable, but Playwright's own
    // load-completion wait timed out: this is a slow-settling SPA, not a failure. Report
    // as unverified and let the caller's own bounded readiness pipeline (Fix 2) confirm it
    // from live evidence -- a changed URL alone is never "restoration_verified" here.
    const diagnostics: GoBackDiagnostics = {
      urlBeforeGoBack,
      urlAfterGoBack,
      urlChanged,
      navigationCommitted: true,
      timeoutUsedMs: timeoutMs,
      playwrightThrew,
      errorCategory,
      pageTitleAfter,
      outcome: "navigation_committed_restoration_unverified",
    };
    return {
      success: true,
      resultingUrl: urlAfterGoBack,
      goBackOutcome: diagnostics.outcome,
      goBackDiagnostics: diagnostics,
    };
  }

  // No throw at all: page.goBack() with waitUntil: "commit" resolved cleanly and the URL
  // is a non-blank, changed URL. Still only a commit-level guarantee, never itself live
  // verification -- a changed URL alone must never mean "restoration_verified" (that state
  // is only ever assigned by the caller's own live-evidence readiness pipeline, Fix 2 in
  // core/loop.ts). Reported here as committed-but-unverified, same as the timeout-recovered
  // case above.
  const diagnostics: GoBackDiagnostics = {
    urlBeforeGoBack,
    urlAfterGoBack,
    urlChanged,
    navigationCommitted: true,
    timeoutUsedMs: timeoutMs,
    playwrightThrew: false,
    pageTitleAfter,
    outcome: "navigation_committed_restoration_unverified",
  };
  return {
    success: true,
    resultingUrl: urlAfterGoBack,
    goBackOutcome: diagnostics.outcome,
    goBackDiagnostics: diagnostics,
  };
}
