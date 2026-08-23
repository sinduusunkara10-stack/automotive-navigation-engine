import type { Page } from "playwright";
import type { ActionResult, CtaClickCapture } from "../types/task-response.js";
import { elementLocatorSelector } from "../observation/observationBuilder.js";

interface ClickedElementDetails {
  ctaText: string;
  accessibleName?: string;
  elementType: string;
  destinationUrl?: string;
}

/**
 * Must be read before the click executes: a click can navigate away, and the
 * originating element (and its attributes) are gone once the new page loads.
 */
export async function readClickedElementDetails(
  page: Page,
  elementId: string,
): Promise<ClickedElementDetails | undefined> {
  const selector = elementLocatorSelector(elementId);
  const details = await page
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
}): CtaClickCapture {
  const { stepIndex, sourcePageUrl, sourcePageTitle, details, actionResult } = params;
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
    navigationSucceeded,
    actionSucceeded: actionResult.success,
    ...(actionResult.error ? { error: actionResult.error } : {}),
  };
}
