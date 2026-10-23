import type { Locator, Page } from "playwright";
import { callInPageFunction } from "../forms/inPageFunction.js";

/**
 * Read-only record of the lookup controls (buttons and button-like inputs) around a dealer/location
 * field as a lookup progresses: whether each is rendered, on screen and enabled, and whether this
 * engine clicked it. It answers "did a search/OK/confirm control become usable after typing, and
 * was it used?" without ever clicking, focusing or mutating anything. Never a control's text --
 * only its length and whether it matches the generic lookup or geolocation vocabulary.
 */
export interface LookupControlState {
  /** Stable per page for this run (assigned in page memory, never written into the DOM). */
  controlId: number;
  triggerIndex: string | null;
  tag: string;
  inputType: string | null;
  rendered: boolean;
  onScreen: boolean;
  enabled: boolean;
  textLength: number;
  lookupVocabulary: boolean;
  geolocationVocabulary: boolean;
  clickedByEngine: boolean;
}

export interface LookupControlTimelineEntry {
  /** On the dealer-lookup network evidence clock. */
  atMs: number;
  phase: string;
  loadingIndicatorVisible: boolean;
  controls: LookupControlState[];
}

export interface LookupControlTimeline {
  entries: LookupControlTimelineEntry[];
  truncated: boolean;
  /** Controls that were not usable (rendered, on screen and enabled) at the first sample but became usable later. */
  controlsBecameActionable: { controlId: number; atMs: number; phase: string; clickedByEngine: boolean; lookupVocabulary: boolean; geolocationVocabulary: boolean }[];
  /** Controls rendered and on screen but disabled at the last sample. */
  controlsDisabledAtEnd: number[];
}

export interface LookupControlTimelineRecorder {
  sample(phase: string): Promise<void>;
  result(): LookupControlTimeline;
}

interface RawControl {
  controlId: number;
  triggerIndex: string | null;
  tag: string;
  inputType: string | null;
  rendered: boolean;
  onScreen: boolean;
  enabled: boolean;
  text: string;
  attributeText: string;
  clickedByEngine: boolean;
}

export const MAX_TIMELINE_ENTRIES = 20;
export const MAX_TIMELINE_CONTROLS = 8;

// String source: see inPageFunction.ts. Element identity lives in a page-side WeakMap so sampling
// never writes into the DOM (which the lookup probe's mutation counter would otherwise see).
const READ_CONTROLS_SOURCE = `(scopeEl, args) => {
  const w = window;
  if (!w.__navEngineControlIds) w.__navEngineControlIds = new WeakMap();
  if (!w.__navEngineControlNext) w.__navEngineControlNext = 1;
  const ids = w.__navEngineControlIds;
  const idFor = (el) => {
    let id = ids.get(el);
    if (id === undefined) {
      id = w.__navEngineControlNext++;
      ids.set(el, id);
    }
    return id;
  };
  const seen = new Set();
  const candidates = [];
  for (const el of [...scopeEl.querySelectorAll(args.controlSelector), ...document.querySelectorAll("[" + args.triggerIndexAttr + "]")]) {
    if (seen.has(el)) continue;
    seen.add(el);
    candidates.push(el);
  }
  const docWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const controls = candidates.slice(0, args.max).map((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const rendered = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;
    const onScreen = rendered && left + rect.width > 0 && top + rect.height > 0 && left < docWidth && top < docHeight;
    const disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
    const isInput = el.tagName === "INPUT";
    const text = (el.getAttribute("aria-label") || el.textContent || (isInput ? el.value : "") || el.getAttribute("title") || "").trim();
    const attributeText = [el.getAttribute("aria-label"), el.getAttribute("title"), el.id, typeof el.className === "string" ? el.className : "", text].filter(Boolean).join(" ");
    return {
      controlId: idFor(el),
      triggerIndex: el.getAttribute(args.triggerIndexAttr),
      tag: el.tagName.toLowerCase(),
      inputType: isInput ? el.type : null,
      rendered,
      onScreen,
      enabled: !disabled,
      text,
      attributeText,
      clickedByEngine: el.hasAttribute(args.activatedAttr),
    };
  });
  const loading = [...scopeEl.querySelectorAll(args.loadingSelector)].some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).visibility !== "hidden";
  });
  return { controls, loading };
}`;

