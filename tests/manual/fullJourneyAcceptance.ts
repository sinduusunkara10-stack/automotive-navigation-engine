import { ACTION_TYPES, type ActionType, type SelectedAction } from "../../src/types/actions.js";
import type { ClaudeDecisionLogEntry } from "../../src/reasoning/claudeReasoningProvider.js";
import type { TaskResponse } from "../../src/types/task-response.js";

/**
 * Pure, side-effect-free pass/fail logic for the full three-page local-journey Claude
 * smoke test (tests/manual/claudeFullLocalJourneyTest.ts). Kept separate from that
 * script -- which drives a real browser and makes real, billed Claude API calls -- so
 * the acceptance rules themselves can be exercised by the fast automated test suite
 * without any network call (task requirement #14). See
 * tests/unit/manualClaudeFullLocalJourneyAcceptance.test.ts and
 * tests/integration/claudeFullLocalJourney.test.ts.
 */

// Only "click" currently resolves its `target` against an observed element id (see
// ACTIONS_REQUIRING_ELEMENT_TARGET in src/reasoning/validateClaudeDecision.ts); other
// action types either take no target or (navigate) take a URL, not an element id.
const ELEMENT_TARGETING_ACTION_TYPES: ReadonlySet<ActionType> = new Set(["click"]);

// Matches a real, populated Anthropic API key shape (sk-ant-...), not a placeholder.
const LITERAL_ANTHROPIC_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]{10,}/;

export interface FullJourneyAcceptanceInput {
  result: TaskResponse;
  decisionLog: readonly ClaudeDecisionLogEntry[];
  allowedActions: readonly ActionType[];
  baseUrl: string;
  /** The real secret in play, if any. Omit in unit tests, which never hold a real key. */
  secretValue?: string;
}

export interface FullJourneyAcceptanceResult {
  ok: boolean;
  reason: string;
}

function fail(reason: string): FullJourneyAcceptanceResult {
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
  return true;
}

export function evaluateFullJourneyAcceptance(input: FullJourneyAcceptanceInput): FullJourneyAcceptanceResult {
  const { result, decisionLog, allowedActions, baseUrl, secretValue } = input;

  if (result.schemaVersion !== "1.4.0") {
    return fail(`TaskResponse.schemaVersion was "${result.schemaVersion}", expected "1.4.0"`);
  }
  if (result.status !== "success") {
    return fail(`final engine status was "${result.status}", expected "success"`);
  }
  if (result.finalUrl !== `${baseUrl}/success.html`) {
    return fail(`finalUrl was "${result.finalUrl}", expected the success fixture`);
  }

  const reachedStep2 = result.steps.some((step) => step.currentUrl === `${baseUrl}/step2.html`);
  if (!reachedStep2) {
    return fail("no step observed the page at step2.html; the journey never reached it");
  }
  const reachedSuccess = result.steps.some((step) => step.currentUrl === `${baseUrl}/success.html`);
  if (!reachedSuccess) {
    return fail("no step observed the page at success.html; the journey never reached it");
  }

  const decisionSteps = result.steps.filter((step) => !step.safetyFlags || step.safetyFlags.length === 0);
  if (decisionSteps.length < 2) {
    return fail(
      `expected at least two steps reflecting real Claude decisions (start.html and step2.html), found ${decisionSteps.length}`,
    );
  }
  for (const step of decisionSteps) {
    if (!isSchemaValidSelectedAction(step.selectedAction)) {
      return fail(
        `selected action at step ${step.stepIndex} is not schema-valid: ${JSON.stringify(step.selectedAction)}`,
      );
    }
    if (!allowedActions.includes(step.selectedAction.type)) {
      return fail(
        `selected action "${step.selectedAction.type}" at step ${step.stepIndex} is not in the controlled vocabulary allowed for this run`,
      );
    }
    if (ELEMENT_TARGETING_ACTION_TYPES.has(step.selectedAction.type)) {
      const target = step.selectedAction.target;
      const knownElement = target
        ? step.observation.interactiveElements.some((el) => el.id === target)
        : false;
      if (!knownElement) {
        return fail(
          `selected action "${step.selectedAction.type}" at step ${step.stepIndex} targets element id ` +
            `"${target ?? "(none)"}", which was not present in that step's observation`,
        );
      }
    }
  }

  const diagnostics = result.diagnostics.reasoningProvider;
  if (!diagnostics) {
    return fail("diagnostics.reasoningProvider is missing from the completed TaskResponse");
  }
  if (diagnostics.provider !== "claude") {
    return fail(`diagnostics.reasoningProvider.provider was "${diagnostics.provider}", expected "claude"`);
  }

  const realCallCount = decisionLog.filter((entry) => entry.attempt >= 0).length;
  if (realCallCount === 0) {
    return fail("no real Claude API decision was produced (the decision log has no real-call entries)");
  }
  if (realCallCount > 3) {
    return fail(`the run made ${realCallCount} real Claude API calls, exceeding the maximum of 3`);
  }
  if (diagnostics.callCount !== realCallCount) {
    return fail(
      `diagnostics.reasoningProvider.callCount was ${diagnostics.callCount}, expected it to equal the actual ` +
        `number of real provider calls (${realCallCount})`,
    );
  }
  if (diagnostics.acceptedDecisionCount !== diagnostics.callCount) {
    return fail(
      `diagnostics.reasoningProvider.acceptedDecisionCount (${diagnostics.acceptedDecisionCount}) did not equal ` +
        `callCount (${diagnostics.callCount})`,
    );
  }
  if (diagnostics.rejectedDecisionCount !== 0) {
    return fail(
      `diagnostics.reasoningProvider.rejectedDecisionCount was ${diagnostics.rejectedDecisionCount}, expected 0`,
    );
  }
  if (diagnostics.fallbackDecisionCount !== 0) {
    return fail(
      `diagnostics.reasoningProvider.fallbackDecisionCount was ${diagnostics.fallbackDecisionCount}, expected 0`,
    );
  }
  if (diagnostics.retryCount !== 0) {
    return fail(`diagnostics.reasoningProvider.retryCount was ${diagnostics.retryCount}, expected 0`);
  }
  if (!(diagnostics.totalInputTokens > 0)) {
    return fail(`diagnostics.reasoningProvider.totalInputTokens was ${diagnostics.totalInputTokens}, expected > 0`);
  }
  if (!(diagnostics.totalOutputTokens > 0)) {
    return fail(`diagnostics.reasoningProvider.totalOutputTokens was ${diagnostics.totalOutputTokens}, expected > 0`);
  }

  const serialized = JSON.stringify({ decisionLog, steps: result.steps });
  if (LITERAL_ANTHROPIC_KEY_PATTERN.test(serialized)) {
    return fail("output appears to contain a raw Anthropic API key");
  }
  if (secretValue && secretValue.trim() && serialized.includes(secretValue)) {
    return fail("output contains the raw ANTHROPIC_API_KEY secret value");
  }

  return {
    ok: true,
    reason:
      `journey completed with status "success" in ${realCallCount} real Claude call(s), all accepted on the ` +
      "first attempt, with no rejections, fallbacks, retries, or leaked secrets",
  };
}
