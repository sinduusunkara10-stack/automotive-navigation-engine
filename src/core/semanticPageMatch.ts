import type { Page } from "playwright";
import { objectiveTokenCoverage } from "../discovery/relevance.js";

// Deliberately the same generic heading/interactive-element selectors already used by
// src/observation/observationBuilder.ts, widened to h1-h3 (observation's notableText is
// capped at h1/h2 for prompt-size reasons; success evaluation has no such budget). Nothing
// here is automotive/GA4/brand-specific -- see CLAUDE.md's non-negotiable design rule.
const HEADING_SELECTOR = "h1, h2, h3";
const INTERACTIVE_SELECTOR = 'a, button, [role="button"], [role="link"]';

export type SemanticSignalName = "title" | "headings" | "interactiveElements";

export const ALL_SEMANTIC_SIGNALS: readonly SemanticSignalName[] = ["title", "headings", "interactiveElements"];

export function isSemanticSignalName(value: unknown): value is SemanticSignalName {
  return value === "title" || value === "headings" || value === "interactiveElements";
}

export interface SemanticPageSignals {
  title: string;
  headings: string[];
  interactiveText: string[];
}

/**
 * Reads only visible, already-rendered text off the live page -- title, heading text, and
 * the accessible names of visible interactive elements -- the same category of compact,
 * structured signal the observation builder exposes to the reasoning layer. Never reads raw
 * HTML, cookies, storage, or headers.
 */
export async function gatherSemanticPageSignals(page: Page): Promise<SemanticPageSignals> {
  const title = await page.title();
  const { headings, interactiveText } = await page.evaluate(
    ({ headingSelector, interactiveSelector }) => {
      const headings = Array.from(document.querySelectorAll<HTMLElement>(headingSelector))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((el) => el.textContent?.trim() ?? "")
        .filter(Boolean);

      const interactiveText = Array.from(document.querySelectorAll<HTMLElement>(interactiveSelector))
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        })
        .map((el) => el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "")
        .filter(Boolean);

      return { headings, interactiveText };
    },
    { headingSelector: HEADING_SELECTOR, interactiveSelector: INTERACTIVE_SELECTOR },
  );
  return { title, headings, interactiveText };
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
