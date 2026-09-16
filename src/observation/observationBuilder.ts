import type { Page } from "playwright";
import type { ElementDiscoveryDiagnostics, InteractiveElement, Observation } from "../types/task-response.js";
import {
  frameScopedElementId,
  listChildFrames,
  localElementId,
  resolveElementFrame,
  type FrameActionTarget,
} from "./frames.js";

const ELEMENT_ID_ATTR = "data-nav-engine-id";
// Widened generically (not per-journey) to cover common non-anchor/non-button interactive
// controls a configurator, form, or wizard-style journey routinely uses -- tabs, options,
// radio/checkbox-style selectors, and submit-style inputs -- none of which is specific to
// any one site or brand.
const INTERACTIVE_SELECTOR =
  'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
  '[role="radio"], [role="checkbox"], input[type="submit"], input[type="button"]';
// h1-h4 (was h1-h2): a configuration step's own heading is frequently an h3/h4 nested
// under a page-level h1/h2, and a generic "what state is this page in" signal should not
// be blind to it.
const HEADING_SELECTOR = "h1, h2, h3, h4";
// Standards-based, brand-agnostic modal/dialog surface detection (overlay-click-detection
// fix -- see CLAUDE.md and docs/architecture.md "Modal-aware observation"). Native <dialog>
// is included alongside the two ARIA signals since a page can mark up a modal either way.
// Deliberately never widened to a heuristic "looks like an overlay" selector (fixed/absolute
// positioning, high z-index, etc.) for *this* detection -- that would be far more prone to
// false positives from cookie banners, sticky headers, or ads than the two explicit,
// standards-based signals a page author chooses deliberately when marking up a real dialog,
// and this signal directly gates click-success/route-progress attribution (see
// detectTargetAttributableSideEffect below), where a false positive has real consequences.
// PR 1C-a (drawer/modal/half-window detection beyond role="dialog"/aria-modal) adds a
// *separate*, lower-stakes heuristic (see panelSignature/classifyObservedSurfaceChange
// below) that is never used for that click-success/route-progress purpose -- only to give
// the reasoning layer prompt-context evidence that a new surface likely appeared, where a
// false positive costs one extra sentence of context, never a wrong success/progress call.
export const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"], dialog';
// PR 1C-a: bounded shallow scan for a visible, large, fixed/absolute/sticky-positioned
// element -- the generic shape of a drawer/side-panel/half-window that a page author did
// not mark up with role="dialog"/aria-modal. Deliberately bounded on two axes so this can
// never become an expensive full-tree walk: MAX_PANEL_SCAN_DEPTH (levels below <body>) and
// MAX_PANEL_SCAN_NODES (total elements visited), both generous enough for the common case
// (a drawer is almost always a direct or near-direct child of <body>, often portal-rendered)
// while bounding the cost on a large, deeply-nested, or many-sibling page.
const MIN_PANEL_VIEWPORT_COVERAGE = 0.25;
const MAX_PANEL_SCAN_DEPTH = 3;
const MAX_PANEL_SCAN_NODES = 800;
// Bounded ancestor walk used to find a repeated card/list-item's own nearby heading (see
// nearestHeadingText below) -- kept small so this never approaches an unbounded scan of a
// large page for an element with no nearby heading at all.
const MAX_HEADING_ANCESTOR_HOPS = 5;
// Generic, brand-agnostic progress-indicator evidence: any element a page marks up as a
// progress/step indicator via role or common ARIA attributes, read as plain visible text
// (e.g. "Step 2 of 4"). Never a hardcoded class name, selector, or brand-specific marker.
const PROGRESS_SELECTOR = '[role="progressbar"], [aria-valuenow], [aria-current="step"]';

// Bounded: a page reporting more inaccessible frames than this simply has the rest
// silently uncounted -- this is diagnostic evidence for a human, never a control input,
// so truncating it can never change engine behaviour.
const MAX_REPORTED_INACCESSIBLE_FRAME_ORIGINS = 5;

interface RawScannedElement {
  id: string;
  role: string;
  accessibleName: string;
  visible: boolean;
  destinationUrl?: string;
  disabled?: boolean;
  ariaState?: Record<string, string>;
  covered?: boolean;
  nearestHeadingText?: string;
}

interface FrameScanResult {
  elements: RawScannedElement[];
  diagnostics: ElementDiscoveryDiagnostics;
}

