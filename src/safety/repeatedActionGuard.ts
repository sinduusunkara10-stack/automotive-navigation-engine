import type { SelectedAction } from "../types/actions.js";

export function actionKey(action: SelectedAction): string {
  return `${action.type}:${action.target ?? ""}`;
}

export function isRepeatedActionLimitExceeded(
  history: SelectedAction[],
  nextAction: SelectedAction,
  maxRepeatedActions: number,
): boolean {
  const key = actionKey(nextAction);
  let consecutive = 1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const previous = history[i];
    if (previous !== undefined && actionKey(previous) === key) {
      consecutive += 1;
    } else {
      break;
    }
  }
  return consecutive > maxRepeatedActions;
}
