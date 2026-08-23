import type { JourneyPathEntry, StepLog } from "../types/task-response.js";

/**
 * Derived entirely from a StepLog the core loop already produced — this module adds
 * no new observation of the page, it just reshapes generic per-step data into a
 * standalone ordered capture, independent of the task's domain.
 */
export function buildJourneyPathEntry(stepLog: StepLog): JourneyPathEntry {
  const { stepIndex, timestamp, observation, decision, selectedAction, actionResult, progress } = stepLog;

  const selectedElement = selectedAction.target
    ? observation.interactiveElements.find((el) => el.id === selectedAction.target)
    : undefined;

  return {
    stepIndex,
    timestamp,
    pageUrlBefore: observation.url,
    pageTitle: observation.title,
    selectedAction,
    ...(selectedElement
      ? {
          selectedElement: {
            id: selectedElement.id,
            role: selectedElement.role,
            accessibleName: selectedElement.accessibleName,
          },
        }
      : {}),
    decisionReason: decision,
    actionOutcome: actionResult,
    pageUrlAfter: actionResult.resultingUrl ?? observation.url,
    progress,
  };
}
