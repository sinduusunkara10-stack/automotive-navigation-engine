import type { Page } from "playwright";
import type { ActionAnalytics, ActionResult, CtaClickCapture } from "../types/task-response.js";
import { elementLocatorSelector, resolveElementActionTarget } from "../observation/observationBuilder.js";

interface ClickedElementDetails {
  ctaText: string;
  accessibleName?: string;
  elementType: string;
  destinationUrl?: string;
}

/**
 * Must be read before the click executes: a click can navigate away, and the
 * originating element (and its attributes) are gone once the new page loads. Frame-aware
 * (see observation/frames.ts) so an element inside a same-origin child frame is read from
 * its own frame, not silently missed by only ever querying the main document.
 */
export async function readClickedElementDetails(
  page: Page,
  elementId: string,
): Promise<ClickedElementDetails | undefined> {
  const selector = elementLocatorSelector(elementId);
  const target = await resolveElementActionTarget(page, elementId);
  if (!target) {
    return undefined;
  }
  const details = await target
    .evaluate((sel) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) {
        return null;
      }
      return {
        ctaText: el.textContent?.trim() ?? "",
        accessibleName: el.getAttribute("aria-label")?.trim() || undefined,
        elementType: el.tagName.toLowerCase(),
        destinationUrl: el instanceof HTMLAnchorElement ? el.href : undefined,
      };
    }, selector)
    .catch(() => null);
  return details ?? undefined;
}

export function buildCtaClickCapture(params: {
  stepIndex: number;
  sourcePageUrl: string;
  sourcePageTitle?: string;
  details?: ClickedElementDetails;
  actionResult: ActionResult;
  resultingTitle?: string;
  actionAnalytics?: ActionAnalytics;
}): CtaClickCapture {
  const { stepIndex, sourcePageUrl, sourcePageTitle, details, actionResult, resultingTitle, actionAnalytics } =
    params;
  const resultingUrl = actionResult.resultingUrl;
  const navigationSucceeded = Boolean(actionResult.success && resultingUrl && resultingUrl !== sourcePageUrl);

  return {
    stepIndex,
    timestamp: new Date().toISOString(),
    sourcePageUrl,
    ...(sourcePageTitle ? { sourcePageTitle } : {}),
    ctaText: details?.ctaText ?? "",
    ...(details?.accessibleName ? { accessibleName: details.accessibleName } : {}),
    elementType: details?.elementType ?? "unknown",
    ...(details?.destinationUrl ? { destinationUrl: details.destinationUrl } : {}),
    ...(resultingUrl ? { resultingUrl } : {}),
    ...(resultingTitle ? { resultingTitle } : {}),
    navigationSucceeded,
    actionSucceeded: actionResult.success,
    ...(actionResult.error ? { error: actionResult.error } : {}),
    ...(actionAnalytics ? { actionAnalytics } : {}),
  };
}
