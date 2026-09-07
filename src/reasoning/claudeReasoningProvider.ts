import type { Decision, ReasoningContext, ReasoningProvider } from "./reasoningProvider.js";
import { REASONING_PROVIDER_DIAGNOSTICS_VERSION } from "./reasoningProvider.js";
import { ReasoningModelError, type ReasoningModelClient } from "./reasoningModelClient.js";
import { buildClaudeDecisionSchema, type ClaudeDecisionPayload } from "./claudeDecisionSchema.js";
import {
  buildReasoningPrompt,
  computeInstructionProgress,
  type InstructionPosition,
  type InstructionProgress,
  type PromptElementSelectionDiagnostic,
} from "./promptBuilder.js";
import { validateClaudeDecision } from "./validateClaudeDecision.js";
import { readClaudeReasoningConfig, type ClaudeReasoningConfig } from "./config.js";
import {
  createAnthropicReasoningModelClient,
  RESPONSE_PARSE_FAILED_CATEGORY,
  RESPONSE_SCHEMA_INVALID_CATEGORY,
} from "./anthropicReasoningModelClient.js";
import type { ReasoningProviderDiagnostics, ReasoningProviderDecisionSummary } from "../types/task-response.js";
import type { ActionType } from "../types/actions.js";

export interface ClaudeDecisionLogEntry {
  timestamp: string;
  provider: "claude";
  model: string;
  stepIndex?: number;
  attempt: number;
  outcome: "accepted" | "rejected" | "error" | "fallback";
  reason?: string;
  confidence?: number;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
  /**
   * Bounded diagnostic explaining which interactive elements were actually included in
   * *this* attempt's prompt and why (see src/reasoning/promptBuilder.ts) -- lets a caller
   * confirm whether a specific element (e.g. one visible in StepLog.observation) actually
   * reached the model, without having to reconstruct the selection logic themselves.
   */
  elementSelection?: PromptElementSelectionDiagnostic;
  /**
   * True only for the one bounded corrective retry issued after a response_schema_invalid/
   * response_parse_failed failure (see decide() below). Internal-only -- never forwarded to
   * ReasoningProviderDecisionSummary/the response schema -- exists purely so a caller of
   * getDecisionLog() (e.g. a test) can distinguish this attempt from an ordinary retry
   * without having to infer it from the attempt number.
   */
  correctiveRetry?: boolean;
}

// The rejection reasons that get exactly one bounded, targeted corrective retry: the two
// sanitised categories indicating the model's response itself was unusable (not valid
// JSON, or JSON that failed the decision schema -- see anthropicReasoningModelClient.ts's
// sanitizeError), plus "low_confidence" -- a structurally valid decision (allowed action,
// resolvable target, allowed navigate host; see validateClaudeDecision.ts, which checks
// confidence last for exactly this reason) that was only rejected because its stated
// confidence fell short of this run's minimum. All three share one retry budget (item 11
// of the fix): at most one corrective attempt total per decide() call, whichever of the
// three reasons triggers it first. Every other rejection/error reason (auth, rate limit,
// timeout, connection, bad request, unknown target, disallowed action, etc.) is left to
// whatever the existing, generic maxRetries policy already does, unchanged.
const CORRECTIVE_RETRY_REASONS: ReadonlySet<string> = new Set([
  RESPONSE_PARSE_FAILED_CATEGORY,
  RESPONSE_SCHEMA_INVALID_CATEGORY,
  "low_confidence",
]);

type AttemptOutcome =
  | { kind: "success"; decision: Decision }
  | { kind: "failure"; reason: string };

/**
 * Builds the one-shot corrective retry's system prompt: the original system prompt
 * (unchanged, so every other instruction -- objective handling, safety wording, consent
 * policy, etc. -- still applies) plus a short, fully generic addendum appended at the end.
 * The addendum states only that the previous response was invalid and restates the exact
 * allowed-action vocabulary -- never the raw invalid response, never a provider payload,
 * never brand/site-specific wording (item 2/5/6/12 of the fix). The actual JSON schema
 * itself is unchanged and still passed structurally via outputSchema on every attempt
 * (including this one) -- this addendum only reinforces it in plain language.
 */
