import type { Decision, ReasoningContext, ReasoningProvider } from "./reasoningProvider.js";
import { ReasoningModelError, type ReasoningModelClient } from "./reasoningModelClient.js";
import { buildClaudeDecisionSchema, type ClaudeDecisionPayload } from "./claudeDecisionSchema.js";
import { buildReasoningPrompt } from "./promptBuilder.js";
import { validateClaudeDecision } from "./validateClaudeDecision.js";
import { readClaudeReasoningConfig, type ClaudeReasoningConfig } from "./config.js";
import { createAnthropicReasoningModelClient } from "./anthropicReasoningModelClient.js";

export interface ClaudeDecisionLogEntry {
  timestamp: string;
  provider: "claude";
  model: string;
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
   * provider, model, latency, retry count — see task requirement #15). Deliberately
   * not wired into TaskResponse/captures: that would be a task-response.schema.json
   * contract change, out of scope for this task (see README "deliberately
   * unimplemented"). Callers that want this metadata (e.g. the API runner, or a test)
   * can pass a sink here, or read getDecisionLog() after a run.
   */
  onDecisionLogged?: (entry: ClaudeDecisionLogEntry) => void;
}

const FALLBACK_ACTION_TYPE = "stop_blocked";

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
    if (context.allowedActions.length === 0) {
      return this.fallback("no_allowed_actions");
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
          this.log({ attempt, outcome: "rejected", reason: lastReason, latencyMs, usage: result.usage });
          continue;
        }

        const validation = validateClaudeDecision(result.parsedOutput, context, this.config.minConfidence);
        if (!validation.valid) {
          lastReason = validation.reason;
          this.log({
            attempt,
            outcome: "rejected",
            reason: lastReason,
            confidence: result.parsedOutput.confidence,
            latencyMs,
            usage: result.usage,
          });
          continue;
        }

        this.log({ attempt, outcome: "accepted", confidence: validation.confidence, latencyMs, usage: result.usage });
        return {
          action: validation.action,
          rationale: `${validation.reason} (Claude confidence ${validation.confidence.toFixed(2)})`,
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        lastReason = error instanceof ReasoningModelError ? error.category : "provider_error";
        this.log({ attempt, outcome: "error", reason: lastReason, latencyMs });
      }
    }

    return this.fallback(lastReason);
  }

  private fallback(reason: string): Decision {
    this.log({ attempt: -1, outcome: "fallback", reason, latencyMs: 0 });
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
