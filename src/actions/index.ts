import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import type { SurfaceAdoptionRequest } from "../capture-modules/popupCapture.js";
import type { ActionTimingOut } from "./click.js";
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
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  unmappedFieldResolver?: UnmappedFieldResolver;
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  formJourneyContext?: FormJourneyContext;
  /** Only meaningful for a `fill_form` action -- see ExecuteFillFormParams in actions/fillForm.ts. */
  formSelectionAmbiguityResolver?: FormSelectionAmbiguityResolver;
}

export async function dispatchAction(params: DispatchParams): Promise<ActionResult> {
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
    unmappedFieldResolver,
    formJourneyContext,
    formSelectionAmbiguityResolver,
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
