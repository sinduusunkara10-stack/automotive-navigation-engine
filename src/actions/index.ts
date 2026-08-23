import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import { executeClick } from "./click.js";
import { executeScroll } from "./scroll.js";
import { executeWait } from "./wait.js";
import { executeGoBack } from "./goBack.js";
import { executeNavigate } from "./navigate.js";
import { executeCapture } from "./capture.js";
import { executeStopSuccess } from "./stopSuccess.js";
import { executeStopBlocked } from "./stopBlocked.js";
import { executeStopFailure } from "./stopFailure.js";

export interface DispatchParams {
  page: Page;
  action: SelectedAction;
  captures: Captures;
  stepIndex: number;
}

export async function dispatchAction(params: DispatchParams): Promise<ActionResult> {
  const { page, action, captures, stepIndex } = params;
  switch (action.type) {
    case "click":
      return executeClick(page, action);
    case "scroll":
      return executeScroll(page, action);
    case "wait":
      return executeWait(page, action);
    case "go_back":
      return executeGoBack(page);
    case "navigate":
      return executeNavigate(page, action);
    case "capture":
      return executeCapture(page, captures, stepIndex);
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
