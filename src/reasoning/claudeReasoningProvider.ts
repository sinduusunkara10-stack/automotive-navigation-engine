import type { Decision, ReasoningContext, ReasoningProvider } from "./reasoningProvider.js";
import { REASONING_PROVIDER_DIAGNOSTICS_VERSION } from "./reasoningProvider.js";
import { ReasoningModelError, type ReasoningModelClient } from "./reasoningModelClient.js";
import { buildClaudeDecisionSchema, type ClaudeDecisionPayload } from "./claudeDecisionSchema.js";
import { buildReasoningPrompt } from "./promptBuilder.js";
import { validateClaudeDecision } from "./validateClaudeDecision.js";
import { readClaudeReasoningConfig, type ClaudeReasoningConfig } from "./config.js";
import { createAnthropicReasoningModelClient } from "./anthropicReasoningModelClient.js";
import type { ReasoningProviderDiagnostics, ReasoningProviderDecisionSummary } from "../types/task-response.js";

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

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const result = await this.modelClient.createDecision<ClaudeDecisionPayload>({
          model: this.config.model,
          maxOutputTokens: this.config.maxOutputTokens,
          timeoutMs: this.config.timeoutMs,
          system: prompt.system,
          userPrompt: prompt.user,
          outputSchema: schema,
        });
        const latencyMs = Date.now() - startedAt;

        if (!result.parsedOutput) {
          lastReason = result.stopReason === "refusal" ? "refusal" : "malformed_output";
          this.log({ stepIndex, attempt, outcome: "rejected", reason: lastReason, latencyMs, usage: result.usage });
          continue;
        }

        const validation = validateClaudeDecision(result.parsedOutput, context, this.config.minConfidence);
        if (!validation.valid) {
          lastReason = validation.reason;
          this.log({
            stepIndex,
            attempt,
            outcome: "rejected",
            reason: lastReason,
            confidence: result.parsedOutput.confidence,
            latencyMs,
            usage: result.usage,
          });
          continue;
        }

        this.log({
          stepIndex,
          attempt,
          outcome: "accepted",
          confidence: validation.confidence,
          latencyMs,
          usage: result.usage,
        });
        return {
          action: validation.action,
          rationale: `${validation.reason} (Claude confidence ${validation.confidence.toFixed(2)})`,
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        lastReason = error instanceof ReasoningModelError ? error.category : "provider_error";
        this.log({ stepIndex, attempt, outcome: "error", reason: lastReason, latencyMs });
      }
    }

    return this.fallback(lastReason, stepIndex);
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

  private fallback(reason: string, stepIndex: number): Decision {
    this.log({ stepIndex, attempt: -1, outcome: "fallback", reason, latencyMs: 0 });
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
