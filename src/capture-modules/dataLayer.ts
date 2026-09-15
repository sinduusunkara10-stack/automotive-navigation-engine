import type { Frame, Page } from "playwright";

/** Minimal shape of Playwright's own exposeBinding callback source -- not re-exported from the top-level "playwright" package, so declared locally rather than reaching into playwright-core's internals. */
interface ExposedBindingSource {
  page: Page;
  frame: Frame;
}
import type { Captures, DataLayerCapture, EvidenceCaptureSource } from "../types/task-response.js";
import {
  MAX_DATA_LAYER_PUSH_ARGS_PER_CALL,
  MAX_DATA_LAYER_PUSH_EVENTS_PER_RUN,
  MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT,
} from "../config/captureLimits.js";
import { appendBounded } from "../core/boundedArray.js";
import { listChildFrames } from "../observation/frames.js";

function safePageUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return "";
  }
}

function frameOriginOf(frame: Frame): string | undefined {
  try {
    return new URL(frame.url()).origin;
  } catch {
    return undefined;
  }
}

async function readWindowDataLayer(target: Page | Frame): Promise<unknown[]> {
  return target
    .evaluate(() => {
      const dataLayer = (window as unknown as { dataLayer?: unknown[] }).dataLayer;
      return Array.isArray(dataLayer) ? dataLayer : [];
    })
    .catch(() => []);
}

function boundedRaw(raw: unknown[]): { raw: Record<string, unknown>[]; truncated: boolean } {
  const truncated = raw.length > MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT;
  return { raw: (raw as Record<string, unknown>[]).slice(-MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT), truncated };
}

export interface DataLayerCaptureContext {
  /** See src/capture-modules/captureContext.ts. Omitted only by legacy/untagged callers. */
  contextId?: string;
  /** Set when reading from an adopted popup Page -- every entry is tagged "popup_context" regardless of which of the popup's own frames it came from. */
  forcedSource?: EvidenceCaptureSource;
}

/**
 * Bounded, frame-aware per-step window.dataLayer snapshot (item 12 of the cross-client
 * analytics-capture fix -- see CLAUDE.md and docs/architecture.md "Generic action-attributed
 * analytics capture"). Reads the *entire* current window.dataLayer every step (not a delta
 * -- see dataLayerDelta.ts for the delta variant used elsewhere) from the main frame and
 * every same-origin child frame the engine can already reach (src/observation/frames.ts,
 * reused as-is -- no new frame-discovery logic). Returns one entry per frame that actually
 * has a dataLayer array; the main frame's entry is always returned (even when empty), so
 * an existing caller with no iframes on the page sees exactly the same one-entry-per-step
 * shape as before this fix. Each entry is independently bounded to the most recent
 * MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT entries (see boundedRaw), never the oldest.
 */
export async function captureDataLayer(
  page: Page,
  stepIndex: number,
  context: DataLayerCaptureContext = {},
): Promise<DataLayerCapture[]> {
  const timestamp = new Date().toISOString();
  const url = safePageUrl(page);
  const entries: DataLayerCapture[] = [];

  const mainRaw = await readWindowDataLayer(page.mainFrame());
  const mainBounded = boundedRaw(mainRaw);
  entries.push({
    stepIndex,
    url,
    timestamp,
    raw: mainBounded.raw,
    source: context.forcedSource ?? "main_frame",
    ...(context.contextId ? { contextId: context.contextId } : {}),
    ...(mainBounded.truncated ? { truncated: true } : {}),
  });

  const { accessible } = await listChildFrames(page).catch(() => ({ accessible: [], inaccessible: [] }));
  for (const child of accessible) {
    const raw = await readWindowDataLayer(child.frame);
    if (raw.length === 0) {
      // No noise entries for a frame with no dataLayer at all -- the main-frame entry
      // above already guarantees "at least one entry per step" for every caller.
      continue;
    }
    const bounded = boundedRaw(raw);
    entries.push({
      stepIndex,
      url,
      timestamp,
      raw: bounded.raw,
      source: context.forcedSource ?? "child_frame",
      frameOrigin: child.origin,
      ...(context.contextId ? { contextId: context.contextId } : {}),
      ...(bounded.truncated ? { truncated: true } : {}),
    });
  }

  return entries;
}

const PUSH_BINDING_NAME = "__navEngineDataLayerPushV1";