/**
 * Runs inside the browser (via evaluate) against whichever document it's bound to -- the
 * main page's or a same-origin child frame's, identically. A hidden element
 * (display:none/visibility:hidden/zero-size -- e.g. a responsive duplicate nav link kept
 * in the DOM for another breakpoint) has no visual affordance a reasoning decision could
 * legitimately be based on, so it is never offered as a candidate at all -- this is a
 * permanent, safely-determinable fact at scan time. Disabled/covered elements *are* still
 * offered here (a model choosing one is not inherently confused, unlike picking an
 * invisible duplicate with an identical accessible name) -- disabled/covered are reported
 * as evidence so the reasoning layer can factor them into its own choice, but both remain
 * point-in-time facts that can change by dispatch time, which is why core/loop.ts's
 * pre-dispatch revalidation and actions/click.ts's fallback (via readElementState below)
 * still exist as the safety net for a target that goes stale between decision and
 * execution.
 *
 * Also returns bounded, generic diagnostic counts about the scan itself (see
 * ElementDiscoveryDiagnostics/Observation.elementDiscoveryDiagnostics in
 * types/task-response.ts) -- computed from the same single pass over `elements`, never a
 * second DOM query, so this is not a meaningfully more expensive scan than before.
 * `document.querySelectorAll` (both here and for shadowHostCount below) only ever searches
 * light-DOM descendants of the document it's called against -- it cannot see into any
 * shadow root, open or closed, which is exactly the gap shadowHostCount exists to surface:
 * a page whose actual controls live inside a shadow-DOM-encapsulated component will scan
 * as rawElementCount: 0 here while shadowHostCount is greater than 0.
 */
function scanInteractiveElements({
  attr,
  selector,
  headingSelector,
  maxHeadingAncestorHops,
}: {
  attr: string;
  selector: string;
  headingSelector: string;
  maxHeadingAncestorHops: number;
}): FrameScanResult {
  // Bounded, generic ancestor walk: finds the nearest enclosing container that itself
  // contains a heading (h1-h4), and returns that heading's own text -- a cheap,
  // markup-agnostic proxy for "which repeated card/list-item is this control part of"
  // (e.g. a listing of cards each with its own "<h3>Product Name</h3>...<button>View
  // Details</button>"). Used only to disambiguate route-memory candidate identity for
  // controls that share an identical role+accessibleName across multiple repeated cards
  // (see core/routeMemory.ts) -- never a selector, never brand/site-specific. Stops at the
  // first ancestor level with a match (the *closest* enclosing heading), and gives up after
  // maxHeadingAncestorHops levels so an element with no nearby heading never triggers an
  // unbounded walk up a large page.
  const elements = Array.from(document.querySelectorAll<HTMLElement>(selector));
  let buttonLikeCount = 0;
  let linkLikeCount = 0;
  let otherRoleCount = 0;
  let excludedZeroSizeCount = 0;
  let excludedDisplayNoneCount = 0;
  let excludedVisibilityHiddenCount = 0;

  const scanned = elements.map((el, index) => {
    let id = el.getAttribute(attr);
    if (!id) {
      id = `el-${index}`;
      el.setAttribute(attr, id);
    }
    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const zeroSize = rect.width <= 0 || rect.height <= 0;
    const displayNone = style.display === "none";
    const visibilityHidden = style.visibility === "hidden";
    const visible = !zeroSize && !displayNone && !visibilityHidden;
    const destinationUrl = el instanceof HTMLAnchorElement ? el.href : undefined;
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
    // Only the ARIA *selection/toggle-state* attributes a generic reasoning or
    // verification layer can use to tell "this option is currently chosen" from "this
    // option is merely offered" -- never a value tied to any one site's vocabulary.
    // Read as-is (string) rather than normalised to a closed set of engine-defined
    // states, so no future ARIA state value requires an engine change.
    const ariaState: Record<string, string> = {};
    for (const attrName of ["aria-selected", "aria-checked", "aria-pressed", "aria-current", "aria-expanded"]) {
      const value = el.getAttribute(attrName);
      if (value !== null) {
        ariaState[attrName] = value;
      }
    }
    // Same elementFromPoint hit-test readElementState (below) uses to revalidate a
    // click target right before dispatch -- computed here too so the reasoning layer
    // itself can see whether a control is genuinely reachable (e.g. a modal/overlay/
    // banner sitting on top of it) up front, instead of only discovering it after
    // proposing a click that then fails. Only ever computed for a point already inside
    // the viewport -- elementFromPoint outside it always returns null, which would
    // otherwise be misread as "covered".
    let covered = false;
    if (visible) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const topEl = document.elementFromPoint(cx, cy);
        covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
      }
    }

    if (role === "button") {
      buttonLikeCount += 1;
    } else if (role === "a" || role === "link") {
      linkLikeCount += 1;
    } else {
      otherRoleCount += 1;
    }
    if (!visible) {
      if (zeroSize) excludedZeroSizeCount += 1;
      if (displayNone) excludedDisplayNoneCount += 1;
      if (visibilityHidden) excludedVisibilityHiddenCount += 1;
    }

    // Bounded ancestor walk for the nearest enclosing heading's text (see the doc comment
    // above) -- inlined directly rather than factored into a separately-named local
    // function/const: Playwright's evaluate() serializes only this outer function's own
    // source text and runs it standalone in the browser, detached from the rest of this
    // module/bundle, and a nested named function binding can carry a bundler-injected
    // helper reference (esbuild's "__name", used for debug-friendly function naming) that
    // does not exist once evaluated in isolation.
    let headingText: string | undefined;
    let headingWalkNode: HTMLElement = el;
    for (let hops = 0; hops < maxHeadingAncestorHops && headingWalkNode.parentElement; hops += 1) {
      headingWalkNode = headingWalkNode.parentElement;
      const heading = headingWalkNode.querySelector(headingSelector);
      const headingCandidateText = heading?.textContent?.trim();
      if (headingCandidateText) {
        headingText = headingCandidateText.slice(0, 80);
        break;
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
      ...(headingText ? { nearestHeadingText: headingText } : {}),
    };
  });

  const visibleScanned = scanned.filter((el) => el.visible);

  // Open shadow roots only -- a closed shadow root's presence cannot be detected from
  // outside the component that created it; the DOM API gives no way to ask. See the
  // Observation.elementDiscoveryDiagnostics doc comment for what this does and doesn't tell
  // a caller.
  const shadowHostCount = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(
    (el) => el.shadowRoot !== null,
  ).length;

  return {
    elements: visibleScanned,
    diagnostics: {
      rawElementCount: elements.length,
      buttonLikeCount,
      linkLikeCount,
      otherRoleCount,
      visibleElementCount: visibleScanned.length,
      excludedZeroSizeCount,
      excludedDisplayNoneCount,
      excludedVisibilityHiddenCount,
      shadowHostCount,
    },
  };
}

