import type { Page } from "playwright";
import type { ActionResult } from "../types/task-response.js";

const BLANK_STATE_URL = "about:blank";

/**
 * Safe replanning / go_back fix: a plain page.goBack() call previously reported success
 * whenever it resolved without throwing, regardless of where it actually landed -- including
 * a content-free about:blank state when no real prior navigation history existed. Verified
 * empirically (not merely assumed) against real Chromium/Playwright behaviour: a goBack()
 * with genuinely no prior history lands on about:blank -- both when the page has had exactly
 * one real navigation and when it has had none at all -- so about:blank is a reliable,
 * generic signal for "there was nothing meaningful to go back to", independent of how many
 * navigations preceded it. That false success let a caller (core/loop.ts's bounded journey
 * replanning) treat "the browser is now stuck on about:blank" as if it were real recovery
 * progress. This executor now treats that outcome as a failed recovery instead:
 *
 * - Refuses to even attempt navigation when the page is already at about:blank (this alone
 *   makes a second, blind go_back from an already-blank state structurally impossible,
 *   regardless of which caller dispatched it).
 * - Reports a resulting about:blank state as a failure, not a success, even though the
 *   Playwright call itself did not throw.
 *
 * Deliberately does NOT also treat "the resulting URL is unchanged from before goBack()" as a
 * failure on its own: verified empirically that a real backward navigation can legitimately
 * land on a URL identical to the one just left -- e.g. two consecutive same-document
 * navigations to an identical URL (as a generic destinationUrl fallback can produce -- see
 * actions/click.ts) each still push their own history entry, so going back one step can
 * genuinely traverse real history while still landing on a same-looking URL. Chromium's own
 * "nothing to go back to" behaviour is unambiguous (about:blank), so that -- not a same-URL
 * heuristic that would misclassify this real case -- is what this executor checks for.
 *
 * core/loop.ts already has bounded, non-fatal handling for a failed go_back during journey
 * replanning or a branch-closure return (both fall through to a "blocked" terminal outcome
 * rather than looping) -- this executor only needs to report the true outcome accurately; it
 * relies on that existing caller-side handling rather than retrying or looping itself.
 */
export async function executeGoBack(page: Page): Promise<ActionResult> {
  const urlBeforeGoBack = page.url();
  if (urlBeforeGoBack === BLANK_STATE_URL) {
    return {
      success: false,
      error:
        "go_back was not attempted: the page is already at a blank, content-free state with no meaningful prior navigation to return to.",
    };
  }

  try {
    await page.goBack({ timeout: 5000 });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }

  const resultingUrl = page.url();
  if (resultingUrl === BLANK_STATE_URL) {
    return {
      success: false,
      resultingUrl,
      error: "go_back reached a blank, content-free page state; treating this as a failed recovery, not journey progress.",
    };
  }

  return { success: true, resultingUrl };
}
