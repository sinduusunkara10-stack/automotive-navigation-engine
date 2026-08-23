import type { SelectedAction } from "../types/actions.js";

export class RunState {
  stepCount = 0;
  backtrackCount = 0;
  readonly startedAtMs = Date.now();
  readonly actionHistory: SelectedAction[] = [];
  readonly visitedUrls: string[] = [];
  readonly satisfiedCriteriaIds = new Set<string>();

  recordVisit(url: string): void {
    this.visitedUrls.push(url);
  }

  recordAction(action: SelectedAction): void {
    this.actionHistory.push(action);
    this.stepCount += 1;
    if (action.type === "go_back") {
      this.backtrackCount += 1;
    }
  }
}