async function scanFrame(target: FrameActionTarget): Promise<FrameScanResult> {
  return target.evaluate(scanInteractiveElements, {
    attr: ELEMENT_ID_ATTR,
    selector: INTERACTIVE_SELECTOR,
    headingSelector: HEADING_SELECTOR,
    maxHeadingAncestorHops: MAX_HEADING_ANCESTOR_HOPS,
  });
}

/**
 * Runs inside the browser to find the first visible dialog/modal surface (see
 * DIALOG_SELECTOR above), returning a small, generic identity for it (role + a short
 * accessible-name/text excerpt) -- never its full content. Used both for
 * Observation.activeDialog (buildObservation below) and for the pre/post-click
 * InteractionSnapshot comparison (captureInteractionSnapshot below) so both share the exact
 * same detection rule.
 */
function scanActiveDialog(selector: string): { role: string; accessibleName: string } | undefined {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    if (!visible) {
      continue;
    }
    const role = el.getAttribute("role") ?? (el.tagName.toLowerCase() === "dialog" ? "dialog" : el.tagName.toLowerCase());
    const accessibleName = (el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "").slice(0, 120);
    return { role, accessibleName };
  }
  return undefined;
}

function mergeDiscoveryDiagnostics(
  a: ElementDiscoveryDiagnostics,
  b: ElementDiscoveryDiagnostics,
): ElementDiscoveryDiagnostics {
  return {
    rawElementCount: a.rawElementCount + b.rawElementCount,
    buttonLikeCount: a.buttonLikeCount + b.buttonLikeCount,
    linkLikeCount: a.linkLikeCount + b.linkLikeCount,
    otherRoleCount: a.otherRoleCount + b.otherRoleCount,
    visibleElementCount: a.visibleElementCount + b.visibleElementCount,
    excludedZeroSizeCount: a.excludedZeroSizeCount + b.excludedZeroSizeCount,
    excludedDisplayNoneCount: a.excludedDisplayNoneCount + b.excludedDisplayNoneCount,
    excludedVisibilityHiddenCount: a.excludedVisibilityHiddenCount + b.excludedVisibilityHiddenCount,
    shadowHostCount: a.shadowHostCount + b.shadowHostCount,
  };
}

