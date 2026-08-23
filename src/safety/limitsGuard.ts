import type { Limits } from "../types/task-request.js";

export type LimitBreach = "max_steps" | "max_backtracks" | "max_duration";

export interface LimitsState {
  stepCount: number;
  backtrackCount: number;
  startedAtMs: number;
}

export function checkLimits(state: LimitsState, limits: Limits): LimitBreach | undefined {
  if (state.stepCount >= limits.maxSteps) {
    return "max_steps";
  }
  if (state.backtrackCount > limits.maxBacktracks) {
    return "max_backtracks";
  }
  if (limits.maxDurationSeconds !== undefined) {
    const elapsedSeconds = (Date.now() - state.startedAtMs) / 1000;
    if (elapsedSeconds >= limits.maxDurationSeconds) {
      return "max_duration";
    }
  }
  return undefined;
}
