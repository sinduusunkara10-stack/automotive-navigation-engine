import type { SelectedAction } from "../types/actions.js";

export class RunState {
  stepCount = 0;
  backtrackCount = 0;
  readonly startedAtMs = Date.now();
  readonly actionHistory: SelectedAction[] = [];
  readonly visitedUrls: string[] = [];
  readonly satisfiedCriteriaIds = new Set<string>();
  /**
   * Fingerprint (url + sorted satisfied/missing required criteria ids) of the most
   * recently rejected stop_success decision, or undefined if none has been rejected yet.
   * Lets src/core/loop.ts detect two consecutive stop_success rejections with no new
   * evidence at all -- without this, a reasoning provider that keeps re-proposing
   * stop_success on an unchanged page would keep spending model calls until the generic
   * repeated-action safety guard eventually trips several steps later.
   */
  lastRejectedStopSuccessFingerprint: string | undefined;

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
