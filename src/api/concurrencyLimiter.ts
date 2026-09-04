/**
 * In-process counter bounding how many runs may be simultaneously in flight -- see
 * src/config/concurrencyConfig.ts for why this defaults conservatively. Deliberately a
 * synchronous check-then-increment (tryAcquire): Node's single-threaded event loop means
 * there is no await between the capacity check and the increment, so two concurrent
 * POST /v1/tasks requests can never both succeed past a full limiter. Rejection, not
 * queueing -- a queue is infrastructure this repo is deliberately not adding yet (see
 * CLAUDE.md's phased-scope convention).
 */
export interface ConcurrencyLimiter {
  readonly max: number;
  readonly current: number;
  tryAcquire(): boolean;
  release(): void;
}

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  let current = 0;
  return {
    max,
    get current() {
      return current;
    },
    tryAcquire() {
      if (current >= max) {
        return false;
      }
      current += 1;
      return true;
    },
    release() {
      current = Math.max(0, current - 1);
    },
  };
}
