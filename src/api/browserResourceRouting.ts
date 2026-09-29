import type { BrowserContext, Frame, Page, Response, Route } from "playwright";
import type {
  ResourceRoutingDiagnostics,
  ResourceRoutingEntry,
  ResourceRoutingPageDiagnostics,
  ResourceRoutingPageRole,
} from "../types/task-response.js";
import { appendBounded } from "../core/boundedArray.js";
import { MAIN_CONTEXT_ID } from "../capture-modules/captureContext.js";

/**
 * Resource types blocked under low-memory browser mode -- the three Playwright
 * request.resourceType() values proven safe to drop for this engine's own use case
 * (navigate -> observe -> decide -> act, plus analytics capture): none of document,
 * script, stylesheet, xhr, fetch, or "other" (which covers navigator.sendBeacon-style
 * analytics beacons) are ever touched. Never brand-, site-, or market-specific -- the same
 * three types are blocked for every task, on every page in the run's browser context.
 */
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

// Rough, documented per-type averages used ONLY to estimate bytes never downloaded for a
// blocked resource -- its real remote size is never knowable without fetching it, which
// would defeat the point. Deliberately conservative, round numbers, not measured against
// any specific site. Allowed resources report real, measured bytes instead (from actual
// Content-Length response headers) -- these two numbers are never combined into one field
// so a caller can always tell which is which.
const ESTIMATED_BYTES_PER_BLOCKED_RESOURCE: Record<string, number> = {
  image: 150_000,
  media: 2_000_000,
  font: 50_000,
};

// A genuinely valid 1x1 transparent GIF, so a blocked <img> decodes successfully (no
// client-side decode-error noise) rather than failing to parse an empty/arbitrary body.
const EMPTY_GIF_BASE64 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

// Routing errors are rare (a route.fulfill/continue rejecting, almost always because the
// page/request was already gone) and diagnostic-only -- bounded defensively so a pathological
// run can never grow this without limit, same discipline as MAX_ERROR_ENTRIES in errors.ts.
const MAX_ROUTING_ERRORS_PER_PAGE = 5;

function fulfillBodyFor(resourceType: string): { body: Buffer; contentType: string } {
  if (resourceType === "image") {
    return { body: Buffer.from(EMPTY_GIF_BASE64, "base64"), contentType: "image/gif" };
  }
  if (resourceType === "media") {
    return { body: Buffer.alloc(0), contentType: "video/mp4" };
  }
  return { body: Buffer.alloc(0), contentType: "font/woff2" };
}

interface ResourceTally {
  allowedCount: number;
  allowedBytesMeasured: number;
  blockedCount: number;
}

function emptyTallies(): Map<string, ResourceTally> {
  return new Map();
}

function tallyFor(tallies: Map<string, ResourceTally>, resourceType: string): ResourceTally {
  let tally = tallies.get(resourceType);
  if (!tally) {
    tally = { allowedCount: 0, allowedBytesMeasured: 0, blockedCount: 0 };
    tallies.set(resourceType, tally);
  }
  return tally;
}

function tallyEntries(tallies: Map<string, ResourceTally>): ResourceRoutingEntry[] {
  return [...tallies.entries()].map(([resourceType, tally]) => ({
    resourceType,
    allowedCount: tally.allowedCount,
    allowedBytesMeasured: tally.allowedBytesMeasured,
    blockedCount: tally.blockedCount,
    blockedBytesEstimated: tally.blockedCount * (ESTIMATED_BYTES_PER_BLOCKED_RESOURCE[resourceType] ?? 0),
  }));
}

interface PageRoutingState {
  pageId: string;
  role: ResourceRoutingPageRole;
  contextId?: string;
  surfaceId?: string;
  registrationAttempted: boolean;
  registrationCompleted: boolean;
  duplicateRegistrationPrevented: boolean;
  registeredAt: string;
  closedAt?: string;
  navigationCount: number;
  tallies: Map<string, ResourceTally>;
  routingErrors: string[];
  routingReleasedOnClose: boolean;
}

function toPageDiagnostics(state: PageRoutingState): ResourceRoutingPageDiagnostics {
  return {
    pageId: state.pageId,
    role: state.role,
    ...(state.contextId ? { contextId: state.contextId } : {}),
    ...(state.surfaceId ? { surfaceId: state.surfaceId } : {}),
    registrationAttempted: state.registrationAttempted,
    registrationCompleted: state.registrationCompleted,
    duplicateRegistrationPrevented: state.duplicateRegistrationPrevented,
    registeredAt: state.registeredAt,
    ...(state.closedAt ? { closedAt: state.closedAt } : {}),
    navigationCount: state.navigationCount,
    byResourceType: tallyEntries(state.tallies),
    routingErrors: state.routingErrors,
    routingReleasedOnClose: state.routingReleasedOnClose,
  };
}

