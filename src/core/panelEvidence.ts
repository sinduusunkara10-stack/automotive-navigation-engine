import type { Page } from "playwright";
import type { ActiveSurfaceInfo } from "../types/task-response.js";
import {
  RELEVANCE_ADOPT_THRESHOLD,
  RELEVANCE_REJECT_THRESHOLD,
  type RelevanceTier,
} from "./surfaceRelevance.js";
import { ALL_SEMANTIC_SIGNALS, scoreSemanticPageMatch, type SemanticPageSignals } from "./semanticPageMatch.js";
import { tokenize } from "../discovery/relevance.js";

// Same bounded-scan philosophy as observation/observationBuilder.ts's own panel heuristic
// (MAX_PANEL_SCAN_DEPTH/MAX_PANEL_SCAN_NODES, MIN_PANEL_VIEWPORT_COVERAGE) -- deliberately
// duplicated as its own small constant set here rather than importing observationBuilder's
// private ones, since this module scans the *contents* of the panel container once found,
// not just whether one exists.
const MIN_PANEL_VIEWPORT_COVERAGE = 0.25;
const MAX_PANEL_SCAN_DEPTH = 3;
const MAX_PANEL_SCAN_NODES = 800;
const HEADING_SELECTOR = "h1, h2, h3, h4";
const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  '[role="radio"], [role="checkbox"], input[type="submit"], input[type="button"]';
const NEAR_FULLSCREEN_COVERAGE = 0.95;

/**
 * Generic, panel-container-scoped evidence for an in-document surface (a drawer/modal/side
 * panel opened without role="dialog"/aria-modal -- see observation/observationBuilder.ts's
 * own panelSignature heuristic, which this reuses the same bounded-scan shape as). Analogous
 * to Observation.activeDialog, but structured and container-scoped rather than a single
 * signature string, and computed for the broader non-ARIA panel heuristic too (see
 * CLAUDE.md's non-negotiable design rule -- this file has zero brand/site-specific logic;
 * every selector here is standards-based/structural).
 */
export interface PanelEvidence {
  /** True once a scoped container (the largest visible fixed/absolute/sticky element, same heuristic as observationBuilder's panelSignature) was actually found. False for every field below when this is false. */
  containerFound: boolean;
  /** A short, generic role|text signature -- stable across repeated observations of the same unchanged surface, the same way observationBuilder's own panelSignature already is. */
  identity: string;
  /** The container's own role/tag, e.g. "dialog", "div". */
  role: string;
  /** Heading text found inside the container only (never the whole page). */
  headings: string[];
  /** Accessible names of visible interactive controls found inside the container only. */
  interactiveText: string[];
  /** False only when the container appears to occupy virtually the whole viewport AND no other visible interactive control exists outside it -- i.e. the document as a whole looks blocked by an opaque, unrelated overlay rather than merely having this one panel open alongside normal page content. */
  documentUsable: boolean;
  /**
   * Generic relevance/relatedness scoring for this panel's own content against the task
   * objective -- computed the exact same way core/surfaceRelevance.ts already scores an
   * adopted popup/new-tab candidate (scoreSemanticPageMatch + the same adopt/reject
   * thresholds), just against this panel's own scoped text instead of a whole separate
   * page. Never a brand/keyword blocklist -- see surfaceRelevance.ts's own doc comment.
   */
  relevance: {
    tier: RelevanceTier;
    score: number;
    adoptThreshold: number;
    rejectThreshold: number;
  };
}

interface RawPanelScanResult {
  containerFound: boolean;
  role: string;
  text: string;
  headings: string[];
  interactiveText: string[];
  containerCoverage: number;
  visibleInteractiveOutsideContainer: boolean;
}

