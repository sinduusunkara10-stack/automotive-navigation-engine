import type { ElementHandle, Page } from "playwright";
import { DEEP_QUERY_ALL_SOURCE } from "../observation/openShadowDom.js";

/**
 * Some dealer locators confirm a choice only by showing the chosen dealer again in a separate
 * "selected" section (often with a checkmark), leaving the result list in place, with no checked
 * or ARIA state on the clicked card and no hidden input written until the site's own Submit. That
 * copy is the widget's commit: an element the click newly rendered -- visible, control-free, holding
 * the clicked result's full text, standing alone rather than as one of a re-rendered list's items.
 * Text written into an element that already existed (a "selected: ..." line, the field's value) is
 * never a commit; nor is a detail view that still asks for a choose control, or a list re-rendered
 * in place.
 */

const PRE_EXISTING_ATTR = "data-nav-engine-selected-section-pre";
const MIN_TEXT_LENGTH = 6;
const INTERACTIVE_SELECTOR =
  'button, input:not([type="hidden"]), select, textarea, a[href], [role="button"], [role="radio"], [role="option"], [role="checkbox"], [role="link"], [role="switch"]';

const MARK_SOURCE = `function (el, arg) {
  var deepAll = ${DEEP_QUERY_ALL_SOURCE};
  var text = (el.textContent || "").replace(/\\s+/g, "").toLowerCase();
  if (text.length < arg.min) return null;
  deepAll(document, "*").forEach(function (n) { n.setAttribute(arg.attr, ""); });
  return text;
}`;

const FIND_SOURCE = `function (arg) {
  var deepAll = ${DEEP_QUERY_ALL_SOURCE};
  var norm = function (n) { return (n.textContent || "").replace(/\\s+/g, "").toLowerCase(); };
  var holders = deepAll(document, "*").filter(function (n) {
    if (n.hasAttribute(arg.attr) || /^(SCRIPT|STYLE|TEMPLATE|HTML|BODY)$/.test(n.tagName)) return false;
    var t = norm(n);
    return t.length <= arg.text.length * 2 + 40 && t.indexOf(arg.text) !== -1;
  });
  var deepest = holders.filter(function (n) {
    return !holders.some(function (o) { return o !== n && n.contains(o); });
  });
  return deepest.some(function (n) {
    var r = n.getBoundingClientRect();
    var s = getComputedStyle(n);
    if (r.width <= 1 || r.height <= 1 || s.visibility === "hidden" || s.display === "none") return false;
    if (n.matches(arg.interactive) || n.querySelector(arg.interactive)) return false;
    var parent = n.parentElement;
    var similar = parent ? Array.prototype.filter.call(parent.children, function (c) {
      return c !== n && c.tagName === n.tagName && c.className === n.className;
    }).length : 0;
    return similar === 0;
  });
}`;

type Installed = Record<string, ((...args: unknown[]) => unknown) | undefined>;

/** Marks every element that exists before the click; returns the result's text, or null when too short to match on. */
export async function baselineSelectedSection(result: ElementHandle<SVGElement | HTMLElement>): Promise<string | null> {
  try {
    const frame = await result.ownerFrame();
    if (!frame) return null;
    await frame.evaluate(`window.__navEngineSelectedSectionMark = ${MARK_SOURCE}; true`);
    return (await result.evaluate(
      (el, arg) => (window as unknown as Installed).__navEngineSelectedSectionMark?.(el, arg) ?? null,
      { attr: PRE_EXISTING_ATTR, min: MIN_TEXT_LENGTH },
    )) as string | null;
  } catch {
    return null;
  }
}

/** True when a new, standalone, control-free element now repeats the clicked result's text. */
export async function selectedSectionShowsResult(page: Page, resultText: string | null): Promise<boolean> {
  if (!resultText) return false;
  try {
    await page.evaluate(`window.__navEngineSelectedSectionFind = ${FIND_SOURCE}; true`);
    return (await page.evaluate(
      (arg) => (window as unknown as Installed).__navEngineSelectedSectionFind?.(arg) === true,
      { attr: PRE_EXISTING_ATTR, text: resultText, interactive: INTERACTIVE_SELECTOR },
    )) as boolean;
  } catch {
    return false;
  }
}