export interface AttachedResourceRouting {
  diagnostics(): ResourceRoutingDiagnostics;
  /**
   * Labels a Page's role/provenance once the engine's own surface-adoption decision is
   * known -- resource routing itself is already active on this Page from the moment it was
   * created (see attachLowMemoryResourceRouting's own comment), so this only ever affects
   * the diagnostics report, never blocking behaviour. A no-op for a Page this handle never
   * saw (already closed, or from a different context).
   */
  describePage(page: Page, role: ResourceRoutingPageRole, meta?: { contextId?: string; surfaceId?: string }): void;
  detach(): Promise<void>;
}

// One entry per BrowserContext this run has already attached routing to -- attachLowMemoryResourceRouting
// is only ever called once per run in practice (src/api/runner.ts, once per freshly-launched
// browser/page/context), but a defensive idempotency guard costs nothing and matches this
// codebase's own convention for listener attachment (RunState.hasAttachedListeners).
const attachedContexts = new WeakMap<BrowserContext, AttachedResourceRouting>();

/**
 * Blocks image/media/font requests for the *entire browser context* the given page belongs
 * to -- not just that one page. `browser.newPage()` creates a fresh, isolated
 * BrowserContext per run, and Playwright's BrowserContext.route() applies to every page
 * already in that context AND every page created in it afterwards (a popup, a new tab, a
 * popup opened from that popup, recursively) -- so a single context-level route(), attached
 * once at run start, is already active on an adopted popup or a nested popup from the
 * instant Playwright creates that Page, before this engine's own popup-adoption/relevance
 * code ever runs. This is why no per-popup attach call is needed anywhere in
 * capture-modules/popupCapture.ts or core/loop.ts for the blocking itself -- only
 * `describePage` (see AttachedResourceRouting) needs to be called there, purely to label an
 * already-protected Page's role for the diagnostics report.
 *
 * Each request is resolved with a tiny, valid, harmless response rather than aborting it:
 * aborting would fire Playwright's own "requestfailed" event, which
 * src/capture-modules/errors.ts listens to and would otherwise record every intentionally-
 * blocked resource as a network_request_failed diagnostic -- noise that could crowd out
 * genuine errors within the bounded MAX_ERROR_ENTRIES cap. Fulfilling with a 200 status
 * avoids that entirely.
 *
 * page.on("request") (used by src/capture-modules/ga4NetworkEvents.ts) fires for every
 * request the page attempts regardless of how routing later resolves it, so GA4/analytics
 * beacon capture is unaffected even when the underlying request is blocked here -- this is
 * why blocking is safe for the analytics-capture use case this engine exists to serve.
 */
