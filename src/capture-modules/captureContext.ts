/**
 * Stable contextId values shared by every capture module that tags evidence with
 * provenance (see EvidenceCaptureSource in types/task-response.ts). "main" always refers
 * to the one Page the engine navigates for the whole run; a popup gets its own id derived
 * from the step that opened it, since at most one popup is ever adopted per step.
 */
export const MAIN_CONTEXT_ID = "main";

export function popupContextId(stepIndex: number): string {
  return `popup:${stepIndex}`;
}
