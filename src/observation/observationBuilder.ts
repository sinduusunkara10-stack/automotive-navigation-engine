import type { Page } from "playwright";
import type { Observation } from "../types/task-response.js";

const ELEMENT_ID_ATTR = "data-nav-engine-id";
const INTERACTIVE_SELECTOR = 'a, button, [role="button"], [role="link"]';

export async function buildObservation(page: Page): Promise<Observation> {
  const interactiveElements = await page.evaluate(
    ({ attr, selector }) => {
      const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
      // A hidden element (display:none/visibility:hidden/zero-size -- e.g. a responsive
      // duplicate nav link kept in the DOM for another breakpoint) has no visual
      // affordance a reasoning decision could legitimately be based on, so it is never
      // offered as a candidate at all -- this is a permanent, safely-determinable fact
      // at scan time. Disabled/covered elements *are* still offered here (a model
      // choosing one is not inherently confused, unlike picking an invisible duplicate
      // with an identical accessible name); those are transient-in-time facts the
      // engine instead handles safely at execution time (see readElementState below,
      // core/loop.ts's pre-dispatch revalidation, and actions/click.ts's fallback).
      return elements
        .map((el, index) => {
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
        })
        .filter((el) => el.visible);
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

export interface ElementState {
  attached: boolean;
  visible: boolean;
  disabled: boolean;
  covered: boolean;
  actionable: boolean;
  role?: string;
  accessibleName?: string;
  destinationUrl?: string;
}

/**
 * Re-reads one element's live actionability state directly from the DOM, independent of
 * any earlier Observation snapshot. Used both to revalidate a selected click target right
 * before it is dispatched (core/loop.ts) and inside the click executor itself
 * (actions/click.ts), so a decision is never executed against a target that has gone
 * stale (moved, hidden, disabled, covered, or removed) between when it was observed and
 * when it is acted on.
 */
export async function readElementState(page: Page, elementId: string): Promise<ElementState> {
  const selector = elementLocatorSelector(elementId);
  const state = await page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) {
      return { attached: false, visible: false, disabled: false, covered: false };
    }

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

    let covered = false;
    if (visible) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Coverage can only be safely determined for a point actually inside the current
      // viewport -- elementFromPoint outside it always returns null, which would
      // otherwise be misread as "covered".
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const topEl = document.elementFromPoint(cx, cy);
        covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
      }
    }

    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
    const destinationUrl = el instanceof HTMLAnchorElement ? el.href : undefined;
    return {
      attached: true,
      visible,
      disabled,
      covered,
      role,
      accessibleName,
      ...(destinationUrl ? { destinationUrl } : {}),
    };
  }, selector);

  return { ...state, actionable: state.attached && state.visible && !state.disabled && !state.covered };
}
