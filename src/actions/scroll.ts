import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";
import { DIALOG_SELECTOR } from "../observation/observationBuilder.js";

/**
 * Modal-aware scroll target detection (see CLAUDE.md and docs/architecture.md "Modal-aware
 * observation"): finds the first visible, genuinely scrollable dialog/modal surface (see
 * DIALOG_SELECTOR), so a scroll issued while a modal is open moves *inside* the modal
 * rather than the page underneath it (which, behind a modal, is frequently non-scrollable
 * anyway -- many sites set overflow:hidden on the body while a modal is open). Returns the
 * viewport-relative centre point to move the mouse to before wheeling, or undefined when no
 * such surface exists (the ordinary case), in which case scrolling behaves exactly as
 * before this fix. Never a site-specific selector -- purely the same two standards-based
 * ARIA signals plus native <dialog> used throughout this fix.
 */
function findScrollableDialogCenter(selector: string): { x: number; y: number } | undefined {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const visible = rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    if (!visible) {
      continue;
    }
    const scrollable = el.scrollHeight > el.clientHeight + 1;
    if (!scrollable) {
      continue;
    }
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight) {
      return { x: cx, y: cy };
    }
  }
  return undefined;
}

export async function executeScroll(page: Page, action: SelectedAction): Promise<ActionResult> {
  const deltaY = typeof action.params?.deltaY === "number" ? action.params.deltaY : 400;
  try {
    const dialogScrollPoint = await page.evaluate(findScrollableDialogCenter, DIALOG_SELECTOR).catch(() => undefined);
    if (dialogScrollPoint) {
      // Position the mouse over the modal before wheeling -- page.mouse.wheel dispatches
      // at the current cursor position, which otherwise defaults to wherever it was last
      // left (commonly (0, 0), over the background page). Otherwise, retain the existing
      // document-scrolling behaviour exactly (no mouse move at all).
      await page.mouse.move(dialogScrollPoint.x, dialogScrollPoint.y);
    }
    await page.mouse.wheel(0, deltaY);
    return { success: true, resultingUrl: page.url() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
