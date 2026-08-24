import { ACTION_TYPES, type ActionType, type SelectedAction } from "../../src/types/actions.js";
import type { ClaudeDecisionLogEntry } from "../../src/reasoning/claudeReasoningProvider.js";
import type { StepLog } from "../../src/types/task-response.js";

/**
 * Pure, side-effect-free pass/fail logic for the one-decision Claude reasoning provider
 * smoke test (tests/manual/claudeReasoningProviderSmokeTest.ts). Kept separate from that
 * script -- which drives a real browser and makes one real, billed Claude API call -- so
 * the acceptance rules themselves can be exercised by the fast automated test suite
 * without any network call. See tests/unit/manualClaudeSmokeTestAcceptance.test.ts.
 *
 * This smoke test exists to prove exactly one real Claude decision works safely against
 * the local fictional fixture; it is not a full multi-page journey test. The task is
 * deliberately capped at maxSteps: 1, so a final engine status of "max_steps_reached"
 * immediately after that one accepted decision is the expected outcome, not a failure --
 * the safety layer's limits guard forces a stop_failure/stop_blocked step for that without
 * ever calling the reasoning provider again (see src/core/loop.ts), so it never shows up
 * as a second entry in the decision log.
 */

// Only "click" currently resolves its `target` against an observed element id (see
// ACTIONS_REQUIRING_ELEMENT_TARGET in src/reasoning/validateClaudeDecision.ts); other
// action types either take no target or (navigate) take a URL, not an element id.
const ELEMENT_TARGETING_ACTION_TYPES: ReadonlySet<ActionType> = new Set(["click"]);

const LIMIT_STOP_SAFETY_FLAGS = new Set(["max_steps", "max_backtracks", "max_duration"]);

// Matches a real, populated Anthropic API key shape (sk-ant-...), not a placeholder.
const LITERAL_ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{10,}/;

export interface SmokeTestAcceptanceInput {
  decisionLog: readonly ClaudeDecisionLogEntry[];
  steps: readonly StepLog[];
  allowedActions: readonly ActionType[];
  /** The real secret in play, if any. Omit in unit tests, which never hold a real key. */
  secretValue?: string;
}

export interface SmokeTestAcceptanceResult {
  ok: boolean;
  reason: string;
}

function fail(reason: string): SmokeTestAcceptanceResult {
  return { ok: false, reason };
}

function isSchemaValidSelectedAction(action: SelectedAction): boolean {
  if (typeof action !== "object" || action === null) {
    return false;
  }
  const allowedKeys = new Set(["type", "target", "params"]);
  if (!Object.keys(action).every((key) => allowedKeys.has(key))) {
    return false;
  }
  if (!(ACTION_TYPES as readonly string[]).includes(action.type)) {
    return false;
  }
  if (action.target !== undefined && typeof action.target !== "string") {
    return false;
  }
  if (
    action.params !== undefined &&
    (typeof action.params !== "object" || action.params === null || Array.isArray(action.params))
  ) {
    return false;
  }
  return true;
}

export function evaluateSmokeTestAcceptance(input: SmokeTestAcceptanceInput): SmokeTestAcceptanceResult {
  const { decisionLog, steps, allowedActions, secretValue } = input;

  if (decisionLog.length === 0) {
    return fail("no Claude decision was produced (the decision log is empty)");
  }
  if (decisionLog.length > 1) {
    return fail(
      `more than one Claude API decision was made (${decisionLog.length} decision-log entries: ` +
        `${decisionLog.map((entry) => entry.outcome).join(", ")})`,
    );
  }

  const entry = decisionLog[0];
  if (!entry) {
    return fail("no Claude decision was produced (the decision log is empty)");
  }
  if (entry.provider !== "claude") {
    return fail(`provider was "${entry.provider}", expected "claude"`);
  }
  if (entry.outcome === "error") {
    return fail(`the Claude API call failed (${entry.reason ?? "unknown error"})`);
  }
  if (entry.outcome === "fallback") {
    return fail(
      `no valid Claude decision was produced; the provider fell back (${entry.reason ?? "unknown reason"})`,
    );
  }
  if (entry.outcome === "rejected") {
    return fail(`the Claude decision was rejected (${entry.reason ?? "unknown reason"})`);
  }
  if (entry.outcome !== "accepted") {
    return fail(`unexpected decision outcome "${entry.outcome}"`);
  }
  if (entry.attempt !== 0) {
    return fail(`a retry occurred (the accepted decision was attempt ${entry.attempt}, expected attempt 0)`);
  }

  const decisionSteps = steps.filter(
    (step) => !step.safetyFlags?.some((flag) => LIMIT_STOP_SAFETY_FLAGS.has(flag)),
  );
  if (decisionSteps.length !== 1) {
    return fail(
      `expected exactly one step reflecting the accepted Claude decision, found ${decisionSteps.length} ` +
        `(of ${steps.length} total steps)`,
    );
  }
  const decisionStep = decisionSteps[0];
  if (!decisionStep) {
    return fail("expected exactly one step reflecting the accepted Claude decision, found none");
  }

  if (!isSchemaValidSelectedAction(decisionStep.selectedAction)) {
    return fail(`selected action is not schema-valid: ${JSON.stringify(decisionStep.selectedAction)}`);
  }
  if (!allowedActions.includes(decisionStep.selectedAction.type)) {
    return fail(
      `selected action "${decisionStep.selectedAction.type}" is not in the controlled vocabulary allowed for this run`,
    );
  }
  if (ELEMENT_TARGETING_ACTION_TYPES.has(decisionStep.selectedAction.type)) {
    const target = decisionStep.selectedAction.target;
    const knownElement = target
      ? decisionStep.observation.interactiveElements.some((el) => el.id === target)
      : false;
    if (!knownElement) {
      return fail(
        `selected action "${decisionStep.selectedAction.type}" targets element id ` +
          `"${target ?? "(none)"}", which was not present in the observation`,
      );
    }
  }

  const serialized = JSON.stringify({ decisionLog, steps });
  if (LITERAL_ANTHROPIC_KEY_PATTERN.test(serialized)) {
    return fail("output appears to contain a raw Anthropic API key");
  }
  if (secretValue && secretValue.trim() && serialized.includes(secretValue)) {
    return fail("output contains the raw ANTHROPIC_API_KEY secret value");
  }

  return {
    ok: true,
    reason: "exactly one accepted, schema-valid Claude decision with no retry and no leaked secret",
  };
}
