import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionExecutorResult, ActionResult, ActiveSurfaceInfo, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import type { SurfaceAdoptionRequest } from "../capture-modules/popupCapture.js";
import type { ActionTimingOut, ClickProgressSignal } from "./click.js";
import type { InteractionSnapshot } from "../observation/observationBuilder.js";
import { captureInteractionSnapshot, classifyObservedSurfaceChange } from "../observation/observationBuilder.js";
import { executeClick } from "./click.js";
import { executeScroll } from "./scroll.js";
import { executeWait } from "./wait.js";
import { executeGoBack } from "./goBack.js";
import { executeNavigate } from "./navigate.js";
import { executeCapture } from "./capture.js";
import { executeStopSuccess } from "./stopSuccess.js";
import { executeStopBlocked } from "./stopBlocked.js";
import { executeStopFailure } from "./stopFailure.js";
import { executeFillForm } from "./fillForm.js";
import type { UnmappedFieldResolver } from "../forms/unmappedFieldResolver.js";
import type { FormJourneyContext, FormSelectionAmbiguityResolver } from "../forms/formRelevance.js";

export interface DispatchParams {
  page: Page;
  action: SelectedAction;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
  allowedDomains: string[];
  actionNavigationTimeoutMs: number;
  // Only meaningful for a `click` action -- see ExecuteClickParams in actions/click.ts.
  reObservationAttempted?: boolean;
  knownDestinationUrl?: string;
  /** Task-level override for the adaptive settle ceiling (task.settling.maxSettleMs) -- see core/robustNavigation.ts. */
  settleCeilingMs?: number;
  /** Only meaningful for a `click` action -- see ExecuteClickParams/SurfaceAdoptionRequest in actions/click.ts and capture-modules/popupCapture.ts. */
  surfaceAdoption?: SurfaceAdoptionRequest;
  /** Only meaningful for a `click` action -- see ExecuteClickParams.timingOut in actions/click.ts. */
  timingOut?: ActionTimingOut;
  /** Only meaningful for a `click` action -- see ExecuteClickParams.progressSignal in actions/click.ts. */
  progressSignal?: ClickProgressSignal;
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  unmappedFieldResolver?: UnmappedFieldResolver;
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  formJourneyContext?: FormJourneyContext;
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  formSelectionAmbiguityResolver?: FormSelectionAmbiguityResolver;
  /** Diagnostic-only (see src/diagnostics/formDiscoveryDiagnostic.ts), only meaningful for a `fill_form` action -- never read by scoring/selection/fill logic. */
  taskId?: string;
  /** Diagnostic-only, only meaningful for a `fill_form` action -- the pre-dispatch observation's own activeSurface. */
  activeSurfaceInfo?: ActiveSurfaceInfo;
}

function safePageUrl(page: Page): string | undefined {
  try {
    return page.url();
  } catch {
    return undefined;
  }
}

/**
 * Generic interaction-outcome classification (schemaVersion 1.42.0): computed once here for
 * every action type, never gated by, or aware of, which action ran -- the same before/after
 * interactive-element/dialog/panel snapshot diff actions/click.ts already uses for its own
 * surfaceChangeDetected/surfaceChangeType, applied uniformly at the dispatch level instead of
 * only for clicks. A stop_* action, or any other result whose resultingUrl/page URL never
 * moves and whose snapshot never changes, is NO_OBSERVABLE_CHANGE -- the correct value for an
 * action that was never meant to touch the page at all.
 */
