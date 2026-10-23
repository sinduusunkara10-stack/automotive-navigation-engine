import type { Frame, Page } from "playwright";

/**
 * Read-only evidence of whether fillable form controls exist anywhere a lead-form fill could reach,
 * and if not, why not: absent, not rendered yet, hidden, inside a child frame, inside open shadow
 * DOM, or present without a semantic <form>. Counts only -- never a field's value, label, name or
 * id. Never clicks, focuses, scrolls or writes into the page. Gated by FORM_DISCOVERY_DIAGNOSTIC=1
 * at every call site.
 */
export interface FormPresenceCounts {
  formElements: number;
  fillableControls: number;
  fillableVisible: number;
  fillableHiddenByStyle: number;
  fillableZeroSize: number;
  fillableDisabled: number;
  fillableVisibleOutsideAnyForm: number;
  openShadowHosts: number;
  formsInOpenShadowDom: number;
  fillableInOpenShadowDom: number;
  iframeElements: number;
  /** Custom elements (hyphenated tags) whose definition was never registered -- a component that has not upgraded/hydrated. */
  undefinedCustomElements: number;
  ariaBusyElements: number;
  progressIndicators: number;
  /** A fixed/absolute element at the viewport centre covering most of the viewport (a dialog, gate or loading curtain). */
  viewportCoveredByOverlay: boolean;
  bodyTextLength: number;
}

export interface FormPresenceDocumentProbe extends FormPresenceCounts {
  readyState: string;
  msSinceNavigationStart: number;
  domContentLoadedAtMs: number | null;
  loadEventAtMs: number | null;
}

export interface FormPresenceFrameProbe {
  frameIndex: number;
  /** Origin only, never a path or query. */
  origin: string;
  accessible: boolean;
  counts: FormPresenceCounts | null;
}

export type FormPresenceClassification =
  | "semantic_form_with_fields"
  | "fields_without_semantic_form"
  | "form_without_fillable_fields"
  | "fields_only_hidden"
  | "fields_in_child_frame"
  | "fields_in_open_shadow_dom"
  | "inaccessible_child_frame"
  | "no_fields_detected";

export interface FormPresenceProbe {
  capturedAt: string;
  main: FormPresenceDocumentProbe | null;
  frames: FormPresenceFrameProbe[];
  framesTruncated: boolean;
  classification: FormPresenceClassification;
}

export interface FormLateRenderObservation {
  watchedMs: number;
  /** Milliseconds after the watch started; null when not seen within it. */
  formElementAppearedAtMs: number | null;
  visibleFillableAppearedAtMs: number | null;
  finalProbe: FormPresenceProbe;
}

export const FORM_PRESENCE_MAX_FRAMES = 8;
export const FORM_LATE_RENDER_OBSERVATION_MS = 15_000;
const FORM_LATE_RENDER_POLL_MS = 500;

// String source: compiled callbacks passed to evaluate() carry esbuild's __name helper, which does
// not exist in the page (see forms/inPageFunction.ts).
const PROBE_SOURCE = `() => {
  const FILLABLE = 'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]):not([type="reset"]), select, textarea, [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const counts = {
    formElements: document.querySelectorAll("form").length,
    fillableControls: 0,
    fillableVisible: 0,
    fillableHiddenByStyle: 0,
    fillableZeroSize: 0,
    fillableDisabled: 0,
    fillableVisibleOutsideAnyForm: 0,
    openShadowHosts: 0,
    formsInOpenShadowDom: 0,
    fillableInOpenShadowDom: 0,
    iframeElements: document.querySelectorAll("iframe, frame").length,
    undefinedCustomElements: 0,
    ariaBusyElements: document.querySelectorAll('[aria-busy="true"]').length,
    progressIndicators: document.querySelectorAll('[role="progressbar"], progress').length,
    viewportCoveredByOverlay: false,
    bodyTextLength: (document.body && document.body.innerText ? document.body.innerText.length : 0),
  };
  for (const el of document.querySelectorAll(FILLABLE)) {
    counts.fillableControls += 1;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const hiddenByStyle =
      typeof el.checkVisibility === "function"
        ? !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
        : style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
    const zeroSize = rect.width === 0 || rect.height === 0;
    if (hiddenByStyle) counts.fillableHiddenByStyle += 1;
    else if (zeroSize) counts.fillableZeroSize += 1;
    else {
      counts.fillableVisible += 1;
      if (!el.closest("form") && !el.getAttribute("form")) counts.fillableVisibleOutsideAnyForm += 1;
    }
    if (el.disabled === true || el.getAttribute("aria-disabled") === "true") counts.fillableDisabled += 1;
  }
  const roots = [];
  for (const el of document.querySelectorAll("*")) {
    if (el.shadowRoot) roots.push(el.shadowRoot);
    const tag = el.tagName.toLowerCase();
    if (tag.includes("-") && typeof customElements !== "undefined" && !customElements.get(tag)) counts.undefinedCustomElements += 1;
  }
  let scanned = 0;
  while (roots.length > 0 && scanned < 200) {
    const root = roots.shift();
    scanned += 1;
    counts.openShadowHosts += 1;
    counts.formsInOpenShadowDom += root.querySelectorAll("form").length;
    counts.fillableInOpenShadowDom += root.querySelectorAll(FILLABLE).length;
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
    }
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let node = vw > 0 && vh > 0 ? document.elementFromPoint(vw / 2, vh / 2) : null;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = getComputedStyle(node);
    if (style.position === "fixed" || style.position === "absolute") {
      const r = node.getBoundingClientRect();
      const visibleWidth = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visibleHeight = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      if (visibleWidth * visibleHeight >= 0.6 * vw * vh) {
        counts.viewportCoveredByOverlay = true;
        break;
      }
    }
    node = node.parentElement;
  }
  const nav = performance.getEntriesByType ? performance.getEntriesByType("navigation")[0] : undefined;
  return {
    counts,
    readyState: document.readyState,
    msSinceNavigationStart: Math.round(performance.now()),
    domContentLoadedAtMs: nav && nav.domContentLoadedEventEnd > 0 ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadEventAtMs: nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null,
  };
}`;

