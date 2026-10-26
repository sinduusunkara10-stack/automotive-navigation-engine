import type { Locator, Page } from "playwright";
import { callInPageFunction } from "./inPageFunction.js";
import { DEEP_QUERY_ALL_SOURCE } from "../observation/openShadowDom.js";

export type SelectProxyKind = "readonly_input" | "combobox" | "button";

export type ProxiedSelectActivationMethod = "proxy_option_click" | "native_change_event" | "not_committed";

/**
 * Outcome of committing a required native <select> that the page hides behind a visible custom
 * control. Never carries an option value or label: only which surface was used and what read back.
 */
export interface ProxiedSelectOutcome {
  fieldId: string;
  purpose: string;
  proxyKind: SelectProxyKind;
  activationMethod: ProxiedSelectActivationMethod;
  attemptedMethods: ("proxy_option_click" | "native_change_event")[];
  nativeValueCommitted: boolean;
  /** Whether the visible control now shows the chosen option; null when it exposes no readable display. */
  proxyReflectsSelection: boolean | null;
}

export const PROXY_ATTR_SUFFIX = "-proxy-for";
const OPTION_MARK_ATTR = "data-nav-engine-proxy-option";
const BASELINE_MARK_ATTR = "data-nav-engine-proxy-baseline";
const COMMIT_POLL_MS = 1_000;
const OPTION_WAIT_MS = 1_500;

/**
 * Marks every visible element whose own text equals the option label. Called once before the proxy
 * is opened (baseline) and once after: only an element that was not already showing that text
 * counts as the opened list's option, so an unrelated element elsewhere on the page with the same
 * short text is never clicked.
 */
const MARK_OPTION_SOURCE = `(el, arg) => {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ").trim();
  const wanted = norm(arg.label);
  if (!wanted) return false;
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    const s = window.getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const matches = (${DEEP_QUERY_ALL_SOURCE})(document, '[role="option"], li, a, span, div, label, button, p').filter((n) => {
    if (n.closest("select")) return false;
    if (norm(n.textContent) !== wanted) return false;
    return !Array.from(n.children).some((c) => norm(c.textContent) === wanted);
  });
  if (arg.baseline) {
    (${DEEP_QUERY_ALL_SOURCE})(document, "[" + arg.baselineAttr + "]").forEach((n) => n.removeAttribute(arg.baselineAttr));
    matches.filter(shown).forEach((n) => n.setAttribute(arg.baselineAttr, "1"));
    return true;
  }
  (${DEEP_QUERY_ALL_SOURCE})(document, "[" + arg.optionAttr + "]").forEach((n) => n.removeAttribute(arg.optionAttr));
  const fresh = matches.filter((n) => shown(n) && !n.hasAttribute(arg.baselineAttr));
  const preferred = fresh.find((n) => n.getAttribute("role") === "option") || fresh[0];
  if (!preferred) return false;
  preferred.setAttribute(arg.optionAttr, "1");
  return true;
}`;

const SET_NATIVE_SOURCE = `(el, arg) => {
  el.value = arg.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}`;

const PROXY_DISPLAY_SOURCE = `(el, arg) => {
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "").replace(/\\s+/g, " ").trim();
  const shown = norm(el.value !== undefined && el.tagName !== "BUTTON" ? el.value : el.textContent);
  if (!shown) return null;
  return shown.includes(norm(arg.label));
}`;

async function readNative(select: Locator): Promise<string | undefined> {
  return select.inputValue({ timeout: 2_000 }).catch(() => undefined);
}

async function pollCommitted(page: Page, select: Locator, value: string): Promise<boolean> {
  const deadline = Date.now() + COMMIT_POLL_MS;
  for (;;) {
    if ((await readNative(select)) === value) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(100);
  }
}

/**
 * Commits a required hidden native <select> through the control the visitor actually sees: open the
 * proxy and click the option that newly appears with the chosen label, then require the native
 * select itself to read back the chosen value. When the custom list cannot be operated, the native
 * select gets the value with the same input/change events a browser fires for a real choice -- the
 * events the widget's own sync listens to. The result is never reported as filled unless the native
 * value read back.
 */
export async function commitProxiedSelect(
  page: Page,
  select: Locator,
  proxy: Locator,
  target: { value: string; label: string },
  meta: { fieldId: string; purpose: string; proxyKind: SelectProxyKind },
): Promise<ProxiedSelectOutcome> {
  const attemptedMethods: ProxiedSelectOutcome["attemptedMethods"] = [];
  let activationMethod: ProxiedSelectActivationMethod = "not_committed";
  let committed = (await readNative(select)) === target.value;

  if (!committed && target.label.trim().length > 0) {
    attemptedMethods.push("proxy_option_click");
    const markArg = { label: target.label, optionAttr: OPTION_MARK_ATTR, baselineAttr: BASELINE_MARK_ATTR };
    await callInPageFunction(proxy, "__navEngineMarkProxyOption", MARK_OPTION_SOURCE, { ...markArg, baseline: true }).catch(() => false);
    const opened = await proxy
      .click({ timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      const deadline = Date.now() + OPTION_WAIT_MS;
      let found = false;
      while (!found && Date.now() < deadline) {
        found = await callInPageFunction<boolean>(proxy, "__navEngineMarkProxyOption", MARK_OPTION_SOURCE, { ...markArg, baseline: false }).catch(() => false);
        if (!found) await page.waitForTimeout(100);
      }
      if (found) {
        await page
          .locator(`[${OPTION_MARK_ATTR}]`)
          .first()
          .click({ timeout: 3_000 })
          .catch(() => {});
        committed = await pollCommitted(page, select, target.value);
        if (committed) activationMethod = "proxy_option_click";
      }
      if (!committed) await page.keyboard.press("Escape").catch(() => {});
    }
  }

  if (!committed) {
    attemptedMethods.push("native_change_event");
    await callInPageFunction(select, "__navEngineSetNativeSelect", SET_NATIVE_SOURCE, { value: target.value }).catch(() => undefined);
    committed = await pollCommitted(page, select, target.value);
    if (committed) activationMethod = "native_change_event";
  }

  const proxyReflectsSelection = committed
    ? await callInPageFunction<boolean | null>(proxy, "__navEngineProxyDisplay", PROXY_DISPLAY_SOURCE, { label: target.label }).catch(() => null)
    : false;

  return {
    fieldId: meta.fieldId,
    purpose: meta.purpose,
    proxyKind: meta.proxyKind,
    activationMethod,
    attemptedMethods,
    nativeValueCommitted: committed,
    proxyReflectsSelection,
  };
}
