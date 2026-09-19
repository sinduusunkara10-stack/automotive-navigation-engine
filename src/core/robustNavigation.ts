import type { Page } from "playwright";
import { checkNavigationAllowed } from "../safety/index.js";
import { INTERACTIVE_SELECTOR } from "../observation/observationBuilder.js";
import type { SettleDiagnostic } from "../types/task-response.js";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Bounded, not env-configurable: only meant to give client-side-rendered content a brief
// moment to paint after domcontentloaded fires, before the next buildObservation() runs.
// Kept small and fixed so it can never become an unbounded/hidden wait on top of whatever
// navigation timeout budget applies. Retained as the adaptive settle's own floor (below) --
// the adaptive wait can never resolve *earlier* than this fixed delay did.
export const PAGE_SETTLE_DELAY_MS = 250;

// Adaptive settling (see CLAUDE.md and docs/architecture.md "Adaptive settling"): generalizes
// PR 1C-a's original click-only DOM-mutation-aware settle (previously actions/click.ts's
// waitForDomSettle/waitForPostClickReadiness, capped at 1000ms) into a shared mechanism used
// by every settle point in the engine -- post-navigation (robustGoto below), a non-navigating
// click's post-click readiness wait, a click that does navigate the main frame, the
// low-confidence-retry re-observation, and popup-adoption settling. Same floor/quiet-window
// shape as before; only the ceiling is new (and now task-configurable, see below).
export const SETTLE_QUIET_WINDOW_MS = 100;
// Conservative initial default for the new, wider ceiling (see docs/architecture.md's
// Phase 3 rollout strategy): higher than the original 1000ms so a genuinely slow SPA
// transition (a configurator summary page, a newly-adopted surface still rendering) gets
// real room to settle, but not yet the full 10s ceiling until real-run settleDiagnostic
// evidence justifies raising the default further. Task-configurable up to the hard ceiling.
export const DEFAULT_SETTLE_CEILING_MS = 3000;
// Hard, non-relaxable ceiling -- the Phase 3 requirement's own "maximum wait of 10 seconds".
// Same never-relaxed-ceiling pattern as MAX_ACTION_NAVIGATION_TIMEOUT_MS/every other hard cap
// in this repo: a misconfigured or malicious task.settling.maxSettleMs can never turn "wait
// longer for a slow page" into an effectively unbounded per-step hang.
export const MAX_SETTLE_CEILING_MS = 10000;

// Canonical shape lives in types/task-response.ts (SettleDiagnostic) since it's a field of
// ActionResult/StepLog in the wire contract; aliased here so every existing caller in this
// module and its consumers (actions/click.ts, actions/navigate.ts) can keep referring to it
// as SettleOutcome without a churn-only rename.
export type SettleOutcome = SettleDiagnostic;

export interface AdaptiveSettleConfig {
  floorMs?: number;
  quietWindowMs?: number;
  /** Hard-capped at MAX_SETTLE_CEILING_MS regardless of what's passed. */
  ceilingMs?: number;
}

interface DomSettleProbeArgs {
  floorMs: number;
  quietWindowMs: number;
  ceilingMs: number;
  interactiveSelector: string;
}

/**
 * Runs entirely inside the browser (a MutationObserver, and the interactive-element scan
 * below, cannot be driven from Node). A plain, standalone top-level function passed directly
 * as the sole evaluate() callback -- this whole function, body and all, is what evaluate()
 * serialises (via Function.prototype.toString()) and runs in the browser, with no reference
 * to anything outside itself. Deliberately has NO nested named function/const bindings (same
 * constraint observationBuilder.ts's own scan functions already follow) -- this repo's tsx/
 * esbuild toolchain rewrites any inner function assigned to a name into
 * `__name(fn, "name")` (its "keep .name across bundling" transform), and that helper call is
 * injected *inside* this function's own body, referencing a `__name` binding that exists only
 * in the surrounding Node module scope -- never included in the serialised source evaluate()
 * ships to the browser, so calling it there throws `ReferenceError: __name is not defined`.
 * The poll loop is therefore a `setInterval` (whose id is a plain number, not a function, so
 * assigning it to a const is never rewritten) with a single anonymous callback passed
 * directly as setInterval's argument -- never bound to a name -- instead of a named
 * self-recursing helper; the interactive-element read is inlined at both its call sites
 * rather than factored into a named helper, for the same reason.
 *
 * Two independent settle signals, combined conservatively (both must be quiet): DOM mutation
 * (childList/attributes on document.body, as PR 1C-a's original mechanism already used), and
 * the interactive-element candidate *count* (a deliberately coarse, cheap proxy for "the set
 * of clickable controls has stopped changing" -- not the full role+accessibleName identity
 * observationBuilder.ts computes, which would be too expensive to recompute on every ~50ms
 * poll here; a page that swaps one control for another of the same total count is the one
 * case this proxy misses, left to the existing per-step buildObservation/decision cycle to
 * catch instead of this settle probe). Never faster than floorMs, never slower than ceilingMs
 * regardless of how long either signal keeps changing.
 */