export async function buildObservation(page: Page): Promise<Observation> {
  const main = await scanFrame(page);
  const interactiveElements: InteractiveElement[] = main.elements.map(({ id, ...rest }) => ({ id, ...rest }));
  let elementDiscoveryDiagnostics = main.diagnostics;

  // Generic, one-level same-origin child-frame support (no vendor/CMP-specific selector,
  // no assumption about which frame a blocker lives in -- see observation/frames.ts). A
  // frame the engine cannot evaluate script in at all (removed mid-scan, or otherwise
  // inaccessible) contributes no candidates and is reported only as an origin, never
  // silently substituted with anything from the main document.
  const { accessible: childFrames, inaccessible: inaccessibleFrames } = await listChildFrames(page);
  for (const child of childFrames) {
    let scanned: FrameScanResult;
    try {
      scanned = await scanFrame(child.frame);
    } catch {
      // The frame detached between the accessibility probe and this scan -- treat exactly
      // like any other inaccessible frame rather than letting the error propagate and take
      // down the whole observation. Its diagnostics are unknowable, not zero -- excluded
      // from the aggregate rather than silently counted as "nothing found".
      inaccessibleFrames.push({ frameIndex: child.frameIndex, origin: child.origin });
      continue;
    }
    elementDiscoveryDiagnostics = mergeDiscoveryDiagnostics(elementDiscoveryDiagnostics, scanned.diagnostics);
    for (const el of scanned.elements) {
      interactiveElements.push({
        ...el,
        id: frameScopedElementId(child.frameIndex, el.id),
        frameOrigin: child.origin,
      });
    }
  }

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

  const inaccessibleFrameOrigins = [...new Set(inaccessibleFrames.map((f) => f.origin))].slice(
    0,
    MAX_REPORTED_INACCESSIBLE_FRAME_ORIGINS,
  );

  // Modal-aware observation (see CLAUDE.md and docs/architecture.md "Modal-aware
  // observation"): a page-level signal that a dialog/modal surface is currently open, so
  // the reasoning prompt (src/reasoning/promptBuilder.ts) can prioritise its descendant
  // controls over background page chrome without needing a new per-element field. Detected
  // only in the main document -- see the "known limitations" note in
  // docs/architecture.md for why this deliberately does not reach into child frames yet.
  const activeDialog = await page.evaluate(scanActiveDialog, DIALOG_SELECTOR);

  return {
    url: page.url(),
    title: await page.title(),
    interactiveElements,
    ...(notableText.length > 0 ? { notableText } : {}),
    ...(progressIndicatorText.length > 0 ? { progressIndicatorText } : {}),
    ...(inaccessibleFrameOrigins.length > 0 ? { inaccessibleFrameOrigins } : {}),
    elementDiscoveryDiagnostics,
    ...(activeDialog ? { activeDialog } : {}),
  };
}

export function elementLocatorSelector(elementId: string): string {
  return `[${ELEMENT_ID_ATTR}="${localElementId(elementId)}"]`;
}

export interface ElementState {
  attached: boolean;
  visible: boolean;
  disabled: boolean;
  covered: boolean;
  /**
   * A compact, generic fingerprint of whatever element is currently intercepting this
   * one's hit-test point -- present only when covered is true. Built purely from the
   * intercepting element's own tag/role/trimmed text (the same generic ingredients
   * accessibleName below already uses), never from any site-specific selector or
   * vendor/CMP attribute. Lets a caller compare two covered readings of the *same* target
   * taken at different times and recognise whether the same obstruction is still present
   * versus a different one now sitting there -- see core/loop.ts's blocker-persistence
   * tracking (RunState.lastBlockerSignature).
   */
  coveredBySignature?: string;
  /**
   * Target-attributable click-success fix: the same generic ARIA selection/toggle-state
   * evidence InteractiveElement.ariaState already carries in Observation (see
   * scanInteractiveElements below), read here too so a caller can compare a click target's
   * own before/after state -- e.g. aria-expanded flipping to "true" is generic, standards-
   * based evidence that *this* control's own click opened something, independent of
   * whatever else may have changed elsewhere on the page. Never normalised into an
   * engine-defined closed set of states, for the same reason InteractiveElement.ariaState
   * isn't either.
   */
  ariaState?: Record<string, string>;
  /** True only when the element's own frame could not be resolved/evaluated at all. */
  frameUnavailable: boolean;
  actionable: boolean;
  role?: string;
  accessibleName?: string;
  destinationUrl?: string;
}

async function readElementStateFrom(target: FrameActionTarget, selector: string): Promise<Omit<ElementState, "actionable" | "frameUnavailable">> {
  return target.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) {
      return { attached: false, visible: false, disabled: false, covered: false };
    }

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    const disabled = el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

    let covered = false;
    let coveredBySignature: string | undefined;
    if (visible) {
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Coverage can only be safely determined for a point actually inside the current
      // viewport -- elementFromPoint outside it always returns null, which would
      // otherwise be misread as "covered".
      if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
        const topEl = document.elementFromPoint(cx, cy);
        covered = topEl !== null && !el.contains(topEl) && !topEl.contains(el);
        if (covered && topEl) {
          const topElRole = topEl.getAttribute("role") ?? topEl.tagName.toLowerCase();
          const topElText = (topEl.getAttribute("aria-label")?.trim() || topEl.textContent?.trim() || "").slice(0, 60);
          coveredBySignature = `${topEl.tagName.toLowerCase()}|${topElRole}|${topElText}`;
        }
      }
    }

    const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
    const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
    const destinationUrl = el instanceof HTMLAnchorElement ? el.href : undefined;
    const ariaState: Record<string, string> = {};
    for (const attrName of ["aria-selected", "aria-checked", "aria-pressed", "aria-current", "aria-expanded"]) {
      const value = el.getAttribute(attrName);
      if (value !== null) {
        ariaState[attrName] = value;
      }
    }
    return {
      attached: true,
      visible,
      disabled,
      covered,
      ...(coveredBySignature ? { coveredBySignature } : {}),
      ...(Object.keys(ariaState).length > 0 ? { ariaState } : {}),
      role,
      accessibleName,
      ...(destinationUrl ? { destinationUrl } : {}),
    };
  }, selector);
}

