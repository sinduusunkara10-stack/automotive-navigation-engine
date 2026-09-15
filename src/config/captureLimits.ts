/**
 * Bounded-growth ceilings for capture collections identified as unbounded during the
 * memory-stability investigation (see docs/architecture.md "Memory stability"): a page
 * whose window.dataLayer keeps growing was being re-snapshotted in full on every step
 * (worse than linear growth within a single run), and ga4_network_events/errors accumulate
 * for a run's entire lifetime with no cap at all. None of these limits are brand-, site-,
 * or language-specific -- they bound the *shape* of already-generic evidence collections,
 * identically for every task.
 */

/** Per-step window.dataLayer snapshot: keeps the most recent N entries of that snapshot. */
export const MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT = 200;

/** Whole-run cap on captures.ga4_network_events -- a persistent, run-lifetime listener. */
export const MAX_GA4_NETWORK_EVENTS = 500;

/** Whole-run cap on captures.errors -- a persistent, run-lifetime listener. */
export const MAX_ERROR_ENTRIES = 200;

/**
 * Fixed byte cap on a single GA4 network request's raw POST/sendBeacon body
 * (Ga4NetworkEventCapture.postDataRaw) -- bounds the one place an arbitrary-size payload
 * could otherwise enter the response. Past this cap the body is truncated (never dropped;
 * see Ga4NetworkEventCapture.truncated) rather than the whole event being discarded. Not
 * brand/vendor-specific -- it bounds a request body's byte length, not its content.
 */
export const MAX_GA4_POST_BODY_BYTES = 8192;

/**
 * Whole-run cap on real-time dataLayer.push captures (see
 * capture-modules/dataLayer.ts's attachDataLayerPushCapture) -- a persistent,
 * run-lifetime listener, same bounded-growth reasoning as MAX_GA4_NETWORK_EVENTS above.
 * Distinct from MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT, which bounds one per-step
 * full-array snapshot, not this continuous, per-push capture.
 */
export const MAX_DATA_LAYER_PUSH_EVENTS_PER_RUN = 500;

/** Per dataLayer.push(...) call, how many of the pushed arguments are captured -- bounds a single call that (unusually) pushes many arguments at once. */
export const MAX_DATA_LAYER_PUSH_ARGS_PER_CALL = 50;

/**
 * Bounded wait after adopting a popup/new-tab context (see
 * capture-modules/popupCapture.ts) before it is closed -- long enough for an
 * already-in-flight analytics beacon/dataLayer push to land, short enough not to
 * meaningfully slow down a run that opens several such contexts. Not env-configurable
 * (unlike the evidence-retention limits below): this is a capture-timing budget, not an
 * operational how-much-to-retain choice.
 */
export const POPUP_ADOPTION_WINDOW_MS = 1500;

// --- Evidence-retention limits (configurable) -----------------------------------------
//
// Unlike the three constants above, these three bound response evidence that a journey
// narrative actually needs both ends of -- the run's first screenshot/step shows where it
// started, the last shows where it ended, and a naive keep-most-recent-only cap (as used
// above) would silently lose the start. src/core/boundedArray.ts's capPreservingEnds /
// appendBoundedPreservingEnds keep both. These three ARE env-configurable (MAX_*_PER_RUN
// / MAX_STORED_STEPS / MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION below) because,
// unlike the fixed diagnostic caps above, how much journey evidence to retain is a
// legitimate per-deployment operational tuning choice -- the keepFirst split for each is
// not: it stays a fixed constant, matching the fixed 50%-plus-tail-anchor bias
// src/reasoning/promptBuilder.ts already uses for the same "don't lose late-DOM-order
// controls" reason.

export const MAX_SCREENSHOTS_PER_RUN_DEFAULT = 20;
export const MAX_STORED_STEPS_DEFAULT = 50;
export const MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_DEFAULT = 100;

// Hard ceilings, independent of what's configured -- same never-relaxed-ceiling pattern as
// src/config/initialNavigationConfig.ts.
const MAX_SCREENSHOTS_PER_RUN_CEILING = 500;
const MAX_STORED_STEPS_CEILING = 2000;
const MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_CEILING = 2000;

/** Screenshots: keep the first 2 (run start) permanently, slide a window over the rest. */
export const MAX_SCREENSHOTS_KEEP_FIRST = 2;

/** Steps: keep the first 5 (how the run began) permanently, slide a window over the rest. */
export const MAX_STORED_STEPS_KEEP_FIRST = 5;

/** Interactive elements per stored observation: split the budget evenly between the
 * earliest (head-of-DOM) and latest (tail-of-DOM, where terminal-route controls
 * frequently land) elements. */
export const MAX_STORED_INTERACTIVE_ELEMENTS_KEEP_FIRST = Math.floor(
  MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_DEFAULT / 2,
);

export class InvalidEvidenceRetentionLimitError extends Error {
  constructor(varName: string, raw: string, defaultValue: number, ceiling: number) {
    super(
      `${varName} must be a positive integer, at most ${ceiling}. Received: "${raw}". Unset it to use the ` +
        `default (${defaultValue}).`,
    );
    this.name = "InvalidEvidenceRetentionLimitError";
  }
}

function readPositiveIntEnv(
  env: NodeJS.ProcessEnv,
  varName: string,
  defaultValue: number,
  ceiling: number,
): number {
  const raw = env[varName];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new InvalidEvidenceRetentionLimitError(varName, trimmed, defaultValue, ceiling);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > ceiling) {
    throw new InvalidEvidenceRetentionLimitError(varName, trimmed, defaultValue, ceiling);
  }
  return parsed;
}

/** Whole-run cap on captures.screenshots. Configurable via MAX_SCREENSHOTS_PER_RUN. */
export function readMaxScreenshotsPerRun(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(
    env,
    "MAX_SCREENSHOTS_PER_RUN",
    MAX_SCREENSHOTS_PER_RUN_DEFAULT,
    MAX_SCREENSHOTS_PER_RUN_CEILING,
  );
}

/** Whole-run cap on TaskResponse.steps. Configurable via MAX_STORED_STEPS. */
export function readMaxStoredSteps(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(env, "MAX_STORED_STEPS", MAX_STORED_STEPS_DEFAULT, MAX_STORED_STEPS_CEILING);
}

/** Per-stored-observation cap on observation.interactiveElements. Configurable via
 * MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION. Bounds only what's *stored* in the
 * response -- never the live observation the reasoning/validation loop itself uses to
 * decide and validate actions (see src/core/engine.ts). */
export function readMaxStoredInteractiveElementsPerObservation(env: NodeJS.ProcessEnv = process.env): number {
  return readPositiveIntEnv(
    env,
    "MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION",
    MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_DEFAULT,
    MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_CEILING,
  );
}
