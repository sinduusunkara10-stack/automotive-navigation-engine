import type { Page } from "playwright";
import { objectiveTokenCoverage } from "../discovery/relevance.js";

// Deliberately the same generic heading/interactive-element selectors as
// src/observation/observationBuilder.ts (kept in sync so success evaluation never sees
// narrower evidence than the reasoning layer's own observation). Nothing here is
// automotive/GA4/brand-specific -- see CLAUDE.md's non-negotiable design rule.
const HEADING_SELECTOR = "h1, h2, h3, h4";
const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  '[role="radio"], [role="checkbox"], input[type="submit"], input[type="button"]';

// Persistent site-wide navigation/menu/header/footer chrome renders identically on every
// page of a site -- a homepage's own top-nav or footer routinely lists "Offers", a model
// name, or a "Request a quote" CTA as a link to elsewhere, but that link being *present* is
// evidence the destination exists, never evidence the destination was actually *reached*.
// Excluding it here is what stops a semantic_page_match criterion describing a downstream
// milestone ("Navigate to the Offers page") from being satisfied by the *starting* page's
// own nav bar merely advertising that page -- see the investigation behind this change and
// docs/n8n-integration.md "Generic success criteria". Purely structural (standard HTML5
// landmark elements/ARIA landmark roles), never brand/site/vocabulary-specific: this is not
// a list of link text to avoid, it is a list of *regions* a page marks as chrome.
const NAVIGATION_CHROME_SELECTOR =
  'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="menubar"]';

export type SemanticSignalName = "title" | "headings" | "interactiveElements";

export const ALL_SEMANTIC_SIGNALS: readonly SemanticSignalName[] = ["title", "headings", "interactiveElements"];

export function isSemanticSignalName(value: unknown): value is SemanticSignalName {
  return value === "title" || value === "headings" || value === "interactiveElements";
}

export interface SemanticPageSignals {
  title: string;
  headings: string[];
  /**
   * Accessible names of visible interactive elements, excluding any element inside
   * persistent site-wide navigation/menu/header/footer chrome (see
   * NAVIGATION_CHROME_SELECTOR above) -- a global nav bar or footer renders identically on
   * every page, so a link/CTA living there is evidence a destination exists, never evidence
   * it was actually reached.
   */
  interactiveText: string[];
  /**
   * Optional, generic ARIA selection/toggle-state evidence for visible interactive
   * elements, e.g. "Step 2 (aria-current=step)" or "Blue (aria-selected=true)" -- read
   * verbatim from whatever attribute values the page itself uses, never normalised into an
   * engine-defined closed set of states. Extra context only: never fed into the
   * deterministic token-overlap score (scoreSemanticPageMatch below), only forwarded to an
   * optional semanticVerifier as additional evidence -- see
   * src/reasoning/semanticCriterionVerifier.ts.
   */
  ariaState?: string[];
  /** Optional, generic progress-indicator text (e.g. "Step 2 of 4"); same non-scoring role as ariaState. */
  progressText?: string[];
}

export interface GatherSemanticPageSignalsOptions {
  /**
   * PR 1D (truthful milestone evaluation, "Surface-scoped evidence" -- see
   * docs/architecture.md §21): when true, both headings and interactive elements are
   * further filtered to exclude anything currently covered by another element at its own
   * centre point -- the same generic elementFromPoint hit-test
   * observation/observationBuilder.ts already uses to compute InteractiveElement.covered.
   * Background page content sitting underneath a newly-opened drawer/modal/panel is
   * excluded from the evidence pool, so a semantic_page_match criterion cannot be satisfied
   * by leftover text from a page state a just-opened surface has visually covered over.
   * Off by default -- omitting this (every pre-existing caller) reproduces the exact prior
   * whole-page evidence pool.
   */
  scopeToUncoveredOnly?: boolean;
}

/**
 * Reads only visible, already-rendered text off the live page -- title, heading text, and
 * the accessible names of visible interactive elements outside persistent navigation/menu/
 * header/footer chrome -- the same category of compact, structured signal the observation
 * builder exposes to the reasoning layer. Never reads raw HTML, cookies, storage, or
 * headers.
 */
