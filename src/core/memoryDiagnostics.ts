import type { MemorySample } from "../types/task-response.js";
import { appendBounded } from "./boundedArray.js";

// Bounded independently of maxSteps (which can be as high as 500): a sample per step on a
// long run would itself become an unbounded-ish collection, working against the exact
// memory-stability goal this diagnostic exists to serve. Keeping the most recent N samples
// still shows the run's late-stage trend, which is what matters for correlating with an
// incident near the end of a run (e.g. an OOM kill).
export const MAX_MEMORY_SAMPLES = 50;

function sample(label: MemorySample["label"], stepIndex?: number): MemorySample {
  const usage = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    label,
    ...(stepIndex !== undefined ? { stepIndex } : {}),
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    externalBytes: usage.external,
  };
}

/** Appends one process.memoryUsage() sample, bounded to MAX_MEMORY_SAMPLES (oldest dropped first). */
export function recordMemorySample(
  samples: readonly MemorySample[],
  label: MemorySample["label"],
  stepIndex?: number,
): MemorySample[] {
  return appendBounded(samples, sample(label, stepIndex), MAX_MEMORY_SAMPLES);
}