interface RawProbe {
  counts: FormPresenceCounts;
  readyState: string;
  msSinceNavigationStart: number;
  domContentLoadedAtMs: number | null;
  loadEventAtMs: number | null;
}

async function readDocument(frame: Frame): Promise<RawProbe | null> {
  return (frame.evaluate(`(${PROBE_SOURCE})()`) as Promise<RawProbe>).catch(() => null);
}

function originOf(frame: Frame): string {
  try {
    return new URL(frame.url()).origin;
  } catch {
    return "unknown";
  }
}

export function classifyFormPresence(main: FormPresenceCounts | null, frames: FormPresenceFrameProbe[]): FormPresenceClassification {
  if (main) {
    if (main.formElements > 0 && main.fillableVisible > main.fillableVisibleOutsideAnyForm) return "semantic_form_with_fields";
    if (main.fillableVisible > 0) return "fields_without_semantic_form";
  }
  if (frames.some((f) => (f.counts?.fillableVisible ?? 0) > 0)) return "fields_in_child_frame";
  if (main && main.fillableInOpenShadowDom > 0) return "fields_in_open_shadow_dom";
  if (main && main.fillableControls > 0) return "fields_only_hidden";
  if (main && main.formElements > 0) return "form_without_fillable_fields";
  if (frames.some((f) => !f.accessible)) return "inaccessible_child_frame";
  return "no_fields_detected";
}

export async function probeFormPresence(page: Page): Promise<FormPresenceProbe> {
  const mainFrame = page.mainFrame();
  const raw = await readDocument(mainFrame);
  const childFrames = page.frames().filter((f) => f !== mainFrame);
  const frames: FormPresenceFrameProbe[] = [];
  for (let i = 0; i < Math.min(childFrames.length, FORM_PRESENCE_MAX_FRAMES); i += 1) {
    const frame = childFrames[i]!;
    const frameRaw = await readDocument(frame);
    frames.push({ frameIndex: i, origin: originOf(frame), accessible: frameRaw !== null, counts: frameRaw?.counts ?? null });
  }
  const main: FormPresenceDocumentProbe | null = raw
    ? {
        ...raw.counts,
        readyState: raw.readyState,
        msSinceNavigationStart: raw.msSinceNavigationStart,
        domContentLoadedAtMs: raw.domContentLoadedAtMs,
        loadEventAtMs: raw.loadEventAtMs,
      }
    : null;
  return {
    capturedAt: new Date().toISOString(),
    main,
    frames,
    framesTruncated: childFrames.length > FORM_PRESENCE_MAX_FRAMES,
    classification: classifyFormPresence(main, frames),
  };
}

/**
 * Passive watch after form discovery found nothing: re-probes until a <form> or a visible fillable
 * control appears anywhere the probe can see, or the window ends. Answers "would the fields have
 * rendered later?" without the fill using them -- the action's own result is decided before this runs.
 */
export async function observeLateFormRender(page: Page, maxMs: number = FORM_LATE_RENDER_OBSERVATION_MS): Promise<FormLateRenderObservation> {
  const startedAt = Date.now();
  let formElementAppearedAtMs: number | null = null;
  let visibleFillableAppearedAtMs: number | null = null;
  let probe = await probeFormPresence(page);
  for (;;) {
    const elapsed = Date.now() - startedAt;
    const formSeen = (probe.main?.formElements ?? 0) + (probe.main?.formsInOpenShadowDom ?? 0) + probe.frames.reduce((n, f) => n + (f.counts?.formElements ?? 0), 0) > 0;
    const fillableSeen = (probe.main?.fillableVisible ?? 0) + (probe.main?.fillableInOpenShadowDom ?? 0) + probe.frames.reduce((n, f) => n + (f.counts?.fillableVisible ?? 0), 0) > 0;
    if (formSeen && formElementAppearedAtMs === null) formElementAppearedAtMs = elapsed;
    if (fillableSeen && visibleFillableAppearedAtMs === null) visibleFillableAppearedAtMs = elapsed;
    if ((formElementAppearedAtMs !== null && visibleFillableAppearedAtMs !== null) || elapsed >= maxMs || page.isClosed()) break;
    await page.waitForTimeout(Math.min(FORM_LATE_RENDER_POLL_MS, Math.max(0, maxMs - elapsed))).catch(() => undefined);
    if (page.isClosed()) break;
    probe = await probeFormPresence(page);
  }
  return { watchedMs: Date.now() - startedAt, formElementAppearedAtMs, visibleFillableAppearedAtMs, finalProbe: probe };
}