export async function gatherSemanticPageSignals(
  page: Page,
  options: GatherSemanticPageSignalsOptions = {},
): Promise<SemanticPageSignals> {
  const title = await page.title();
  // Every visibility check below is inlined (never a shared named helper function) --
  // esbuild/tsx's dev transform can wrap a const-bound arrow function in a `__name()`
  // helper call for stack-trace naming, and that helper only exists in the Node module
  // scope, not in the page.evaluate callback's serialized source once it runs in the
  // browser -- a real `ReferenceError: __name is not defined` this pattern avoids. See
  // src/observation/observationBuilder.ts for the same established, all-inline style.
  const { headings, interactiveText, ariaState, progressText } = await page.evaluate(
    ({ headingSelector, interactiveSelector, navigationChromeSelector, scopeToUncoveredOnly }) => {
      // Same elementFromPoint hit-test observation/observationBuilder.ts's own `covered`
      // field already uses -- deliberately duplicated inline at each use site below (never
      // factored into one shared local const/function, even within this one evaluate()
      // callback) for the same reason every other in-page scan function in this repo does:
      // esbuild/tsx's dev transform can wrap a const-bound arrow function in a `__name()`
      // helper call for stack-trace naming, and that helper only exists in the Node module
      // scope, not in this callback's serialized source once it runs in the browser -- a
      // real `ReferenceError: __name is not defined` this inline-only style avoids.
      const headings = Array.from(document.querySelectorAll<HTMLElement>(headingSelector))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!(rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none")) {
            return false;
          }
          if (scopeToUncoveredOnly) {
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
              const topEl = document.elementFromPoint(cx, cy);
              const covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
              if (covered) {
                return false;
              }
            }
          }
          return true;
        })
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean);

      const interactiveEls = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector)).filter((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (!(rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none")) {
          return false;
        }
        if (el.closest(navigationChromeSelector) !== null) {
          return false;
        }
        if (scopeToUncoveredOnly) {
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
            const topEl = document.elementFromPoint(cx, cy);
            const covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
            if (covered) {
              return false;
            }
          }
        }
        return true;
      });
      const interactiveText = interactiveEls
        .map((el) => el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "")
        .filter(Boolean);

      const ariaState: string[] = [];
      for (const el of interactiveEls) {
        const name = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
        if (!name) {
          continue;
        }
        for (const attrName of ["aria-selected", "aria-checked", "aria-pressed", "aria-current"]) {
          const value = el.getAttribute(attrName);
          if (value !== null) {
            ariaState.push(`${name} (${attrName}=${value})`);
          }
        }
      }

      const progressText = Array.from(
        document.querySelectorAll<HTMLElement>('[role="progressbar"], [aria-valuenow], [aria-current="step"]'),
      )
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean);

      return { headings, interactiveText, ariaState, progressText };
    },
    {
      headingSelector: HEADING_SELECTOR,
      interactiveSelector: INTERACTIVE_SELECTOR,
      navigationChromeSelector: NAVIGATION_CHROME_SELECTOR,
      scopeToUncoveredOnly: options.scopeToUncoveredOnly === true,
    },
  );
  return {
    title,
    headings,
    interactiveText,
    ...(ariaState.length > 0 ? { ariaState } : {}),
    ...(progressText.length > 0 ? { progressText } : {}),
  };
}

export interface SemanticPageMatchScore {
  /** Highest score across the enabled signal groups -- one strong, on-topic signal is enough. */
  overall: number;
  bySignal: Record<SemanticSignalName, number>;
}

/**
 * Scores how much of the anchor text's vocabulary (the task's objective, plus this
 * criterion's own description) shows up in each enabled page-signal group, using the same
 * generic token-overlap approach src/discovery/relevance.ts already uses for preflight
 * domain discovery. This is a literal-vocabulary match, not translation or true semantic
 * understanding: a page written in a different language than the objective will generally
 * score low even when it represents the same real-world state (see docs/n8n-integration.md
 * "Generic success criteria" for this known limitation and how to work around it).
 */
export function scoreSemanticPageMatch(
  anchorText: string,
  signals: SemanticPageSignals,
  enabledSignals: readonly SemanticSignalName[],
): SemanticPageMatchScore {
  const bySignal: Record<SemanticSignalName, number> = { title: 0, headings: 0, interactiveElements: 0 };

  if (enabledSignals.includes("title")) {
    bySignal.title = objectiveTokenCoverage(anchorText, signals.title);
  }
  if (enabledSignals.includes("headings")) {
    bySignal.headings = objectiveTokenCoverage(anchorText, signals.headings.join(" "));
  }
  if (enabledSignals.includes("interactiveElements")) {
    bySignal.interactiveElements = objectiveTokenCoverage(anchorText, signals.interactiveText.join(" "));
  }

  const overall = Math.max(bySignal.title, bySignal.headings, bySignal.interactiveElements);
  return { overall, bySignal };
}