/**
 * Re-reads one element's live actionability state directly from the DOM, independent of
 * any earlier Observation snapshot. Used both to revalidate a selected click target right
 * before it is dispatched (core/loop.ts) and inside the click executor itself
 * (actions/click.ts), so a decision is never executed against a target that has gone
 * stale (moved, hidden, disabled, covered, removed, or -- for a frame-scoped element --
 * whose owning frame itself went away) between when it was observed and when it is acted
 * on. A frame-scoped element id (see observation/frames.ts) is resolved against the *live*
 * frame list every time this is called, never a cached handle.
 */
export async function readElementState(page: Page, elementId: string): Promise<ElementState> {
  const selector = elementLocatorSelector(elementId);
  const resolution = await resolveElementFrame(page, elementId);

  if (resolution.status === "unavailable") {
    return {
      attached: false,
      visible: false,
      disabled: false,
      covered: false,
      frameUnavailable: true,
      actionable: false,
    };
  }

  const target: FrameActionTarget = resolution.status === "resolved" ? resolution.frame : page;
  const state = await readElementStateFrom(target, selector);

  return {
    ...state,
    frameUnavailable: false,
    actionable: state.attached && state.visible && !state.disabled && !state.covered,
  };
}

/** Resolves the live Frame (or the main Page) an already-observed element id lives in, for callers that need to act on it directly (e.g. actions/click.ts). Returns undefined if that frame is no longer available. */
export async function resolveElementActionTarget(page: Page, elementId: string): Promise<FrameActionTarget | undefined> {
  const resolution = await resolveElementFrame(page, elementId);
  if (resolution.status === "unavailable") {
    return undefined;
  }
  return resolution.status === "resolved" ? resolution.frame : page;
}

/**
 * Overlay-click-detection fix (see CLAUDE.md and docs/architecture.md "Overlay-click side
 * effect detection"): a small, lightweight, main-document-only fingerprint of "what
 * interactive surface is currently on screen", taken immediately before a click and
 * compared against one taken shortly after. Deliberately narrow -- never raw HTML, never
 * full element content -- just enough to answer "did a genuinely new interactive surface
 * (a dialog, or a meaningfully different set of controls) appear" generically, for any
 * site. Main-document only, matching "do not capture excessive page content" -- a click
 * that opens a same-origin-iframe-scoped or shadow-DOM-scoped modal is outside this
 * specific check's scope (see docs/architecture.md's limitations note).
 */
export interface InteractionSnapshot {
  hasDialog: boolean;
  /** Present only when hasDialog is true -- a compact identity for the dialog(s) currently on screen, so a *different* dialog appearing (not just "a dialog exists, still") can be told apart from one that was already open before the click. */
  dialogSignature?: string;
  /** Sorted, deduplicated role::accessibleName identities of every currently visible interactive element (same vocabulary as core/routeMemory.ts's own candidate identity) -- never raw text beyond what accessibleName already carries. */
  interactiveIdentities: string[];
  /**
   * PR 1C-a: a compact identity (tag|role|text, mirroring dialogSignature/coveredBySignature)
   * for the single largest visible fixed/absolute/sticky-positioned element found by the
   * bounded MIN_PANEL_VIEWPORT_COVERAGE/MAX_PANEL_SCAN_DEPTH/MAX_PANEL_SCAN_NODES heuristic
   * scan above -- present only when at least one such element was found. Deliberately a
   * *different*, lower-stakes signal from dialogSignature -- see DIALOG_SELECTOR's own doc
   * comment on why this heuristic is never used for click-success/route-progress
   * attribution, only for classifyObservedSurfaceChange's prompt-context evidence below.
   */
  panelSignature?: string;
}