/**
 * Injected once per navigation (via page.addInitScript, which Playwright guarantees runs
 * before any of the page's own scripts, on every new document including after a full
 * navigation) so that a dataLayer.push() call is observed by this engine synchronously,
 * in Node, at the moment it happens -- not only whenever the next per-step snapshot
 * (captureDataLayer above) happens to run. This is what recovers a click handler's own
 * push when it fires immediately before a same-tab navigation that would otherwise tear
 * down the JS context (and reset window.dataLayer to a fresh array) before any later
 * snapshot could ever see it (item 10/11 of the cross-client analytics-capture fix).
 *
 * Deliberately generic and mechanical: this only ever intercepts the well-known global
 * `dataLayer` array name already read everywhere else in this module (and already assumed
 * throughout this codebase, e.g. dataLayerDelta.ts) -- never a vendor/brand-specific
 * selector or event-name vocabulary. `window.dataLayer = window.dataLayer || []` (GTM's
 * own standard bootstrap idiom) keeps reusing the same wrapped array, since an empty array
 * is truthy; a site that reassigns `window.dataLayer` to a brand-new array is still caught
 * via the property setter re-wrapping whatever it's set to. Best-effort only: wrapped in
 * try/catch so a page that has already made `window.dataLayer` non-configurable for its
 * own reasons degrades silently (no push capture for that page) rather than breaking
 * anything else about the run.
 *
 * Deliberately built as a raw source STRING, never a function reference passed to
 * page.addInitScript(fn): Playwright serializes a function argument via its own
 * `.toString()`, and this project's dev/test runner (tsx, via esbuild) rewrites every
 * function expression at Node-side compile time into `__name(fn, "fn")` calls (esbuild's
 * name-preservation transform) -- a helper that exists only in the *Node-side compiled
 * module's own scope*, not in the browser page this string is injected into, so a
 * function-reference version of this exact logic throws a silently-caught ReferenceError
 * in the browser before ever wrapping anything. A plain string is never run through that
 * Node-side transform at all, since it's opaque data as far as esbuild/tsc are concerned --
 * it is only ever parsed and executed inside the browser page itself. PUSH_BINDING_NAME is
 * a fixed, engine-controlled constant (never caller/page-supplied input), so this
 * interpolation carries no injection risk.
 */
const injectedDataLayerObserverScript = `(() => {
  try {
    const bindingName = ${JSON.stringify(PUSH_BINDING_NAME)};
    const w = window;
    let real = [];
    const wrap = (arr) => {
      try {
        Object.defineProperty(arr, "push", {
          configurable: true,
          value: function (...args) {
            try {
              const fn = w[bindingName];
              if (typeof fn === "function") {
                fn(args);
              }
            } catch (e) {
              /* best-effort push observation only -- never block the real push below */
            }
            return Array.prototype.push.apply(this, args);
          },
        });
      } catch (e) {
        /* if push itself can't be redefined on this array, fall through unwrapped */
      }
      return arr;
    };
    real = wrap(real);
    Object.defineProperty(w, "dataLayer", {
      configurable: true,
      get() {
        return real;
      },
      set(value) {
        real = wrap(Array.isArray(value) ? value : []);
      },
    });
  } catch (e) {
    /* window.dataLayer already non-configurable, or some other page-defined restriction --
       degrade silently; the per-step snapshot above still captures whatever is present. */
  }
})();`;

export interface DataLayerPushCaptureContext {
  contextId?: string;
  /** Set when attaching to an adopted popup Page -- every push observed there is tagged "popup_context" regardless of which of the popup's own frames it came from. */
  forcedSource?: EvidenceCaptureSource;
}

/**
 * Attaches the real-time dataLayer.push observer above to `page` for as long as the
 * returned detach function isn't called. Mirrors attachGa4NetworkCapture's own
 * attach/detach shape (ga4NetworkEvents.ts) so callers compose the two identically.
 * Playwright has no API to fully remove an exposed binding/init script once installed;
 * detach only stops this module from writing further captures (a `removed` guard) --
 * harmless once the underlying page/context itself is closed at run end.
 */
export async function attachDataLayerPushCapture(
  page: Page,
  captures: Captures,
  getStepIndex: () => number,
  context: DataLayerPushCaptureContext = {},
): Promise<() => void> {
  let removed = false;

  await page
    .exposeBinding(PUSH_BINDING_NAME, (source: ExposedBindingSource, pushedArgs: unknown) => {
      if (removed) {
        return;
      }
      if (!Array.isArray(pushedArgs) || pushedArgs.length === 0) {
        return;
      }
      const isMainFrame = source.frame === source.page.mainFrame();
      const truncated = pushedArgs.length > MAX_DATA_LAYER_PUSH_ARGS_PER_CALL;
      const raw = pushedArgs.slice(0, MAX_DATA_LAYER_PUSH_ARGS_PER_CALL) as Record<string, unknown>[];
      const evidenceSource: EvidenceCaptureSource = context.forcedSource ?? (isMainFrame ? "main_frame" : "child_frame");
      const entry: DataLayerCapture = {
        stepIndex: getStepIndex(),
        url: safePageUrl(source.page),
        timestamp: new Date().toISOString(),
        raw,
        source: evidenceSource,
        ...(!isMainFrame && !context.forcedSource ? { frameOrigin: frameOriginOf(source.frame) } : {}),
        ...(context.contextId ? { contextId: context.contextId } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
      captures.data_layer_evidence = appendBounded(
        captures.data_layer_evidence ?? [],
        entry,
        MAX_DATA_LAYER_PUSH_EVENTS_PER_RUN,
      );
    })
    .catch(() => {
      /* a binding of this name may already exist on this page (attach called twice) or
         the page may already be closed -- either way, degrade silently, matching the
         addInitScript catch below. */
    });

  await page.addInitScript(injectedDataLayerObserverScript).catch(() => {});

  return () => {
    removed = true;
  };
}