function buildCorrectiveSystemPrompt(baseSystem: string, allowedActions: readonly ActionType[]): string {
  return (
    baseSystem +
    " Your previous response could not be used: it was not valid JSON, or it did not conform to the " +
    "required decision schema you were given. This is a one-time corrective retry -- respond with exactly " +
    "one JSON object that strictly conforms to that schema, choosing \"action\" only from this exact " +
    `allowed vocabulary: ${JSON.stringify(allowedActions)}. Include nothing outside the JSON object, and ` +
    "never invent a field or action that isn't part of the schema you were given."
  );
}

function describeInstructionPositionForCorrection(position?: InstructionPosition): string {
  return position ? position.descriptions.join(" OR ") : "none";
}

/**
 * Builds the one-shot low-confidence corrective retry's system prompt: the original
 * system prompt plus a short, fully generic addendum stating only that the previous
 * decision was rejected for confidence alone, and restating the same completed/earliest-
 * unfinished/pending/terminal instruction partition already computed for the main prompt
 * (see promptBuilder.ts's computeInstructionProgress -- never recomputed differently, so
 * this always agrees with what the model was already told). Never includes the previous
 * raw response or its numeric confidence value -- only the fixed template text below and
 * caller-supplied successCriteria description text, which was already fully visible in
 * the original prompt.
 */
function buildLowConfidenceCorrectionSystemPrompt(baseSystem: string, progress: InstructionProgress): string {
  return (
    baseSystem +
    " Your previous decision was rejected only because its stated confidence was below the minimum " +
    "required for this run -- everything else about it (the action, its target, any navigation host) " +
    "was structurally fine. This is a one-time corrective retry: re-examine the exact same page evidence " +
    "you were already given and respond with the single clearest action that satisfies the earliest " +
    "unfinished required instruction. Completed instructions so far: " +
    `${progress.completed.length > 0 ? progress.completed.map(describeInstructionPositionForCorrection).join("; ") : "none yet"}. ` +
    `The earliest unfinished instruction to act on now: ${describeInstructionPositionForCorrection(progress.earliestUnfinished)}. ` +
    `Later instructions that must remain pending until then: ${progress.pending.length > 0 ? progress.pending.map(describeInstructionPositionForCorrection).join("; ") : "none"}. ` +
    `The terminal instruction (stop immediately, with the resulting URL, once it is satisfied): ${describeInstructionPositionForCorrection(progress.terminal)}. ` +
    "Give an honest confidence for this corrected choice -- do not inflate it merely to pass the threshold."
  );
}

export interface ClaudeReasoningProviderOptions {
  config?: ClaudeReasoningConfig;
  modelClient?: ReasoningModelClient;
  /**
   * Optional sink for per-decision usage/outcome metadata (input/output tokens,
   * provider, model, latency, retry count — see task requirement #15). Callers that want
   * this metadata (e.g. a test) can pass a sink here, or read getDecisionLog() after a
   * run. The same log also backs getUsageDiagnostics(), which is what the engine
   * aggregates into TaskResponse.diagnostics.reasoningProvider.
   */
  onDecisionLogged?: (entry: ClaudeDecisionLogEntry) => void;
}

const FALLBACK_ACTION_TYPE = "stop_blocked";

function toDecisionSummary(entry: ClaudeDecisionLogEntry): ReasoningProviderDecisionSummary {
  return {
    ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
    attempt: entry.attempt,
    outcome: entry.outcome,
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    ...(entry.usage?.inputTokens !== undefined ? { inputTokens: entry.usage.inputTokens } : {}),
    ...(entry.usage?.outputTokens !== undefined ? { outputTokens: entry.usage.outputTokens } : {}),
    latencyMs: entry.latencyMs,
    ...(entry.elementSelection ? { elementSelection: entry.elementSelection } : {}),
  };
}

/**
 * Real, Claude-backed ReasoningProvider. Selects an action from context.allowedActions
 * via a strict structured-output call (see anthropicReasoningModelClient.ts +
 * claudeDecisionSchema.ts), validates the result (validateClaudeDecision.ts) before
 * ever returning it, retries at most once on a malformed/invalid/errored response, and
 * falls back to a safe stop_blocked decision if no valid decision could be produced.
 * The safety layer in src/safety still re-checks whatever this returns — this provider
 * is a second line of defence, not a replacement for it.
 */