const CONTROL_SELECTOR = 'button, input[type="button"], input[type="submit"], input[type="image"], [role="button"]';

export function startLookupControlTimeline(
  page: Page,
  scope: Locator,
  options: {
    now: () => number;
    triggerIndexAttr: string;
    activatedAttr: string;
    loadingIndicatorSelector: string;
    lookupVocabulary: (text: string) => boolean;
    geolocationVocabulary: (attributeText: string) => boolean;
  },
): LookupControlTimelineRecorder {
  const entries: LookupControlTimelineEntry[] = [];
  let truncated = false;
  let lastSignature = "";

  async function read(): Promise<{ controls: RawControl[]; loading: boolean } | null> {
    return callInPageFunction<{ controls: RawControl[]; loading: boolean }>(scope, "__navEngineReadLookupControls", READ_CONTROLS_SOURCE, {
      controlSelector: CONTROL_SELECTOR,
      triggerIndexAttr: options.triggerIndexAttr,
      activatedAttr: options.activatedAttr,
      loadingSelector: options.loadingIndicatorSelector,
      max: MAX_TIMELINE_CONTROLS,
    }).catch(() => null);
  }

  return {
    async sample(phase: string) {
      const raw = await read();
      if (!raw) return;
      const controls: LookupControlState[] = raw.controls.map((c) => ({
        controlId: c.controlId,
        triggerIndex: c.triggerIndex,
        tag: c.tag,
        inputType: c.inputType,
        rendered: c.rendered,
        onScreen: c.onScreen,
        enabled: c.enabled,
        textLength: c.text.length,
        lookupVocabulary: options.lookupVocabulary(c.text),
        geolocationVocabulary: options.geolocationVocabulary(c.attributeText),
        clickedByEngine: c.clickedByEngine,
      }));
      const signature = JSON.stringify([raw.loading, controls]);
      if (signature === lastSignature) return;
      lastSignature = signature;
      if (entries.length >= MAX_TIMELINE_ENTRIES) {
        truncated = true;
        entries[entries.length - 1] = { atMs: options.now(), phase, loadingIndicatorVisible: raw.loading, controls };
        return;
      }
      entries.push({ atMs: options.now(), phase, loadingIndicatorVisible: raw.loading, controls });
    },
    result() {
      const actionable = (c: LookupControlState) => c.rendered && c.onScreen && c.enabled;
      const first = entries[0];
      const initiallyActionable = new Set((first?.controls ?? []).filter(actionable).map((c) => c.controlId));
      const became = new Map<number, LookupControlTimeline["controlsBecameActionable"][number]>();
      for (const entry of entries.slice(1)) {
        for (const c of entry.controls) {
          if (actionable(c) && !initiallyActionable.has(c.controlId) && !became.has(c.controlId)) {
            became.set(c.controlId, { controlId: c.controlId, atMs: entry.atMs, phase: entry.phase, clickedByEngine: false, lookupVocabulary: c.lookupVocabulary, geolocationVocabulary: c.geolocationVocabulary });
          }
        }
      }
      const last = entries[entries.length - 1];
      for (const record of became.values()) {
        record.clickedByEngine = entries.some((e) => e.controls.some((c) => c.controlId === record.controlId && c.clickedByEngine));
      }
      return {
        entries,
        truncated,
        controlsBecameActionable: [...became.values()],
        controlsDisabledAtEnd: (last?.controls ?? []).filter((c) => c.rendered && c.onScreen && !c.enabled).map((c) => c.controlId),
      };
    },
  };
}