function domSettleProbe(args: DomSettleProbeArgs): Promise<{ elapsedMs: number; reason: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    let lastMutation = Date.now();
    let lastElementCount = -1;
    try {
      lastElementCount = document.querySelectorAll(args.interactiveSelector).length;
    } catch {
      lastElementCount = -1;
    }
    let lastElementCountChange = Date.now();
    const observer = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    const intervalId = setInterval(() => {
      const now = Date.now();
      const elapsed = now - start;
      let currentElementCount = lastElementCount;
      try {
        currentElementCount = document.querySelectorAll(args.interactiveSelector).length;
      } catch {
        // Keep the previous count on a transient read failure (e.g. a same-document
        // navigation mid-poll) -- never treat it as a settle-relevant change.
      }
      if (currentElementCount !== lastElementCount) {
        lastElementCount = currentElementCount;
        lastElementCountChange = now;
      }
      if (elapsed >= args.ceilingMs) {
        clearInterval(intervalId);
        observer.disconnect();
        resolve({ elapsedMs: elapsed, reason: "ceiling_reached" });
        return;
      }
      const domQuietFor = now - lastMutation;
      const elementsQuietFor = now - lastElementCountChange;
      if (elapsed >= args.floorMs && domQuietFor >= args.quietWindowMs && elementsQuietFor >= args.quietWindowMs) {
        clearInterval(intervalId);
        observer.disconnect();
        resolve({ elapsedMs: elapsed, reason: "quiet_window" });
      }
    }, 50);
  });
}

/**
 * Shared adaptive settle, used by every settle point in the engine (see the module comment
 * above). Never throws -- a page navigating away or closing mid-wait (e.g. the click that
 * triggered it also started a fresh navigation) is a race this function tolerates the same
 * way every other best-effort settle wait in this repo already does, reporting a
 * ceiling_reached-shaped outcome with 0 elapsed rather than failing the calling action.
 */
export async function waitForAdaptiveSettle(page: Page, config?: AdaptiveSettleConfig): Promise<SettleOutcome> {
  const floorMs = config?.floorMs ?? PAGE_SETTLE_DELAY_MS;
  const quietWindowMs = config?.quietWindowMs ?? SETTLE_QUIET_WINDOW_MS;
  const ceilingMs = Math.min(config?.ceilingMs ?? DEFAULT_SETTLE_CEILING_MS, MAX_SETTLE_CEILING_MS);
  try {
    const result = await page.evaluate(domSettleProbe, {
      floorMs,
      quietWindowMs,
      ceilingMs,
      interactiveSelector: INTERACTIVE_SELECTOR,
    });
    return { elapsedMs: result.elapsedMs, reason: result.reason === "quiet_window" ? "quiet_window" : "ceiling_reached" };
  } catch {
    return { elapsedMs: 0, reason: "ceiling_reached" };
  }
}

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
  /** Present on "ok"/"recovered" -- see SettleOutcome. Absent on "failed" (no settle wait ever runs). */
  settleDiagnostic?: SettleOutcome;
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
  /** Task-level override for the adaptive settle ceiling (task.settling.maxSettleMs) -- see AdaptiveSettleConfig. */
  settleCeilingMs?: number;
}): Promise<RobustGotoOutcome> {
  const { page, url, allowedDomains, timeoutMs, settleCeilingMs } = params;

  try {
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const settleDiagnostic = await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });
    return {
      status: "ok",
      url: page.url(),
      settleDiagnostic,
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

    const settleDiagnostic = await waitForAdaptiveSettle(page, { ceilingMs: settleCeilingMs });
    return {
      status: "recovered",
      url: recovery.url,
      settleDiagnostic,
      message:
        `Navigation exceeded ${timeoutMs}ms before reaching full "load"-equivalent completion, but a ` +
        `usable document at ${recovery.url} was already available after "domcontentloaded"; continuing. ` +
        `Original error: ${message}`,
    };
  }
}