export class ClaudeReasoningProvider implements ReasoningProvider {
  private readonly config: ClaudeReasoningConfig;
  private readonly modelClient: ReasoningModelClient;
  private readonly onDecisionLogged: ((entry: ClaudeDecisionLogEntry) => void) | undefined;
  private readonly decisionLog: ClaudeDecisionLogEntry[] = [];

  constructor(options: ClaudeReasoningProviderOptions = {}) {
    this.config = options.config ?? readClaudeReasoningConfig();
    this.modelClient = options.modelClient ?? createAnthropicReasoningModelClient(this.config);
    this.onDecisionLogged = options.onDecisionLogged;
  }

  getDecisionLog(): readonly ClaudeDecisionLogEntry[] {
    return this.decisionLog;
  }

  async decide(context: ReasoningContext): Promise<Decision> {
    const stepIndex = context.limits.stepsUsed;

    if (context.allowedActions.length === 0) {
      return this.fallback("no_allowed_actions", stepIndex);
    }

    const schema = buildClaudeDecisionSchema(context.allowedActions);
    const prompt = buildReasoningPrompt(context);
    const attempts = 1 + this.config.maxRetries;
    let lastReason = "unknown_error";
    // Bounded to at most one per decide() call (item 11 of the fix), regardless of
    // maxRetries -- see CORRECTIVE_RETRY_CATEGORIES's doc comment above.
    let correctiveRetryUsed = false;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const outcome = await this.attemptOnce({
        context,
        schema,
        stepIndex,
        attempt,
        systemPrompt: prompt.system,
        userPrompt: prompt.user,
        elementSelection: prompt.elementSelection,
      });
      if (outcome.kind === "success") {
        return outcome.decision;
      }
      lastReason = outcome.reason;

      // REGRESSION (run_57ca85c3-df96-4dcc-be6f-c3be55a202f1, run_e78d8d76-b487-4ece-8e0b-a0e2fbd48b1b):
      // a response_schema_invalid/response_parse_failed failure, or a structurally valid
      // decision rejected only for confidence, used to fall straight to the generic
      // maxRetries policy (which just resends the identical prompt) or straight to
      // stop_blocked -- neither ever gave the model a corrective signal. On the first
      // occurrence of any of the three CORRECTIVE_RETRY_REASONS, one bounded corrective
      // retry is issued instead: the exact same observation-derived prompt.user (never
      // rescanned, never re-selected) plus a system-prompt addendum specific to *why* this
      // attempt failed (schema/parse -- restates the allowed-action vocabulary; low
      // confidence -- restates the completed/earliest-unfinished/pending/terminal
      // instruction partition) -- never the raw invalid response, never any provider
      // payload. Whatever this one corrective attempt produces (success or failure) is
      // final for this step -- the loop never falls through to a second, blind generic
      // retry on top of it, and all three trigger reasons share this same single budget.
      if (!correctiveRetryUsed && CORRECTIVE_RETRY_REASONS.has(outcome.reason)) {
        correctiveRetryUsed = true;
        const correctiveSystemPrompt =
          outcome.reason === "low_confidence"
            ? buildLowConfidenceCorrectionSystemPrompt(
                prompt.system,
                computeInstructionProgress(context.successCriteria, context.satisfiedCriteriaIds),
              )
            : buildCorrectiveSystemPrompt(prompt.system, context.allowedActions);
        const correctiveOutcome = await this.attemptOnce({
          context,
          schema,
          stepIndex,
          attempt: attempt + 1,
          systemPrompt: correctiveSystemPrompt,
          userPrompt: prompt.user,
          elementSelection: prompt.elementSelection,
          correctiveRetry: true,
        });
        if (correctiveOutcome.kind === "success") {
          return correctiveOutcome.decision;
        }
        lastReason = correctiveOutcome.reason;
        break;
      }
    }

