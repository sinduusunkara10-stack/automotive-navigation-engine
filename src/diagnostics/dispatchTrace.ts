import type { Page } from "playwright";
import type { RunState } from "../core/state.js";
import type { SelectedAction } from "../types/actions.js";
import type { ActionResult } from "../types/task-response.js";
import type { ActionTraceRecord, GoBackTrace } from "../types/failureDiagnostics.js";

/**
 * Diagnostics-only: records which surface/Page is active, and which Pages are open, right
 * before an action is dispatched. The record is stored immediately (so it survives a dispatch
 * that throws) and completed by finishDispatchTrace. Reads state only; never changes it beyond
 * the diagnostics-only fields it owns.
 */
export function beginDispatchTrace(params: {
  state: RunState;
  stepIndex: number;
  action: SelectedAction;
  goBack?: GoBackTrace;
}): ActionTraceRecord {
  const { state, stepIndex, action, goBack } = params;
  const targetElementId = "target" in action && typeof action.target === "string" ? action.target : undefined;
  state.lastAttemptedAction = {
    stepIndex,
    actionType: action.type,
    ...(action.type === "click" && targetElementId ? { targetElementId } : {}),
    ...(goBack ? { goBackSource: goBack.source } : {}),
  };
  const journeyMemory = state.lastDecisionJourneyMemory?.stepIndex === stepIndex ? state.lastDecisionJourneyMemory : undefined;
  const record: ActionTraceRecord = {
    stepIndex,
    actionType: action.type,
    ...(targetElementId ? { targetElementId } : {}),
    ...(goBack ? { goBack } : {}),
    ...(journeyMemory ? { journeyMemory: { ...journeyMemory } } : {}),
    before: state.pageLifecycle.snapshot({ activeSurface: state.activeSurface, activePage: state.activePage }),
  };
  state.pageLifecycle.recordAction(record);
  return record;
}

/**
 * Completes a record from beginDispatchTrace. `stepPage` is the Page the rest of the calling
 * step keeps using after dispatch, recorded alongside the now-active one so a mismatch (or a
 * closed step Page) is visible.
 */
export function finishDispatchTrace(params: {
  state: RunState;
  trace: ActionTraceRecord;
  stepPage: Page;
  actionResult: ActionResult;
}): void {
  const { state, trace, stepPage, actionResult } = params;
  const lifecycle = state.pageLifecycle;
  trace.after = {
    ...lifecycle.snapshot({ activeSurface: state.activeSurface, activePage: state.activePage }),
    stepPageId: lifecycle.pageId(stepPage),
    stepPageClosed: stepPage.isClosed(),
    success: actionResult.success,
    ...(actionResult.resultingUrl ? { resultingUrl: actionResult.resultingUrl } : {}),
    ...(actionResult.error ? { error: actionResult.error.slice(0, 300) } : {}),
  };
}
