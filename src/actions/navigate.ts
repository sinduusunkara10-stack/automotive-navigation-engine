import type { Page } from "playwright";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult, Captures } from "../types/task-response.js";
import type { CaptureModuleName } from "../types/captureModule.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { robustGoto } from "../core/robustNavigation.js";
import { recordDiagnosticError } from "../capture-modules/errors.js";

export interface ExecuteNavigateParams {
  page: Page;
  action: SelectedAction;
  allowedDomains: string[];
  timeoutMs: number;
  captures: Captures;
  stepIndex: number;
  captureModules: CaptureModuleName[];
}

/**
 * Executes the `navigate` action via the shared robust-navigation helper (waits only for
 * "domcontentloaded", never "load"/"networkidle" -- see src/core/robustNavigation.ts).
 * Domain policy is enforced both before navigating (the target itself) and after (the
 * URL actually reached, including any redirect and the URL reached via timeout
 * recovery) -- landing outside allowedDomains is always a failure, never silently
 * accepted. A recoverable timeout (a usable document already reached after
 * domcontentloaded) is treated as success and recorded as a warning diagnostic, mirroring
 * the engine's initial-navigation recovery behaviour, rather than as an action failure.
 */
export async function executeNavigate(params: ExecuteNavigateParams): Promise<ActionResult> {
  const { page, action, allowedDomains, timeoutMs, captures, stepIndex, captureModules } = params;

  if (!action.target) {
    return { success: false, error: "navigate action requires a target URL" };
  }
  if (!checkNavigationAllowed(action.target, allowedDomains)) {
    return { success: false, error: `navigate target is outside allowedDomains: ${action.target}` };
  }

  const outcome = await robustGoto({ page, url: action.target, allowedDomains, timeoutMs });

  if (outcome.status === "failed") {
    return {
      success: false,
      error: outcome.message ?? "navigate action failed",
      ...(outcome.url ? { resultingUrl: outcome.url } : {}),
    };
  }

  if (!checkNavigationAllowed(outcome.url, allowedDomains)) {
    return { success: false, error: `navigation landed outside allowedDomains: ${outcome.url}`, resultingUrl: outcome.url };
  }

  if (outcome.status === "recovered" && captureModules.includes("errors")) {
    recordDiagnosticError(captures, {
      stepIndex,
      category: "navigation_failure",
      severity: "warning",
      pageUrl: outcome.url,
      actionType: "navigate",
      message: outcome.message ?? "Navigate action timed out but recovered.",
      recoverable: true,
      stoppedRun: false,
    });
  }

  return { success: true, resultingUrl: outcome.url };
}