function scanPanelContainer(args: {
  headingSelector: string;
  interactiveSelector: string;
  panelMinCoverage: number;
  panelMaxDepth: number;
  panelMaxNodes: number;
}): RawPanelScanResult {
  // Deliberately no const-bound arrow/named helper function anywhere in this in-page
  // function (e.g. a shared "isVisible" helper) -- see observation/observationBuilder.ts's
  // own doc comment on this exact esbuild/tsx dev-transform "__name is not defined" pitfall
  // for page.evaluate() callbacks; every visibility check below is inlined instead.
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const viewportArea = viewportWidth * viewportHeight;

  let bestEl: Element | undefined;
  let bestArea = 0;
  let bestCoverage = 0;

  if (viewportArea > 0) {
    let visitedNodes = 0;
    const stack: Array<{ el: Element; depth: number }> = [{ el: document.body, depth: 0 }];
    while (stack.length > 0 && visitedNodes < args.panelMaxNodes) {
      const frame = stack.pop();
      if (!frame || frame.depth > args.panelMaxDepth) {
        continue;
      }
      for (const child of Array.from(frame.el.children)) {
        if (visitedNodes >= args.panelMaxNodes) {
          break;
        }
        visitedNodes += 1;
        const childStyle = window.getComputedStyle(child);
        if (
          childStyle.display !== "none" &&
          childStyle.visibility !== "hidden" &&
          (childStyle.position === "fixed" || childStyle.position === "absolute" || childStyle.position === "sticky")
        ) {
          const rect = child.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            const area = rect.width * rect.height;
            const coverage = area / viewportArea;
            const spansFullHeight = rect.height >= viewportHeight * 0.9 && rect.width < viewportWidth * 0.95;
            const spansFullWidth = rect.width >= viewportWidth * 0.9 && rect.height < viewportHeight * 0.95;
            if (area > bestArea && (coverage >= args.panelMinCoverage || spansFullHeight || spansFullWidth)) {
              bestArea = area;
              bestCoverage = coverage;
              bestEl = child;
            }
          }
        }
        stack.push({ el: child, depth: frame.depth + 1 });
      }
    }
  }

  if (!bestEl) {
    return {
      containerFound: false,
      role: "",
      text: "",
      headings: [],
      interactiveText: [],
      containerCoverage: 0,
      visibleInteractiveOutsideContainer: true,
    };
  }

  const container = bestEl;
  const role = container.getAttribute("role") ?? container.tagName.toLowerCase();
  const text = (container.getAttribute("aria-label")?.trim() || container.textContent?.trim() || "").slice(0, 80);

  const headings = Array.from(container.querySelectorAll<HTMLElement>(args.headingSelector))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })
    .map((el) => el.textContent?.trim() ?? "")
    .filter(Boolean);

  const interactiveText = Array.from(container.querySelectorAll<HTMLElement>(args.interactiveSelector))
    .filter((el) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    })
    .map((el) => el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "")
    .filter(Boolean);

  const outsideCandidates = Array.from(document.querySelectorAll<HTMLElement>(args.interactiveSelector)).filter(
    (el) => !container.contains(el),
  );
  const visibleInteractiveOutsideContainer = outsideCandidates.some((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });

  return {
    containerFound: true,
    role,
    text,
    headings,
    interactiveText,
    containerCoverage: bestCoverage,
    visibleInteractiveOutsideContainer,
  };
}

/**
 * Panel-scoped evidence (item 1 of the approved panel-attribution design -- see CLAUDE.md
 * and docs/architecture.md "Surface-scoped evidence"): computed only when `activeSurface`
 * is `{kind: "in_document"}`; undefined for every other surface kind (including "main" and
 * "adopted_context", which have their own dedicated evidence paths already -- a whole
 * separate Page for "adopted_context", and the ordinary whole-page observation for "main").
 * Reads only visible, already-rendered text -- never raw HTML, cookies, storage, or headers,
 * consistent with every other observation function in this engine.
 */
export async function gatherPanelEvidence(
  page: Page,
  activeSurface: ActiveSurfaceInfo | undefined,
  objectiveText: string,
): Promise<PanelEvidence | undefined> {
  if (!activeSurface || activeSurface.kind !== "in_document") {
    return undefined;
  }

  const raw = await page.evaluate(scanPanelContainer, {
    headingSelector: HEADING_SELECTOR,
    interactiveSelector: INTERACTIVE_SELECTOR,
    panelMinCoverage: MIN_PANEL_VIEWPORT_COVERAGE,
    panelMaxDepth: MAX_PANEL_SCAN_DEPTH,
    panelMaxNodes: MAX_PANEL_SCAN_NODES,
  });

  const signals: SemanticPageSignals = {
    title: "",
    headings: raw.headings,
    interactiveText: raw.interactiveText,
  };
  const score = raw.containerFound
    ? scoreSemanticPageMatch(objectiveText, signals, ALL_SEMANTIC_SIGNALS).overall
    : 0;
  const tier: RelevanceTier =
    score >= RELEVANCE_ADOPT_THRESHOLD ? "adopt" : score <= RELEVANCE_REJECT_THRESHOLD ? "reject" : "ambiguous";

  const documentUsable = !raw.containerFound || raw.containerCoverage < NEAR_FULLSCREEN_COVERAGE || raw.visibleInteractiveOutsideContainer;

  return {
    containerFound: raw.containerFound,
    identity: `${raw.role}|${raw.text}`,
    role: raw.role,
    headings: raw.headings,
    interactiveText: raw.interactiveText,
    documentUsable,
    relevance: {
      tier,
      score,
      adoptThreshold: RELEVANCE_ADOPT_THRESHOLD,
      rejectThreshold: RELEVANCE_REJECT_THRESHOLD,
    },
  };
}

// Small, generic, structural cross-UI vocabulary (never a brand/site name) for the item-3
// close-guard's own "does this control look like it dismisses the surface" signal -- a
// closed set of the handful of words/glyphs any dismiss control in any language-neutral UI
// convention commonly uses. Whole-token match only (via tokenize), so "close" matches but
// "closest"/"disclose" never do. This is only ever *one* signal the guard consults, never
// sufficient on its own to conclude a surface is unrelated to the objective (see
// surfaceRelevance-based scoring above for that).
const GENERIC_DISMISS_TOKENS = new Set(["close", "dismiss", "cancel", "skip", "x"]);

export function looksLikeGenericDismissControl(accessibleName: string | undefined): boolean {
  if (!accessibleName) {
    return false;
  }
  const trimmed = accessibleName.trim();
  if (trimmed === "×" || trimmed === "✕" || trimmed === "✖") {
    return true;
  }
  const tokens = tokenize(trimmed);
  return tokens.length > 0 && tokens.every((token) => GENERIC_DISMISS_TOKENS.has(token));
}
