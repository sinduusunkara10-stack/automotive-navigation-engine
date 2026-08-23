import type { Page } from "playwright";
import type { FinishPageCtaCapture } from "../types/task-response.js";

const CTA_SELECTOR = 'a, button, [role="button"], [role="link"]';

interface RawCta {
  text: string;
  url?: string;
  elementType: string;
  accessibleName?: string;
}

export async function captureFinishPageCtas(page: Page, stepIndex: number): Promise<FinishPageCtaCapture[]> {
  const ctas = await page.evaluate((selector) => {
    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      })
      .map((el) => ({
        text: el.textContent?.trim() ?? "",
        url: el instanceof HTMLAnchorElement ? el.href : undefined,
        elementType: el.tagName.toLowerCase(),
        accessibleName: el.getAttribute("aria-label")?.trim() || undefined,
      }))
      .filter((cta) => cta.text.length > 0);
  }, CTA_SELECTOR);

  const pageUrl = page.url();
  const timestamp = new Date().toISOString();

  return (ctas as RawCta[]).map((cta) => ({ stepIndex, pageUrl, timestamp, ...cta }));
}
