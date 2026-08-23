// SDK-agnostic boundary between ClaudeReasoningProvider and whatever actually talks to
// the Claude API. ClaudeReasoningProvider only depends on this interface, so tests can
// inject a deterministic fake implementation (see tests/unit/fakes) with no network
// access, no API key, and no Claude usage. Errors crossing this boundary are always a
// ReasoningModelError carrying a sanitised category — never a raw SDK error, so a
// provider-specific message (which could echo request details) never reaches callers.
import type { z } from "zod/v4";

export class ReasoningModelError extends Error {
  readonly category: string;

  constructor(category: string) {
    super(category);
    this.name = "ReasoningModelError";
    this.category = category;
  }
}

export interface ReasoningModelUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ReasoningModelRequest<TPayload> {
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  system: string;
  userPrompt: string;
  outputSchema: z.ZodType<TPayload>;
}

export interface ReasoningModelResult<TPayload> {
  parsedOutput: TPayload | null;
  stopReason: string;
  usage: ReasoningModelUsage;
}

export interface ReasoningModelClient {
  createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>>;
}
