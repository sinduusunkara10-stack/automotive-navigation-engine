export const ACTION_TYPES = [
  "click",
  "scroll",
  "wait",
  "go_back",
  "navigate",
  "capture",
  "stop_success",
  "stop_blocked",
  "stop_failure",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

export interface SelectedAction {
  type: ActionType;
  target?: string;
  params?: Record<string, unknown>;
}

/**
 * A SelectedAction as retained in a run's history, with generic evidence of whether it
 * produced any observable page-state change -- see RunState.resolveLastActionProgress
 * (core/state.ts). true/false once the next observation has been taken; undefined for the
 * most recently recorded action (nothing to compare against yet) and, permanently,
 * undefined for a run's very last action. A plain url/title diff, computed identically for
 * every action type -- never gated by, or aware of, any particular action's semantics, a
 * capture module, brand, or URL pattern.
 */
export interface RecordedAction extends SelectedAction {
  observedProgress?: boolean;
}