    return this.fallback(lastReason, stepIndex, prompt.elementSelection);
  }

  /**
   * Performs exactly one model call, parse, and validation cycle, and logs its outcome --
   * factored out so decide()'s normal attempt loop and its one bounded corrective retry
   * (see decide() above) share identical call/validate/log behaviour, differing only in
   * which system/user prompt and attempt number they're given.
   */
  private async attemptOnce(params: {
    context: ReasoningContext;
    schema: ReturnType<typeof buildClaudeDecisionSchema>;
    stepIndex: number;
    attempt: number;
    systemPrompt: string;
    userPrompt: string;
    elementSelection?: PromptElementSelectionDiagnostic;
    correctiveRetry?: boolean;
  }): Promise<AttemptOutcome> {
    const { context, schema, stepIndex, attempt, systemPrompt, userPrompt, elementSelection, correctiveRetry } = params;
    const startedAt = Date.now();
    try {
      const result = await this.modelClient.createDecision<ClaudeDecisionPayload>({
        model: this.config.model,
        maxOutputTokens: this.config.maxOutputTokens,
        timeoutMs: this.config.timeoutMs,
        system: systemPrompt,
        userPrompt,
        outputSchema: schema,
      });
      const latencyMs = Date.now() - startedAt;

      if (!result.parsedOutput) {
        const reason = result.stopReason === "refusal" ? "refusal" : "malformed_output";
        this.log({
          stepIndex,
          attempt,
          outcome: "rejected",
          reason,
          latencyMs,
          usage: result.usage,
          elementSelection,
          ...(correctiveRetry ? { correctiveRetry } : {}),
        });
        return { kind: "failure", reason };
      }

      const validation = validateClaudeDecision(result.parsedOutput, context, this.config.minConfidence);
      if (!validation.valid) {
        this.log({
          stepIndex,
          attempt,
          outcome: "rejected",
          reason: validation.reason,
          confidence: result.parsedOutput.confidence,
          latencyMs,
          usage: result.usage,
          elementSelection,
          ...(correctiveRetry ? { correctiveRetry } : {}),
        });
        return { kind: "failure", reason: validation.reason };
      }

      this.log({
        stepIndex,
        attempt,
        outcome: "accepted",
        confidence: validation.confidence,
        latencyMs,
        usage: result.usage,
        elementSelection,
        ...(correctiveRetry ? { correctiveRetry } : {}),
      });
      return {
        kind: "success",
        decision: {
          action: validation.action,
          rationale: `${validation.reason} (Claude confidence ${validation.confidence.toFixed(2)})`,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const reason = error instanceof ReasoningModelError ? error.category : "provider_error";
      this.log({
        stepIndex,
        attempt,
        outcome: "error",
        reason,
        latencyMs,
        elementSelection,
        ...(correctiveRetry ? { correctiveRetry } : {}),
      });
      return { kind: "failure", reason };
    }
  }

  /**
   * Aggregates the existing decision log (never a second usage-tracking mechanism) into
   * the safe, per-run summary surfaced at TaskResponse.diagnostics.reasoningProvider.
   * "error" outcomes are folded into rejectedDecisionCount for the aggregate counts
   * (both represent a discarded attempt), while the per-decision `decisions` array keeps
   * the original outcome for full fidelity.
   */
  getUsageDiagnostics(): ReasoningProviderDiagnostics {
    const entries = this.decisionLog;
    const realCalls = entries.filter((entry) => entry.attempt >= 0);
    const retries = entries.filter((entry) => entry.attempt >= 1);

    return {
      version: REASONING_PROVIDER_DIAGNOSTICS_VERSION,
      provider: "claude",
      model: this.config.model,
      callCount: realCalls.length,
      acceptedDecisionCount: entries.filter((entry) => entry.outcome === "accepted").length,
      rejectedDecisionCount: entries.filter((entry) => entry.outcome === "rejected" || entry.outcome === "error")
        .length,
      fallbackDecisionCount: entries.filter((entry) => entry.outcome === "fallback").length,
      totalInputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0),
      totalOutputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0),
      totalLatencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0),
      retryCount: retries.length,
      ...(entries.length > 0 ? { decisions: entries.map(toDecisionSummary) } : {}),
    };
  }

  private fallback(reason: string, stepIndex: number, elementSelection?: PromptElementSelectionDiagnostic): Decision {
    this.log({ stepIndex, attempt: -1, outcome: "fallback", reason, latencyMs: 0, elementSelection });
    return {
      action: { type: FALLBACK_ACTION_TYPE },
      rationale: `Claude reasoning provider could not produce a valid decision (${reason}); stopping safely.`,
    };
  }

  private log(entry: Omit<ClaudeDecisionLogEntry, "timestamp" | "provider" | "model">): void {
    const full: ClaudeDecisionLogEntry = {
      timestamp: new Date().toISOString(),
      provider: "claude",
      model: this.config.model,
      ...entry,
    };
    this.decisionLog.push(full);
    this.onDecisionLogged?.(full);
  }
}
