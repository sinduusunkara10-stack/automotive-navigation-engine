import type { Page } from "playwright";
import type { Observation } from "../types/task-response.js";

const ELEMENT_ID_ATTR = "data-nav-engine-id";
// Widened generically (not per-journey) to cover common non-anchor/non-button interactive
// controls a configurator, form, or wizard-style journey routinely uses -- tabs, options,
// radio/checkbox-style selectors, and submit-style inputs -- none of which is specific to
// any one site or brand. Still no iframe/shadow-DOM traversal: querySelectorAll only
// reaches the light DOM of this document, deliberately -- see docs/architecture.md
// "Observation evidence" for why that stays out of scope until a concrete site is shown to
// need it.
const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  '[role="radio"], [role="checkbox"], input[type="submit"], input[type="button"]';
// h1-h4 (was h1-h2): a configuration step's own heading is frequently an h3/h4 nested
// under a page-level h1/h2, and a generic "what state is this page in" signal should not
// be blind to it.
const HEADING_SELECTOR = "h1, h2, h3, h4";
// Generic, brand-agnostic progress-indicator evidence: any element a page marks up as a
// progress/step indicator via role or common ARIA attributes, read as plain visible text
// (e.g. "Step 2 of 4"). Never a hardcoded class name, selector, or brand-specific marker.
const PROGRESS_SELECTOR = '[role="progressbar"], [aria-valuenow], [aria-current="step"]';

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
      // with an identical accessible name) -- disabled/covered are reported as evidence
      // (see below) so the reasoning layer can factor them into its own choice, but both
      // remain point-in-time facts that can change by dispatch time, which is why
      // core/loop.ts's pre-dispatch revalidation and actions/click.ts's fallback (via
      // readElementState below) still exist as the safety net for a target that goes
      // stale between decision and execution.
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
          const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
          // Only the ARIA *selection/toggle-state* attributes a generic reasoning or
          // verification layer can use to tell "this option is currently chosen" from
          // "this option is merely offered" -- never a value tied to any one site's
          // vocabulary. Read as-is (string) rather than normalised to a closed set of
          // engine-defined states, so no future ARIA state value requires an engine change.
          const ariaState: Record<string, string> = {};
          for (const attrName of ["aria-selected", "aria-checked", "aria-pressed", "aria-current"]) {
            const value = el.getAttribute(attrName);
            if (value !== null) {
              ariaState[attrName] = value;
            }
          }
          // Same elementFromPoint hit-test readElementState (below) uses to revalidate a
          // click target right before dispatch -- computed here too so the reasoning layer
          // itself can see whether a control is genuinely reachable (e.g. a modal/overlay/
          // banner sitting on top of it) up front, instead of only discovering it after
          // proposing a click that then fails. Only ever computed for a point already
          // inside the viewport -- elementFromPoint outside it always returns null, which
          // would otherwise be misread as "covered".
          let covered = false;
          if (visible) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
              const topEl = document.elementFromPoint(cx, cy);
              covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
            }
          }
          return {
            id,
            role,
            accessibleName,
            visible,
            ...(destinationUrl ? { destinationUrl } : {}),
            ...(disabled ? { disabled } : {}),
            ...(Object.keys(ariaState).length > 0 ? { ariaState } : {}),
            ...(covered ? { covered } : {}),
          };
        })
        .filter((el) => el.visible);
    },
    { attr: ELEMENT_ID_ATTR, selector: INTERACTIVE_SELECTOR },
  );

  const notableText = await page.evaluate((selector) => {
    const headings = Array.from(document.querySelectorAll(selector));
    return headings.map((heading) => heading.textContent?.trim()).filter((text): text is string => Boolean(text));
  }, HEADING_SELECTOR);

  const progressIndicatorText = await page.evaluate((selector) => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
    return elements
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        return visible ? el.textContent?.trim() : undefined;
      })
      .filter((text): text is string => Boolean(text));
  }, PROGRESS_SELECTOR);

  return {
    url: page.url(),
    title: await page.title(),
    interactiveElements,
    ...(notableText.length > 0 ? { notableText } : {}),
    ...(progressIndicatorText.length > 0 ? { progressIndicatorText } : {}),
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
