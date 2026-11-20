import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type {
  ActionExecutorResult,
  ScrollContainerSelectionSource,
  ScrollDiagnostics,
  ScrollMovementFailureReason,
  ScrollRectSnapshot,
} from "../types/task-response.js";
import { DIALOG_SELECTOR, elementLocatorSelector } from "../observation/observationBuilder.js";
import { resolveElementFrame } from "../observation/frames.js";

const DEFAULT_DELTA_Y = 400;
const MIN_MOVEMENT_PX = 1;
const POLL_INTERVAL_MS = 50;
const MAX_SETTLE_MS = 800;
const BOUNDARY_SETTLE_MS = 250;
const CONTAINER_ATTR = "data-nav-engine-scroll-container";

interface ScrollerState {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

interface PageScrollState {
  win: { scrollY: number; documentTop: number; bodyTop: number; scrollHeight: number; clientHeight: number };
  container: ScrollerState | null;
  target: { rect: ScrollRectSnapshot; viewportVisible: boolean } | null;
}

interface ScrollSelection {
  source: ScrollContainerSelectionSource;
  type: "window" | "scrollable_container";
  label?: string;
  point: { x: number; y: number } | null;
  state: PageScrollState;
}

interface PageScrollArgs {
  op: "select" | "read";
  targetSelector?: string;
  deltaY: number;
  dialogSelector: string;
  containerAttr: string;
  cleanup?: boolean;
}

/**
 * Runs inside the page, as a source string: tsx/esbuild wraps nested named bindings of a compiled
 * callback in a __name(...) helper that does not exist in the page (see forms/inPageFunction.ts).
 * One function for both operations so scroller discovery and measurement share the same
 * definitions. "select" picks the scroller deterministically and marks it with a temporary
 * attribute; "read" measures the window, the marked container and the target. Viewport visibility
 * is deliberately separate from DOM visibility: it needs a DOM-visible box that also meaningfully
 * intersects the viewport and every clipping ancestor.
 */
const PAGE_SCROLL_SOURCE = `(args) => {
  const deltaY = args.deltaY;
  const dialogSelector = args.dialogSelector;
  const containerAttr = args.containerAttr;
  const targetSelector = args.targetSelector;
  const markedSelector = "[" + containerAttr + "]";

  const isScrollableY = (el) => {
    const overflowY = getComputedStyle(el).overflowY;
    return (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && el.scrollHeight - el.clientHeight > 1;
  };
  const canMove = (el) => (deltaY < 0 ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1);
  const domVisible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const parentOf = (el) => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const nearestScrollableAncestor = (start) => {
    let firstScrollable = null;
    let node = parentOf(start);
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollableY(node)) {
        if (canMove(node)) return node;
        if (!firstScrollable) firstScrollable = node;
      }
      node = parentOf(node);
    }
    return firstScrollable;
  };
  const labelOf = (el) => {
    const role = el.getAttribute("role");
    return role ? el.tagName.toLowerCase() + "[role=" + role + "]" : el.tagName.toLowerCase();
  };
  const viewportVisible = (el) => {
    if (!domVisible(el)) return false;
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0);
    let top = Math.max(r.top, 0);
    let right = Math.min(r.right, window.innerWidth);
    let bottom = Math.min(r.bottom, window.innerHeight);
    let node = parentOf(el);
    while (node && node !== document.body && node !== document.documentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX !== "visible" || style.overflowY !== "visible") {
        const c = node.getBoundingClientRect();
        left = Math.max(left, c.left);
        top = Math.max(top, c.top);
        right = Math.min(right, c.right);
        bottom = Math.min(bottom, c.bottom);
      }
      node = parentOf(node);
    }
    if (right <= left || bottom <= top) return false;
    const intersection = (right - left) * (bottom - top);
    return intersection >= 0.25 * r.width * r.height || intersection >= 0.5 * window.innerWidth * window.innerHeight;
  };

  const readState = () => {
    const scrollingElement = document.scrollingElement || document.documentElement;
    const marked = document.querySelector(markedSelector);
    const targetEl = targetSelector ? document.querySelector(targetSelector) : null;
    let target = null;
    if (targetEl) {
      const r = targetEl.getBoundingClientRect();
      target = { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, viewportVisible: viewportVisible(targetEl) };
    }
    return {
      win: {
        scrollY: window.scrollY,
        documentTop: document.documentElement.scrollTop,
        bodyTop: document.body ? document.body.scrollTop : 0,
        scrollHeight: scrollingElement.scrollHeight,
        clientHeight: window.innerHeight,
      },
      container: marked ? { scrollTop: marked.scrollTop, scrollHeight: marked.scrollHeight, clientHeight: marked.clientHeight } : null,
      target,
    };
  };
  const clearMarks = () => document.querySelectorAll(markedSelector).forEach((el) => el.removeAttribute(containerAttr));

  if (args.op === "read") {
    const state = readState();
    if (args.cleanup) clearMarks();
    return state;
  }

  clearMarks();
  let container = null;
  let source = "document_fallback";

  const targetEl = targetSelector ? document.querySelector(targetSelector) : null;
  if (targetEl) {
    container = nearestScrollableAncestor(targetEl);
    if (container) source = "target_ancestor";
  } else {
    for (const dialog of Array.from(document.querySelectorAll(dialogSelector))) {
      if (!domVisible(dialog)) continue;
      const rect = dialog.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) continue;
      if (isScrollableY(dialog)) {
        container = dialog;
      } else {
        container = Array.from(dialog.querySelectorAll("*")).slice(0, 500).find((el) => domVisible(el) && isScrollableY(el)) || null;
      }
      if (container) break;
    }
    if (!container) {
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) {
        const candidate = isScrollableY(active) && domVisible(active) ? active : nearestScrollableAncestor(active);
        if (candidate && domVisible(candidate)) container = candidate;
      }
    }
    if (container) source = "active_region";
  }

  let point = null;
  if (container) {
    container.setAttribute(containerAttr, "1");
    const r = container.getBoundingClientRect();
    const left = Math.max(r.left, 0);
    const top = Math.max(r.top, 0);
    const right = Math.min(r.right, window.innerWidth);
    const bottom = Math.min(r.bottom, window.innerHeight);
    if (right > left && bottom > top) {
      const probes = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5]];
      for (const probe of probes) {
        const x = left + (right - left) * probe[0];
        const y = top + (bottom - top) * probe[1];
        const hit = document.elementFromPoint(x, y);
        if (hit && (hit === container || container.contains(hit))) {
          point = { x: x, y: y };
          break;
        }
      }
    }
  }

  const result = { source: source, type: container ? "scrollable_container" : "window", point: point, state: readState() };
  if (container) result.label = labelOf(container);
  return result;
}`;

const evaluatePageScroll = <T>(page: Page, args: PageScrollArgs): Promise<T> =>
  page.evaluate(`(${PAGE_SCROLL_SOURCE})(${JSON.stringify(args)})`) as Promise<T>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function positionOf(state: PageScrollState, type: "window" | "scrollable_container"): ScrollerState {
  if (type === "scrollable_container" && state.container) return state.container;
  return { scrollTop: state.win.scrollY, scrollHeight: state.win.scrollHeight, clientHeight: state.win.clientHeight };
}

function windowDelta(before: PageScrollState, after: PageScrollState): number {
  const deltas = [
    after.win.scrollY - before.win.scrollY,
    after.win.documentTop - before.win.documentTop,
    after.win.bodyTop - before.win.bodyTop,
  ];
  return deltas.reduce((best, d) => (Math.abs(d) > Math.abs(best) ? d : best), 0);
}

function observedDelta(before: PageScrollState, after: PageScrollState, type: "window" | "scrollable_container"): number {
  if (type === "scrollable_container" && before.container && after.container) {
    return after.container.scrollTop - before.container.scrollTop;
  }
  return windowDelta(before, after);
}

const atTop = (s: ScrollerState): boolean => s.scrollTop <= 0;
const atBottom = (s: ScrollerState): boolean => s.scrollTop + s.clientHeight >= s.scrollHeight - 1;
const isScrollable = (s: ScrollerState): boolean => s.scrollHeight - s.clientHeight > 1;

export function buildScrollDiagnostics(params: {
  deltaY: number;
  selection: Pick<ScrollSelection, "source" | "type" | "label">;
  dispatchMethod: ScrollDiagnostics["dispatchMethod"];
  before: PageScrollState;
  after: PageScrollState;
}): ScrollDiagnostics {
  const { deltaY, selection, dispatchMethod, before, after } = params;
  const type = selection.type;
  const posBefore = positionOf(before, type);
  const posAfter = positionOf(after, type);
  const delta = observedDelta(before, after, type);

  const rectMoved =
    before.target && after.target
      ? Math.abs(after.target.rect.top - before.target.rect.top) >= MIN_MOVEMENT_PX ||
        Math.abs(after.target.rect.left - before.target.rect.left) >= MIN_MOVEMENT_PX
      : false;
  const becameVisible = Boolean(before.target && after.target && !before.target.viewportVisible && after.target.viewportVisible);
  const movementVerified = Math.abs(delta) >= MIN_MOVEMENT_PX || rectMoved || becameVisible;

  let movementFailureReason: ScrollMovementFailureReason | undefined;
  if (!movementVerified) {
    if (deltaY === 0) movementFailureReason = "zero_delta";
    else if (!isScrollable(posBefore)) movementFailureReason = "not_scrollable";
    else if (deltaY > 0 && atBottom(posBefore)) movementFailureReason = "at_bottom_boundary";
    else if (deltaY < 0 && atTop(posBefore)) movementFailureReason = "at_top_boundary";
    else if (Math.abs(delta) > 0) movementFailureReason = "sub_threshold_movement";
    else movementFailureReason = "no_position_change";
  }

  return {
    requestedDeltaY: deltaY,
    containerSelectionSource: selection.source,
    scrollTargetType: type,
    ...(selection.label ? { containerLabel: selection.label } : {}),
    dispatchMethod,
    beforeScrollTop: posBefore.scrollTop,
    afterScrollTop: posAfter.scrollTop,
    scrollDeltaObserved: delta,
    scrollHeight: posAfter.scrollHeight,
    clientHeight: posAfter.clientHeight,
    atTopBefore: atTop(posBefore),
    atBottomBefore: atBottom(posBefore),
    atTopAfter: atTop(posAfter),
    atBottomAfter: atBottom(posAfter),
    windowScrollY: { before: before.win.scrollY, after: after.win.scrollY },
    documentElementScrollTop: { before: before.win.documentTop, after: after.win.documentTop },
    bodyScrollTop: { before: before.win.bodyTop, after: after.win.bodyTop },
    ...(before.target ? { targetBoundingRectBefore: before.target.rect, targetViewportVisibleBefore: before.target.viewportVisible } : {}),
    ...(after.target ? { targetBoundingRectAfter: after.target.rect, targetViewportVisibleAfter: after.target.viewportVisible } : {}),
    movementVerified,
    ...(movementFailureReason ? { movementFailureReason } : {}),
  };
}

function stateSignature(state: PageScrollState): string {
  return [state.win.scrollY, state.win.documentTop, state.win.bodyTop, state.container?.scrollTop ?? "", state.target?.rect.top ?? ""].join("|");
}

async function resolveTargetSelector(page: Page, target: string | undefined): Promise<string | undefined> {
  if (!target) return undefined;
  const resolution = await resolveElementFrame(page, target).catch(() => undefined);
  // Frame-scoped targets live in another document; the main document's scrollers are not theirs.
  if (!resolution || resolution.status !== "main_frame") return undefined;
  return elementLocatorSelector(target);
}

/**
 * Container-aware scrolling. Reasoning picks "scroll"; this picks the scroller
 * deterministically (nearest scrollable ancestor of the target when one is named, else the
 * active interaction region -- an open scrollable dialog or the focused element's scroller --
 * else the window), positions the pointer inside a container before wheeling, then measures
 * before/after scroll positions so success is evidence, not an assumption. Never a
 * site-specific selector.
 */
export async function executeScroll(page: Page, action: SelectedAction): Promise<ActionExecutorResult> {
  const deltaY = typeof action.params?.deltaY === "number" ? action.params.deltaY : DEFAULT_DELTA_Y;
  try {
    const targetSelector = await resolveTargetSelector(page, action.target);
    const baseArgs = { deltaY, dialogSelector: DIALOG_SELECTOR, containerAttr: CONTAINER_ATTR, ...(targetSelector ? { targetSelector } : {}) };

    const selection = await evaluatePageScroll<ScrollSelection>(page, { ...baseArgs, op: "select" });
    const before = selection.state;

    let dispatchMethod: ScrollDiagnostics["dispatchMethod"] = "mouse_wheel";
    if (selection.type === "scrollable_container" && !selection.point) {
      dispatchMethod = "programmatic";
      await page.evaluate(
        ({ attr, dy }) => {
          document.querySelector<HTMLElement>(`[${attr}]`)?.scrollBy({ top: dy, behavior: "instant" });
        },
        { attr: CONTAINER_ATTR, dy: deltaY },
      );
    } else {
      if (selection.point) {
        await page.mouse.move(selection.point.x, selection.point.y);
      }
      await page.mouse.wheel(0, deltaY);
    }

    const posBefore = positionOf(before, selection.type);
    const boundaryOrInert = !isScrollable(posBefore) || (deltaY > 0 ? atBottom(posBefore) : deltaY < 0 ? atTop(posBefore) : true);
    const maxWait = boundaryOrInert ? BOUNDARY_SETTLE_MS : MAX_SETTLE_MS;
    const startSignature = stateSignature(before);
    let after = before;
    let previousSignature: string | undefined;
    for (let waited = 0; waited < maxWait; waited += POLL_INTERVAL_MS) {
      await sleep(POLL_INTERVAL_MS);
      after = await evaluatePageScroll<PageScrollState>(page, { ...baseArgs, op: "read" });
      const signature = stateSignature(after);
      if (signature !== startSignature && signature === previousSignature) break;
      previousSignature = signature;
    }
    after = await evaluatePageScroll<PageScrollState>(page, { ...baseArgs, op: "read", cleanup: true });

    const scrollDiagnostics = buildScrollDiagnostics({ deltaY, selection, dispatchMethod, before, after });
    return { success: true, resultingUrl: page.url(), scrollDiagnostics };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
