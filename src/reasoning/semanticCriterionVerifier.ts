import type { ClaudeReasoningConfig } from "./config.js";
import { createAnthropicReasoningModelClient } from "./anthropicReasoningModelClient.js";
import type { ReasoningModelClient } from "./reasoningModelClient.js";
import { buildSemanticVerificationSchema, type SemanticVerificationPayload } from "./semanticVerificationSchema.js";
import type { SemanticVerifierDecisionSummary, SemanticVerifierDiagnostics } from "../types/task-response.js";

export const SEMANTIC_VERIFIER_DIAGNOSTICS_VERSION = "1.0.0" as const;

// A verdict must clear this bar *and* cite non-empty evidence to count as satisfied --
// deliberately stricter than ClaudeReasoningProvider's navigation-decision minConfidence
// (0.5 default): this gate grants a *required* success criterion, so a low-confidence
// "yes" must never quietly pass. Not part of the task-request contract (task requirement:
// never require the caller/n8n to supply anything new) -- purely an engine-operator
// tuning knob, overridable the same way CLAUDE_MIN_CONFIDENCE already is.
export const DEFAULT_SEMANTIC_MIN_CONFIDENCE = 0.7;

/**
 * Structurally identical to (but intentionally decoupled from) src/core/semanticPageMatch.ts's
 * SemanticPageSignals -- this module stays a pure, testable reasoning-layer component with
 * no dependency on src/core or Playwright. Callers (src/core/successEvaluator.ts) already
 * have a value of this exact shape and pass it straight through.
 */
export interface SemanticPageEvidence {
  title: string;
  headings: string[];
  interactiveText: string[];
}

export interface SemanticVerificationInput {
  /** The task's objective text, verbatim -- may be written in any language. */
  objective: string;
  /** The criterion's own description text, verbatim -- may be written in any language. */
  criterionDescription: string;
  /** Compact page evidence already safe to send to a model -- never raw HTML. */
  pageEvidence: SemanticPageEvidence;
}

export interface SemanticVerificationOutcome {
  satisfied: boolean;
  confidence: number;
  evidence: string;
}

/**
 * Bounded, structured-output adjudicator for a semantic_page_match criterion the
 * deterministic (lexical token-overlap) evaluator could not resolve -- most notably when
 * the objective and the destination page are written in different languages, where literal
 * word overlap is not a reliable signal at all. Entirely separate from navigation
 * decisions (ReasoningProvider.decide): this never selects an action, never sees
 * allowedActions/allowedDomains/limits, and cannot itself move the run or influence safety
 * policy -- it only classifies whether given page evidence matches given objective text.
 */
export interface SemanticCriterionVerifier {
  verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome>;
  getUsageDiagnostics?(): SemanticVerifierDiagnostics;
}

interface DecisionLogEntry {
  attempt: number;
  outcome: "satisfied" | "not_satisfied" | "error" | "cache_hit";
  confidence?: number;
  evidence?: string;
  latencyMs: number;
  usage?: { inputTokens?: number; outputTokens?: number };
}

function buildPrompt(input: SemanticVerificationInput): { system: string; user: string } {
  const system =
    "You verify whether page evidence describes having reached a described target state. " +
    "The objective/description and the page evidence may be written in different languages " +
    "-- compare their real-world MEANING, not their literal words; a page in one language can " +
    "correctly satisfy an objective written in another. Base your answer only on the page " +
    "evidence given to you here (title, headings, visible interactive-element text) -- never " +
    "assume or invent content that is not present. Generic words alone (e.g. a single shared " +
    "word like \"vehicle\" or \"continue\") are not sufficient evidence by themselves; require " +
    "the page evidence, taken together, to genuinely correspond to the specific state " +
    "described. Never output an action, URL, selector, or code. Give an honest confidence for " +
    "how sure you are, and always cite the specific page evidence (a short quote) that " +
    "supports your verdict, even when the verdict is that the page does not match.";

  const payload = {
    objective: input.objective,
    criterionDescription: input.criterionDescription,
    pageEvidence: {
      title: input.pageEvidence.title,
      headings: input.pageEvidence.headings,
      interactiveElementText: input.pageEvidence.interactiveText,
    },
  };

  return { system, user: JSON.stringify(payload) };
}

function buildCacheKey(input: SemanticVerificationInput): string {
  return JSON.stringify({
    objective: input.objective,
    criterionDescription: input.criterionDescription,
    title: input.pageEvidence.title,
    headings: input.pageEvidence.headings,
    interactiveText: input.pageEvidence.interactiveText,
  });
}

function toDecisionSummary(entry: DecisionLogEntry): SemanticVerifierDecisionSummary {
  return {
    attempt: entry.attempt,
    outcome: entry.outcome,
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    ...(entry.evidence !== undefined ? { evidence: entry.evidence } : {}),
    ...(entry.usage?.inputTokens !== undefined ? { inputTokens: entry.usage.inputTokens } : {}),
    ...(entry.usage?.outputTokens !== undefined ? { outputTokens: entry.usage.outputTokens } : {}),
    latencyMs: entry.latencyMs,
  };
}

