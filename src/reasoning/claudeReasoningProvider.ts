import type { Decision, ReasoningContext, ReasoningProvider } from "./reasoningProvider.js";
import { REASONING_PROVIDER_DIAGNOSTICS_VERSION } from "./reasoningProvider.js";
import { ReasoningModelError, type ReasoningModelClient } from "./reasoningModelClient.js";
import { buildClaudeDecisionSchema, type ClaudeDecisionPayload } from "./claudeDecisionSchema.js";
import { buildReasoningPrompt, type PromptElementSelectionDiagnostic } from "./promptBuilder.js";
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

// The two sanitised categories that indicate the model's response itself was unusable
// (not valid JSON, or JSON that failed the decision schema) rather than a transport/HTTP
// failure -- see anthropicReasoningModelClient.ts's sanitizeError. Only these two ever
// trigger the bounded corrective retry below; every other error category (auth, rate
// limit, timeout, connection, bad request, etc.) is left to whatever the existing
// maxRetries policy already does, unchanged.
const CORRECTIVE_RETRY_CATEGORIES: ReadonlySet<string> = new Set([
  RESPONSE_PARSE_FAILED_CATEGORY,
  RESPONSE_SCHEMA_INVALID_CATEGORY,
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

      // REGRESSION (run_57ca85c3-df96-4dcc-be6f-c3be55a202f1): PR #36 correctly classified
      // a response_schema_invalid/response_parse_failed failure but never changed anything
      // before the (already-existing, generic) retry, which simply resent the identical
      // prompt and predictably failed the same way again -- the run fell straight to
      // stop_blocked without ever giving the model a corrective signal. On the first
      // occurrence of either category, one bounded corrective retry is issued instead: the
      // exact same observation-derived prompt.user (never rescanned, never re-selected --
      // items 3/4) plus a short system-prompt addendum stating the previous response was
      // invalid and restating only the allowed-action vocabulary (never the raw invalid
      // response, never any provider payload -- items 2/5/6). Whatever this one corrective
      // attempt produces (success or failure) is final for this failure category this
      // step -- the loop never falls through to a second, blind generic retry on top of it.
      if (!correctiveRetryUsed && CORRECTIVE_RETRY_CATEGORIES.has(outcome.reason)) {
        correctiveRetryUsed = true;
        const correctiveOutcome = await this.attemptOnce({
          context,
          schema,
          stepIndex,
          attempt: attempt + 1,
          systemPrompt: buildCorrectiveSystemPrompt(prompt.system, context.allowedActions),
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