export function attachLowMemoryResourceRouting(page: Page): AttachedResourceRouting {
  const context = page.context();
  const existing = attachedContexts.get(context);
  if (existing) {
    return existing;
  }

  let pageCounter = 0;
  const liveByPage = new Map<Page, PageRoutingState>();
  const finalized: ResourceRoutingPageDiagnostics[] = [];
  const pageListeners = new Map<Page, { onResponse: (r: Response) => void; onNavigated: (f: Frame) => void; onClose: () => void }>();

  function registerPage(target: Page, initialRole: ResourceRoutingPageRole): void {
    if (liveByPage.has(target)) {
      // Re-observation/re-adoption of an already-registered Page must never add a second
      // set of listeners -- routing is already active for it (context-level), so this only
      // records that a duplicate registration attempt was made and prevented.
      const state = liveByPage.get(target)!;
      state.duplicateRegistrationPrevented = true;
      return;
    }
    pageCounter += 1;
    const state: PageRoutingState = {
      pageId: `page-${pageCounter}`,
      role: initialRole,
      registrationAttempted: true,
      registrationCompleted: true,
      duplicateRegistrationPrevented: false,
      registeredAt: new Date().toISOString(),
      navigationCount: 0,
      tallies: emptyTallies(),
      routingErrors: [],
      routingReleasedOnClose: false,
    };
    liveByPage.set(target, state);

    const onResponse = (response: Response): void => {
      const resourceType = response.request().resourceType();
      if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return;
      const raw = response.headers()["content-length"];
      const bytes = raw !== undefined ? Number(raw) : NaN;
      if (Number.isFinite(bytes) && bytes >= 0) {
        tallyFor(state.tallies, resourceType).allowedBytesMeasured += bytes;
      }
    };
    const onNavigated = (frame: Frame): void => {
      if (frame === target.mainFrame()) {
        state.navigationCount += 1;
      }
    };
    const onClose = (): void => {
      state.closedAt = new Date().toISOString();
      state.routingReleasedOnClose = true;
      finalized.push(toPageDiagnostics(state));
      const listeners = pageListeners.get(target);
      if (listeners) {
        target.off("response", listeners.onResponse);
        target.off("framenavigated", listeners.onNavigated);
        pageListeners.delete(target);
      }
      // Drops the only reference this module holds to a closed Page, so it and every
      // upstream Playwright object it retains can be garbage-collected -- the page's
      // final diagnostics already live in `finalized`, data-only, with no Page reference.
      liveByPage.delete(target);
    };

    target.on("response", onResponse);
    target.on("framenavigated", onNavigated);
    target.once("close", onClose);
    pageListeners.set(target, { onResponse, onNavigated, onClose });
  }

  registerPage(page, "original");

  const onNewPage = (newPage: Page): void => {
    // Registered the instant Playwright creates the Page -- before its destination document
    // has requested a single resource -- so heavy resources on an adopted or nested popup's
    // own initial load are blocked from the first request, not just from some later step.
    registerPage(newPage, "popup");
  };
  context.on("page", onNewPage);

  // A vanishingly rare Playwright edge case: request.frame() can throw for a main-frame
  // navigation request issued in the narrow window before that frame is fully created --
  // seen only for a brand-new popup's own very first navigation. Never affects blocking
  // (resourceType is still readable, and "document" is never blocked anyway) -- only
  // per-page attribution for that one request, which lands here instead. Kept separate from
  // any one page's own tallies so it's still counted in the run-level totals, never lost.
  const unattributedTallies = emptyTallies();

  const routeHandler = async (route: Route): Promise<void> => {
    const resourceType = route.request().resourceType();
    let reqPage: Page | null = null;
    try {
      reqPage = route.request().frame().page();
    } catch {
      reqPage = null;
    }
    // Defensive fallback only: context.on("page") should always have registered a Page
    // before any of its requests reach this handler; if a race ever meant it hasn't, this
    // registers it late rather than crashing or silently losing its tally.
    if (reqPage && !liveByPage.has(reqPage)) {
      registerPage(reqPage, "popup");
    }
    const state = reqPage ? liveByPage.get(reqPage) : undefined;
    const tallies = state?.tallies ?? unattributedTallies;

    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      tallyFor(tallies, resourceType).blockedCount += 1;
      const { body, contentType } = fulfillBodyFor(resourceType);
      await route.fulfill({ status: 200, contentType, body }).catch((err) => {
        if (state) state.routingErrors = appendBounded(state.routingErrors, String(err), MAX_ROUTING_ERRORS_PER_PAGE);
      });
      return;
    }
    tallyFor(tallies, resourceType).allowedCount += 1;
    await route.continue().catch((err) => {
      if (state) state.routingErrors = appendBounded(state.routingErrors, String(err), MAX_ROUTING_ERRORS_PER_PAGE);
    });
  };

  context.route("**/*", routeHandler);

  const handle: AttachedResourceRouting = {
    diagnostics(): ResourceRoutingDiagnostics {
      const byPage = [...finalized, ...[...liveByPage.values()].map(toPageDiagnostics)];
      const runTotals = emptyTallies();
      for (const state of liveByPage.values()) {
        for (const [resourceType, tally] of state.tallies) {
          const runTally = tallyFor(runTotals, resourceType);
          runTally.allowedCount += tally.allowedCount;
          runTally.allowedBytesMeasured += tally.allowedBytesMeasured;
          runTally.blockedCount += tally.blockedCount;
        }
      }
      for (const page of finalized) {
        for (const entry of page.byResourceType) {
          const runTally = tallyFor(runTotals, entry.resourceType);
          runTally.allowedCount += entry.allowedCount;
          runTally.allowedBytesMeasured += entry.allowedBytesMeasured;
          runTally.blockedCount += entry.blockedCount;
        }
      }
      for (const [resourceType, tally] of unattributedTallies) {
        const runTally = tallyFor(runTotals, resourceType);
        runTally.allowedCount += tally.allowedCount;
        runTally.allowedBytesMeasured += tally.allowedBytesMeasured;
        runTally.blockedCount += tally.blockedCount;
      }
      return { mode: "low_memory", byResourceType: tallyEntries(runTotals), byPage };
    },
    describePage(target: Page, role: ResourceRoutingPageRole, meta?: { contextId?: string; surfaceId?: string }): void {
      const state = liveByPage.get(target);
      if (!state) return;
      state.role = role;
      // "main" mirrors the same contextId convention the GA4/dataLayer capture modules use
      // once a popup is adopted (see capture-modules/popupCapture.ts's
      // retagPopupContextCaptureAsMain) -- never a second, differently-named concept.
      state.contextId = meta?.contextId ?? MAIN_CONTEXT_ID;
      if (meta?.surfaceId) state.surfaceId = meta.surfaceId;
    },
    async detach(): Promise<void> {
      context.off("page", onNewPage);
      await context.unroute("**/*", routeHandler).catch(() => {});
      for (const [target, listeners] of pageListeners) {
        target.off("response", listeners.onResponse);
        target.off("framenavigated", listeners.onNavigated);
        target.off("close", listeners.onClose);
      }
      pageListeners.clear();
      // A page still open at detach time (routing ends before the run's own page.close(),
      // see src/api/runner.ts) must not lose its diagnostics -- finalize it here exactly as
      // onClose would, just without marking routingReleasedOnClose (its own close is still
      // pending, not caused by this detach).
      for (const state of liveByPage.values()) {
        finalized.push(toPageDiagnostics(state));
      }
      liveByPage.clear();
    },
  };

  attachedContexts.set(context, handle);
  return handle;
}