export interface ClaudeSemanticCriterionVerifierOptions {
  config: ClaudeReasoningConfig;
  modelClient?: ReasoningModelClient;
  minConfidence?: number;
}

/**
 * Real, Claude-backed SemanticCriterionVerifier. Reuses the exact same SDK-agnostic
 * ReasoningModelClient boundary, structured-output pattern, and single-retry policy as
 * ClaudeReasoningProvider (see anthropicReasoningModelClient.ts) -- same auth, same model
 * config, no new external dependency -- but with its own prompt/schema/decision log, so a
 * navigation decision and a success-criterion verification are never the same model call.
 * Caches by (objective, criterion description, page evidence): identical evidence is never
 * re-verified, so repeated stop_success attempts on an unchanged page cost at most one call.
 * Fails closed on any malformed output, low confidence, missing evidence, or provider
 * error -- a criterion is never satisfied by an unsupported or failed assertion.
 */
export class ClaudeSemanticCriterionVerifier implements SemanticCriterionVerifier {
  private readonly config: ClaudeReasoningConfig;
  private readonly modelClient: ReasoningModelClient;
  private readonly minConfidence: number;
  private readonly cache = new Map<string, SemanticVerificationOutcome>();
  private readonly decisionLog: DecisionLogEntry[] = [];

  constructor(options: ClaudeSemanticCriterionVerifierOptions) {
    this.config = options.config;
    this.modelClient = options.modelClient ?? createAnthropicReasoningModelClient(options.config);
    this.minConfidence = options.minConfidence ?? DEFAULT_SEMANTIC_MIN_CONFIDENCE;
  }

  async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
    const cacheKey = buildCacheKey(input);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.log({ attempt: -1, outcome: "cache_hit", confidence: cached.confidence, evidence: cached.evidence, latencyMs: 0 });
      return cached;
    }

    const schema = buildSemanticVerificationSchema();
    const prompt = buildPrompt(input);
    const attempts = 1 + this.config.maxRetries;
    let outcome: SemanticVerificationOutcome = { satisfied: false, confidence: 0, evidence: "" };

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const result = await this.modelClient.createDecision<SemanticVerificationPayload>({
          model: this.config.model,
          maxOutputTokens: this.config.maxOutputTokens,
          timeoutMs: this.config.timeoutMs,
          system: prompt.system,
          userPrompt: prompt.user,
          outputSchema: schema,
        });
        const latencyMs = Date.now() - startedAt;

        if (!result.parsedOutput) {
          this.log({ attempt, outcome: "error", latencyMs, usage: result.usage });
          continue;
        }

        const payload = result.parsedOutput;
        const satisfied = payload.satisfied && payload.confidence >= this.minConfidence && payload.evidence.trim().length > 0;
        outcome = { satisfied, confidence: payload.confidence, evidence: payload.evidence };
        this.log({
          attempt,
          outcome: satisfied ? "satisfied" : "not_satisfied",
          confidence: payload.confidence,
          evidence: payload.evidence,
          latencyMs,
          usage: result.usage,
        });
        this.cache.set(cacheKey, outcome);
        return outcome;
      } catch {
        const latencyMs = Date.now() - startedAt;
        this.log({ attempt, outcome: "error", latencyMs });
      }
    }

    // Every attempt was exhausted without a usable result: fail closed, never satisfied.
    this.cache.set(cacheKey, outcome);
    return outcome;
  }

  getUsageDiagnostics(): SemanticVerifierDiagnostics {
    const entries = this.decisionLog;
    const realCalls = entries.filter((entry) => entry.attempt >= 0);
    const retries = entries.filter((entry) => entry.attempt >= 1);
    const cacheHits = entries.filter((entry) => entry.outcome === "cache_hit");

    return {
      version: SEMANTIC_VERIFIER_DIAGNOSTICS_VERSION,
      provider: "claude",
      model: this.config.model,
      callCount: realCalls.length,
      cacheHitCount: cacheHits.length,
      satisfiedCount: entries.filter((entry) => entry.outcome === "satisfied").length,
      rejectedCount: entries.filter((entry) => entry.outcome === "not_satisfied" || entry.outcome === "error").length,
      totalInputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.inputTokens ?? 0), 0),
      totalOutputTokens: entries.reduce((sum, entry) => sum + (entry.usage?.outputTokens ?? 0), 0),
      totalLatencyMs: entries.reduce((sum, entry) => sum + entry.latencyMs, 0),
      retryCount: retries.length,
      ...(entries.length > 0 ? { decisions: entries.map(toDecisionSummary) } : {}),
    };
  }

  private log(entry: DecisionLogEntry): void {
    this.decisionLog.push(entry);
  }
}
