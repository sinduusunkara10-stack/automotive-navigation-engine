import type { Page } from "playwright";
import { ACTION_WINDOW_MAX_EXTENSION_MS, ACTION_WINDOW_QUIET_PERIOD_MS } from "../config/captureLimits.js";

/**
 * Generic, evidence-agnostic wait used to close a click's action-attributed analytics
 * window (see core/loop.ts and CtaClickCapture.actionAnalytics): waits for `getCount` (a
 * bounded evidence array's current length, e.g. captures.ga4_network_events.length or
 * captures.data_layer_evidence.length) to stop growing for ACTION_WINDOW_QUIET_PERIOD_MS,
 * polling on `page`, up to a hard ceiling of ACTION_WINDOW_MAX_EXTENSION_MS beyond the
 * caller's own initial wait. Never inspects what the evidence actually is -- purely a
 * count-based quiet-period detector, so it carries no brand/vendor logic whatsoever.
 *
 * This does not, and cannot, wait indefinitely for an arbitrarily-delayed tag (a
 * third-party campaign script that only fires many seconds after page load) -- that
 * would make every run's duration hostage to the slowest possible tag on the slowest
 * possible target site. What it does fix is the common case where a destination page's
 * own beacons/pushes land a few hundred milliseconds late relative to a single fixed
 * wait. Evidence that still arrives after this window closes is not lost (it remains in
 * the run-wide capture arrays under a later stepIndex) -- it is simply not attributable
 * to this specific click's own action window, which is exactly what
 * capture-modules/analyticsCaptureClassification.ts's ENGINE_CAPTURE_INCOMPLETE /
 * CORRELATION_UNRESOLVED statuses exist to report honestly rather than silently.
 */
export async function waitForActionWindowQuietPeriod(page: Page, getCount: () => number): Promise<void> {
  const deadline = Date.now() + ACTION_WINDOW_MAX_EXTENSION_MS;
  let lastCount = getCount();
  while (Date.now() < deadline) {
    await page.waitForTimeout(ACTION_WINDOW_QUIET_PERIOD_MS).catch(() => undefined);
    const currentCount = getCount();
    if (currentCount === lastCount) {
      return;
    }
    lastCount = currentCount;
  }
}