// Deliberately duplicated inline in scanInteractionSnapshot below (once per .filter() call)
// rather than factored into one shared, separately-named local helper: see
// scanInteractiveElements's own doc comment on why a nested named function/const binding
// inside a function passed to Playwright's evaluate() is unsafe (esbuild's dev "__name"
// helper, undefined once evaluated standalone in the browser).
function scanInteractionSnapshot(args: {
  dialogSelector: string;
  interactiveSelector: string;
  panelMinCoverage: number;
  panelMaxDepth: number;
  panelMaxNodes: number;
}): InteractionSnapshot {
  const dialogEls = Array.from(document.querySelectorAll<HTMLElement>(args.dialogSelector)).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  const hasDialog = dialogEls.length > 0;
  const dialogSignature = hasDialog
    ? dialogEls
        .map((el) => {
          const role = el.getAttribute("role") ?? (el.tagName.toLowerCase() === "dialog" ? "dialog" : el.tagName.toLowerCase());
          const text = (el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "").slice(0, 80);
          return `${role}|${text}`;
        })
        .sort()
        .join("~")
    : undefined;

  const interactiveEls = Array.from(document.querySelectorAll<HTMLElement>(args.interactiveSelector)).filter((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  const interactiveIdentities = [
    ...new Set(
      interactiveEls.map((el) => {
        const role = el.getAttribute("role") ?? el.tagName.toLowerCase();
        const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
        return `${role}::${accessibleName}`;
      }),
    ),
  ].sort();

  // PR 1C-a: bounded shallow scan (see MAX_PANEL_SCAN_DEPTH/MAX_PANEL_SCAN_NODES above) for
  // the largest visible fixed/absolute/sticky element large enough to plausibly be a
  // drawer/side-panel/half-window. Written as a flat, explicit stack walk with no nested
  // named function/const binding -- see scanInteractiveElements's own doc comment above on
  // why that pattern is unsafe inside a function Playwright's evaluate() serialises and
  // runs standalone (esbuild's dev "__name" helper does not exist once evaluated in
  // isolation).
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const viewportArea = viewportWidth * viewportHeight;
  let panelSignature: string | undefined;
  if (viewportArea > 0) {
    let bestArea = 0;
    let bestRole = "";
    let bestText = "";
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
              bestRole = child.getAttribute("role") ?? child.tagName.toLowerCase();
              bestText = (child.getAttribute("aria-label")?.trim() || child.textContent?.trim() || "").slice(0, 80);
            }
          }
        }
        stack.push({ el: child, depth: frame.depth + 1 });
      }
    }
    if (bestArea > 0) {
      panelSignature = `${bestRole}|${bestText}`;
    }
  }

  return {
    hasDialog,
    ...(dialogSignature ? { dialogSignature } : {}),
    interactiveIdentities,
    ...(panelSignature ? { panelSignature } : {}),
  };
}

export async function captureInteractionSnapshot(page: Page): Promise<InteractionSnapshot> {
  return page.evaluate(scanInteractionSnapshot, {
    dialogSelector: DIALOG_SELECTOR,
    interactiveSelector: INTERACTIVE_SELECTOR,
    panelMinCoverage: MIN_PANEL_VIEWPORT_COVERAGE,
    panelMaxDepth: MAX_PANEL_SCAN_DEPTH,
    panelMaxNodes: MAX_PANEL_SCAN_NODES,
  });
}

export type ClickSideEffectType = "dialog_appeared" | "dialog_changed" | "interactive_surface_changed";

// A single newly-appeared interactive element is not treated as evidence on its own -- an
// injected ad, a lazy-loaded font-triggered reflow, or an analytics-driven DOM tweak can
// each incidentally add one interactive-looking node without representing a real click
// side effect (requirement: "do not treat every DOM mutation as successful evidence"). A
// genuine modal/drawer opening from a click almost always introduces *several* new controls
// at once (a heading/close control plus its own actions), so requiring at least two is a
// simple, generic way to bias strongly against that class of false positive while still
// catching the common real case. The dialog-based signals above remain the primary,
// highest-confidence evidence; this is only the fallback for a modal-like surface that
// doesn't happen to use role="dialog"/aria-modal.
const MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE = 2;

/**
 * Pure, deterministic comparison of two InteractionSnapshots -- no Playwright/browser
 * involvement, so this is directly unit-testable. Used both by actions/click.ts (to decide
 * whether an apparently-failed/intercepted click actually succeeded, and whether a
 * destinationUrl fallback navigation produced a verified, meaningful state change) and by
 * core/loop.ts (to classify a route-memory candidate's outcome -- see requirement E).
 */
/**
 * The dialog-appeared/dialog-changed half of detectClickSideEffect below, factored out so
 * detectTargetAttributableSideEffect can reuse the exact same standards-based check on its
 * own (see that function's doc comment for why this specific signal -- unlike the weaker
 * "N new interactive elements" one -- is trusted without also requiring target-attribution).
 */
function detectDialogSideEffect(before: InteractionSnapshot, after: InteractionSnapshot): { detected: boolean; type?: ClickSideEffectType } {
  if (after.hasDialog && !before.hasDialog) {
    return { detected: true, type: "dialog_appeared" };
  }
  if (after.hasDialog && before.hasDialog && after.dialogSignature !== before.dialogSignature) {
    return { detected: true, type: "dialog_changed" };
  }
  return { detected: false };
}

