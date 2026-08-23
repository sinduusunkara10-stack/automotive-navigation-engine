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
