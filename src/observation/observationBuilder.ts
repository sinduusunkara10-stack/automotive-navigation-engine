import type { Page } from "playwright";
import type { Observation } from "../types/task-response.js";

const ELEMENT_ID_ATTR = "data-nav-engine-id";
const INTERACTIVE_SELECTOR = 'a, button, [role="button"], [role="link"]';

export async function buildObservation(page: Page): Promise<Observation> {
  const interactiveElements = await page.evaluate(
    ({ attr, selector }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      return elements.map((el, index) => {
        let id = el.getAttribute(attr);
        if (!id) {
          id = `el-${index}`;
          el.setAttribute(attr, id);
        }
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible =
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        const destinationUrl = el instanceof HTMLAnchorElement ? el.href : undefined;
        return { id, role, accessibleName, visible, ...(destinationUrl ? { destinationUrl } : {}) };
      });
    },
    { attr: ELEMENT_ID_ATTR, selector: INTERACTIVE_SELECTOR },
  );

  const notableText = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll("h1, h2"));
    return headings.map((heading) => heading.textContent?.trim()).filter((text): text is string => Boolean(text));
  });

  return {
    url: page.url(),
    title: await page.title(),
    interactiveElements,
    ...(notableText.length > 0 ? { notableText } : {}),
  };
}

export function elementLocatorSelector(elementId: string): string {
  return `[${ELEMENT_ID_ATTR}="${elementId}"]`;
}