export function detectClickSideEffect(params: {
  before: InteractionSnapshot;
  after: InteractionSnapshot;
}): { detected: boolean; type?: ClickSideEffectType } {
  const { before, after } = params;

  const dialogEffect = detectDialogSideEffect(before, after);
  if (dialogEffect.detected) {
    return dialogEffect;
  }

  const beforeIdentities = new Set(before.interactiveIdentities);
  const newCount = after.interactiveIdentities.filter((id) => !beforeIdentities.has(id)).length;
  if (newCount >= MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE) {
    return { detected: true, type: "interactive_surface_changed" };
  }

  return { detected: false };
}

export type ObservedSurfaceChangeType = "dialog_appeared" | "dialog_changed" | "layer_panel_appeared" | "elements_appeared" | "none";

export interface SurfaceChangeAssessment {
  type: ObservedSurfaceChangeType;
  newElementCount: number;
}

/**
 * PR 1C-a (post-click surface awareness): a second, deliberately separate classification
 * from detectClickSideEffect/detectTargetAttributableSideEffect above. Those two exist to
 * answer "did this click succeed" / "did this click's target itself produce a change" --
 * questions with real consequences (click-success reporting, route-memory progress
 * classification) that deliberately stay narrow and target-attributed to avoid the false-
 * positive class a real production incident already demonstrated (see
 * detectTargetAttributableSideEffect's own doc comment).
 *
 * classifyObservedSurfaceChange answers a different, lower-stakes question: "does the
 * observation the reasoning layer is about to see reflect a newly-appeared interactive
 * surface it should be told about" -- feeding only prompt/observation context (see
 * ActionResult.surfaceChangeDetected, RecordedAction.surfaceChangeType,
 * promptBuilder.ts) and the post-click readiness wait's own early-exit condition. A false
 * positive here costs one extra sentence of prompt context and, at most, a slightly longer
 * bounded readiness wait -- never a wrong success/progress call -- so this is deliberately
 * allowed to use the broader, non-target-attributed panelSignature heuristic
 * (scanInteractionSnapshot above) that DIALOG_SELECTOR's own doc comment explains is not
 * safe for click-success/route-progress attribution. The dialog signal itself is trusted
 * identically to detectDialogSideEffect (a standards-based, page-author-declared fact);
 * only the weaker panel/elements-count fallback below is new.
 */
export function classifyObservedSurfaceChange(before: InteractionSnapshot, after: InteractionSnapshot): SurfaceChangeAssessment {
  const beforeIdentities = new Set(before.interactiveIdentities);
  const newElementCount = after.interactiveIdentities.filter((id) => !beforeIdentities.has(id)).length;

  // detectDialogSideEffect's return type is shared with ClickSideEffectType (which also
  // includes "interactive_surface_changed"), but this specific function only ever returns
  // "dialog_appeared"/"dialog_changed" or {detected: false} -- narrowed explicitly here
  // (rather than trusting that structurally) so this stays a compile-time guarantee, not
  // just an implementation detail of detectDialogSideEffect.
  const dialogEffect = detectDialogSideEffect(before, after);
  if (dialogEffect.detected && (dialogEffect.type === "dialog_appeared" || dialogEffect.type === "dialog_changed")) {
    return { type: dialogEffect.type, newElementCount };
  }

  // A newly-appeared large panel is only trusted alongside the same
  // MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE co-occurrence guard
  // detectClickSideEffect's own weaker fallback signal already requires -- a large fixed/
  // sticky element appearing with no new controls at all (e.g. a loading spinner overlay) is
  // not evidence of a new *interactive* surface worth re-prioritising the prompt around.
  const panelAppeared = Boolean(after.panelSignature) && after.panelSignature !== before.panelSignature;
  if (panelAppeared && newElementCount >= MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE) {
    return { type: "layer_panel_appeared", newElementCount };
  }

  if (newElementCount >= MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE) {
    return { type: "elements_appeared", newElementCount };
  }

  return { type: "none", newElementCount };
}

/**
 * Target-attributable click-success fix: the target's own state, read via readElementState
 * both before and after a click, for detectTargetAttributableSideEffect below to compare.
 * Deliberately only the fields that can meaningfully change as a direct consequence of the
 * click succeeding -- never role/accessibleName/destinationUrl, which don't change as
 * evidence of a side effect.
 */
export interface TargetElementSnapshot {
  attached: boolean;
  covered: boolean;
  coveredBySignature?: string;
  ariaState?: Record<string, string>;
}

export function targetElementSnapshot(state: Pick<ElementState, "attached" | "covered" | "coveredBySignature" | "ariaState">): TargetElementSnapshot {
  return {
    attached: state.attached,
    covered: state.covered,
    ...(state.coveredBySignature ? { coveredBySignature: state.coveredBySignature } : {}),
    ...(state.ariaState ? { ariaState: state.ariaState } : {}),
  };
}

