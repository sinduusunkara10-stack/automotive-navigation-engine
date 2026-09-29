import type { Page } from "playwright";
import type { Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { attachGa4NetworkCapture } from "./ga4NetworkEvents.js";
import { attachDataLayerPushCapture } from "./dataLayer.js";
import { attachErrorCapture } from "./errors.js";
import { MAIN_CONTEXT_ID } from "./captureContext.js";

/**
 * Adopted-surface listener handoff (surface-adoption corrective pass, follow-up to PR #71):
 * engine.ts attaches the real-time GA4-network / dataLayer-push / error observers to the
 * originally-tracked Page exactly once, at run start. Once surface adoption makes a popup the
 * run's new active Page, that popup never got the same treatment -- a click dispatched inside
 * it could only ever be correlated via the coarser, less-confident per-step snapshot diff,
 * never CONFIRMED via the real-time push-observer window. This is the fix: called from
 * core/loop.ts the moment a popup is adopted, it attaches the exact same, already-tested
 * capture-module functions (never a second/parallel analytics mechanism) to the adopted Page,
 * tagged with contextId "main" / source "main_frame" -- the same tagging the existing per-step
 * full-snapshot capture already uses for whichever Page is currently the tracked/active
 * surface, adopted popup included. This is deliberately distinct from "popup_context" tagging,
 * which means a popup that was captured-and-closed without being adopted.
 *
 * Dedup (never double-attach the same Page) and detach-on-run-end are the caller's
 * responsibility via RunState.hasAttachedListeners/markListenersAttached -- this function
 * itself is a pure "attach once" helper with no RunState dependency, so it stays unit-testable
 * without a real run.
 */
export async function attachAdoptedSurfaceListeners(
  page: Page,
  captures: Captures,
  getStepIndex: () => number,
  captureModules: CaptureModuleName[],
): Promise<{ detach: () => void; dataLayerPushListenerActive: boolean }> {
  const detachGa4 = captureModules.includes("ga4_network_events")
    ? attachGa4NetworkCapture(page, captures, getStepIndex, { contextId: MAIN_CONTEXT_ID })
    : undefined;

  const dataLayerPushCapture = captureModules.includes("data_layer_evidence")
    ? await attachDataLayerPushCapture(page, captures, getStepIndex, { contextId: MAIN_CONTEXT_ID })
    : undefined;

  const detachErrors = captureModules.includes("errors") ? attachErrorCapture(page, captures, getStepIndex) : undefined;

  return {
    detach: () => {
      detachGa4?.();
      dataLayerPushCapture?.detach();
      detachErrors?.();
    },
    dataLayerPushListenerActive: dataLayerPushCapture?.attached ?? true,
  };
}
