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

  /**
   * Consecutive count of steps that ended in a staleTarget-classified action failure (see
   * ActionResult.staleTarget) -- reset to 0 the moment a step makes real progress (a
   * successful action, or a non-click action). Bounds core/loop.ts's non-fatal blocker
   * recovery independently of, and tighter than, the existing repeated-action guard, which
   * only catches the *same* action repeated identically.
   */
  consecutiveStaleTargetFailures = 0;

  /** Hostname of the previous step's observation, or undefined before the first step -- lets core/loop.ts detect a cross-host transition to trigger the (opt-in) host_context_snapshot capture. */
  lastObservedHostname: string | undefined;

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
