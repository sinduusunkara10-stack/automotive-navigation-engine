// Reads MAX_CONCURRENT_TASKS: the ceiling on simultaneously in-flight runs, each of which
// launches its own full Chromium instance (see src/api/runner.ts). Defaults conservatively
// (1) for a small Render instance, where even a single real Chromium process is a
// meaningful fraction of a 512MB memory budget -- see docs/architecture.md "Memory
// stability".

export const DEFAULT_MAX_CONCURRENT_TASKS = 1;

// A misconfigured env var can raise the ceiling, but never past a bound that would make
// the limiter meaningless -- same never-relaxed-ceiling pattern used elsewhere in
// src/config.
const MAX_MAX_CONCURRENT_TASKS = 50;

export class InvalidMaxConcurrentTasksError extends Error {
  constructor(raw: string) {
    super(
      `MAX_CONCURRENT_TASKS must be a positive integer, at most ${MAX_MAX_CONCURRENT_TASKS}. Received: ` +
        `"${raw}". Unset it to use the default (${DEFAULT_MAX_CONCURRENT_TASKS}).`,
    );
    this.name = "InvalidMaxConcurrentTasksError";
  }
}

export function readMaxConcurrentTasks(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_CONCURRENT_TASKS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_MAX_CONCURRENT_TASKS;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidMaxConcurrentTasksError(trimmed);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_MAX_CONCURRENT_TASKS) {
    throw new InvalidMaxConcurrentTasksError(trimmed);
  }
  return parsed;
}