async function classifyInteractionOutcome(params: {
  page: Page;
  urlBeforeDispatch: string;
  snapshotBeforeDispatch: InteractionSnapshot | undefined;
  result: ActionExecutorResult;
}): Promise<ActionResult["interactionOutcome"]> {
  const { page, urlBeforeDispatch, snapshotBeforeDispatch, result } = params;
  const urlAfterDispatch = result.resultingUrl ?? safePageUrl(page) ?? urlBeforeDispatch;
  if (urlAfterDispatch !== urlBeforeDispatch) {
    return "NAVIGATION";
  }
  if (!snapshotBeforeDispatch) {
    return "NO_OBSERVABLE_CHANGE";
  }
  const snapshotAfterDispatch = await captureInteractionSnapshot(page).catch(() => undefined);
  if (!snapshotAfterDispatch) {
    return "NO_OBSERVABLE_CHANGE";
  }
  const assessment = classifyObservedSurfaceChange(snapshotBeforeDispatch, snapshotAfterDispatch);
  // Deliberately broader than assessment.type alone: type stays "none" below
  // MIN_NEW_INTERACTIVE_ELEMENTS_FOR_SURFACE_CHANGE (2, observationBuilder.ts) to avoid a
  // false-positive *dialog/panel* classification, but assessment.newElementCount is always
  // the raw count regardless of type -- the same ungated newElementCount > 0 check
  // actions/click.ts's own ClickProgressSignal already uses to avoid exactly this PR #85
  // dead-end regression (a single-element in-place reveal, e.g. Continue -> Add to Cart,
  // must count as a real state change here too, not just internally to the reasoning loop).
  return assessment.type !== "none" || assessment.newElementCount > 0 ? "IN_PAGE_STATE_CHANGE" : "NO_OBSERVABLE_CHANGE";
}

async function dispatchByType(params: DispatchParams): Promise<ActionExecutorResult> {
  const {
    page,
    action,
    captures,
    stepIndex,
    captureModules,
    allowedDomains,
    actionNavigationTimeoutMs,
    reObservationAttempted,
    knownDestinationUrl,
    settleCeilingMs,
    surfaceAdoption,
    timingOut,
    progressSignal,
    unmappedFieldResolver,
    formJourneyContext,
    formSelectionAmbiguityResolver,
    taskId,
    activeSurfaceInfo,
  } = params;
  switch (action.type) {
    case "click":
      return executeClick({
        page,
        action,
        allowedDomains,
        timeoutMs: actionNavigationTimeoutMs,
        captures,
        stepIndex,
        captureModules,
        reObservationAttempted,
        knownDestinationUrl,
        timingOut,
        progressSignal,
        settleCeilingMs,
        surfaceAdoption,
      });
    case "scroll":
      return executeScroll(page, action);
    case "wait":
      return executeWait(page, action);
    case "go_back":
      return executeGoBack(page, actionNavigationTimeoutMs);
    case "navigate":
      return executeNavigate({
        page,
        action,
        allowedDomains,
        timeoutMs: actionNavigationTimeoutMs,
        captures,
        stepIndex,
        captureModules,
        settleCeilingMs,
      });
    case "capture":
      return executeCapture(page, captures, stepIndex, captureModules);
    case "fill_form":
      return executeFillForm({
        page,
        action,
        captures,
        stepIndex,
        captureModules,
        unmappedFieldResolver,
        journeyContext: formJourneyContext,
        selectionAmbiguityResolver: formSelectionAmbiguityResolver,
        taskId,
        activeSurfaceInfo,
      });
    case "stop_success":
      return executeStopSuccess();
    case "stop_blocked":
      return executeStopBlocked();
    case "stop_failure":
      return executeStopFailure();
    default: {
      const exhaustiveCheck: never = action.type;
      throw new Error(`Unhandled action type: ${String(exhaustiveCheck)}`);
    }
  }
}

export async function dispatchAction(params: DispatchParams): Promise<ActionResult> {
  const { page } = params;
  const urlBeforeDispatch = safePageUrl(page) ?? "";
  const snapshotBeforeDispatch = await captureInteractionSnapshot(page).catch(() => undefined);
  const result = await dispatchByType(params);
  const interactionOutcome = await classifyInteractionOutcome({
    page,
    urlBeforeDispatch,
    snapshotBeforeDispatch,
    result,
  });
  return { ...result, interactionOutcome };
}
