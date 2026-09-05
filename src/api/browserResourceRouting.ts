import type { Page, Response, Route } from "playwright";
import type { ResourceRoutingDiagnostics, ResourceRoutingEntry } from "../types/task-response.js";

/**
 * Resource types blocked under low-memory browser mode -- the three Playwright
 * request.resourceType() values proven safe to drop for this engine's own use case
 * (navigate -> observe -> decide -> act, plus analytics capture): none of document,
 * script, stylesheet, xhr, fetch, or "other" (which covers navigator.sendBeacon-style
 * analytics beacons) are ever touched. Never brand-, site-, or market-specific -- the same
 * three types are blocked for every task.
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

export interface AttachedResourceRouting {
  diagnostics(): ResourceRoutingDiagnostics;
  detach(): Promise<void>;
}

/**
 * Blocks image/media/font requests for the page's whole frame tree (including same-origin
 * child frames, matching how page.route() already applies engine-wide), fulfilling each
 * with a tiny, valid, harmless response rather than aborting it: aborting would fire
 * Playwright's own "requestfailed" event, which src/capture-modules/errors.ts listens to
 * and would otherwise record every intentionally-blocked resource as a
 * network_request_failed diagnostic -- noise that could crowd out genuine errors within
 * the bounded MAX_ERROR_ENTRIES cap. Fulfilling with a 200 status avoids that entirely.
 *
 * page.on("request") (used by src/capture-modules/ga4NetworkEvents.ts) fires for every
 * request the page attempts regardless of how routing later resolves it, so GA4/analytics
 * beacon capture is unaffected even when the underlying request is blocked here -- this is
 * why blocking is safe for the analytics-capture use case this engine exists to serve.
 */
export function attachLowMemoryResourceRouting(page: Page): AttachedResourceRouting {
  const tallies = new Map<string, ResourceTally>();

  function tallyFor(resourceType: string): ResourceTally {
    let tally = tallies.get(resourceType);
    if (!tally) {
      tally = { allowedCount: 0, allowedBytesMeasured: 0, blockedCount: 0 };
      tallies.set(resourceType, tally);
    }
    return tally;
  }

  const routeHandler = async (route: Route): Promise<void> => {
    const resourceType = route.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      tallyFor(resourceType).blockedCount += 1;
      const { body, contentType } = fulfillBodyFor(resourceType);
      await route.fulfill({ status: 200, contentType, body }).catch(() => {});
      return;
    }
    tallyFor(resourceType).allowedCount += 1;
    await route.continue().catch(() => {});
  };

  const onResponse = (response: Response): void => {
    const resourceType = response.request().resourceType();
    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return;
    const raw = response.headers()["content-length"];
    const bytes = raw !== undefined ? Number(raw) : NaN;
    if (Number.isFinite(bytes) && bytes >= 0) {
      tallyFor(resourceType).allowedBytesMeasured += bytes;
    }
  };

  page.route("**/*", routeHandler);
  page.on("response", onResponse);

  return {
    diagnostics(): ResourceRoutingDiagnostics {
      const byResourceType: ResourceRoutingEntry[] = [...tallies.entries()].map(([resourceType, tally]) => ({
        resourceType,
        allowedCount: tally.allowedCount,
        allowedBytesMeasured: tally.allowedBytesMeasured,
        blockedCount: tally.blockedCount,
        blockedBytesEstimated: tally.blockedCount * (ESTIMATED_BYTES_PER_BLOCKED_RESOURCE[resourceType] ?? 0),
      }));
      return { mode: "low_memory", byResourceType };
    },
    async detach(): Promise<void> {
      page.off("response", onResponse);
      await page.unroute("**/*", routeHandler).catch(() => {});
    },
  };
}