/**
 * Target-attributable click-success fix (see CLAUDE.md and docs/architecture.md "Overlay-click
 * side effect detection"): detectClickSideEffect above answers "did *something* on the page
 * change" -- for its weaker of two signals (MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE
 * new elements appearing anywhere, with no dialog markup at all), that is a whole-page,
 * target-blind comparison that a click on one control cannot be told apart from an unrelated
 * element (a cookie banner, an ad, an unrelated timer-driven widget) happening to mutate at
 * the same moment. That is precisely the false-positive class a real production incident
 * demonstrated: a click intercepted by an unrelated consent overlay was reported as
 * successful because the *overlay itself* (not the clicked control) changed state around the
 * same time.
 *
 * This function keeps detectClickSideEffect's stronger signal -- a dialog/modal appearing or
 * changing (role="dialog", aria-modal="true", or a native <dialog>) -- trusted on its own,
 * exactly as before: that markup is a standards-based fact the page's own author chose to
 * declare, not a heuristic, and very few things other than the user's own just-dispatched
 * click cause one to appear in the same bounded settle window. It is only the weaker,
 * elements-count fallback signal that now additionally requires the observed change to be
 * attributable to the clicked target specifically, using only structural/generic evidence --
 * never a selector, label, or brand/vendor-specific rule:
 *
 * 1. Target self-evidence: the target's *own* state changed in a way consistent with its
 *    click having succeeded -- an aria-expanded flip to "true" (a standards-based signal for
 *    "this control just expanded something"), the target becoming newly covered (its own
 *    click opened a surface that now sits on top of it -- exactly the "backdrop covers its own
 *    trigger" shape the original overlay-click-detection fix targeted), or the target
 *    disappearing from the DOM entirely (replaced by whatever it opened).
 * 2. A genuine dialog/modal signal (see above) -- trusted unconditionally.
 *
 * A page whose only evidence is an unrelated element's own independent change, with no
 * dialog markup and no effect on the target itself, now correctly reports detected: false.
 */
export function detectTargetAttributableSideEffect(params: {
  before: InteractionSnapshot;
  after: InteractionSnapshot;
  targetBefore: TargetElementSnapshot;
  targetAfter: TargetElementSnapshot;
}): { detected: boolean; type?: ClickSideEffectType } {
  const { before, after, targetBefore, targetAfter } = params;

  const dialogEffect = detectDialogSideEffect(before, after);
  if (dialogEffect.detected) {
    return dialogEffect;
  }

  const targetExpanded = targetAfter.ariaState?.["aria-expanded"] === "true" && targetBefore.ariaState?.["aria-expanded"] !== "true";
  if (targetExpanded) {
    return { detected: true, type: "interactive_surface_changed" };
  }

  const targetNewlyCovered = targetAfter.covered && !targetBefore.covered;
  const targetDisappeared = targetBefore.attached && !targetAfter.attached;
  if (targetNewlyCovered || targetDisappeared) {
    return { detected: true, type: "interactive_surface_changed" };
  }

  // The weaker, elements-count-only signal is only trusted when combined with target
  // self-evidence above -- an unattributed run of new elements alone (no dialog markup, no
  // effect on the target itself) is exactly the evidence class this function exists to
  // reject, so it deliberately never reaches detectClickSideEffect's elements-count branch
  // at all here.

  return { detected: false };
}

// Bounded budget for the post-click side-effect settle check (see
// waitForInteractionSideEffect below) -- mirrors this repo's existing fixed, non-configurable
// settle-delay convention (PAGE_SETTLE_DELAY_MS, core/robustNavigation.ts) rather than
// introducing a new tunable. Polling (not a single fixed sleep) so a fast-rendering overlay
// is recognised well before the budget is exhausted, while a page with no side effect at all
// still only ever costs this one bounded budget.
export const CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS = 1000;
const CLICK_SIDE_EFFECT_POLL_INTERVAL_MS = 100;

/**
 * Bounded, mutation-aware settle wait (requirement A.7: "use bounded, event- or
 * mutation-aware settling ... rather than only increasing the fixed delay globally"):
 * repeatedly re-captures the interaction snapshot and stops as soon as
 * detectClickSideEffect recognises a side effect against `before`, instead of always
 * waiting out a single fixed delay. Still bounded to CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS in
 * the worst case (nothing ever changes), so this can never become an unbounded wait.
 */
export async function waitForInteractionSideEffect(page: Page, before: InteractionSnapshot): Promise<InteractionSnapshot> {
  const deadline = Date.now() + CLICK_SIDE_EFFECT_CHECK_TIMEOUT_MS;
  let latest = await captureInteractionSnapshot(page);
  while (!detectClickSideEffect({ before, after: latest }).detected && Date.now() < deadline) {
    await page.waitForTimeout(CLICK_SIDE_EFFECT_POLL_INTERVAL_MS).catch(() => {});
    latest = await captureInteractionSnapshot(page);
  }
  return latest;
}
