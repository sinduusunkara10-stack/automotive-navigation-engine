import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ClaudeReasoningConfig } from "./config.js";
import {
  ReasoningModelError,
  type ReasoningModelClient,
  type ReasoningModelRequest,
  type ReasoningModelResult,
} from "./reasoningModelClient.js";

// Maps real SDK exceptions to a small, sanitised category set. Never forwards
// error.message across this boundary — the real Anthropic client is constructed with
// the caller-supplied API key, and SDK error messages are not a place this code
// chooses to trust not to echo request/response details.
function sanitizeError(error: unknown): ReasoningModelError {
  if (error instanceof Anthropic.AuthenticationError) return new ReasoningModelError("authentication_failed");
  if (error instanceof Anthropic.PermissionDeniedError) return new ReasoningModelError("permission_denied");
  if (error instanceof Anthropic.NotFoundError) return new ReasoningModelError("not_found");
  if (error instanceof Anthropic.RateLimitError) return new ReasoningModelError("rate_limited");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ReasoningModelError("timeout");
  if (error instanceof Anthropic.APIConnectionError) return new ReasoningModelError("connection_error");
  if (error instanceof Anthropic.BadRequestError) return new ReasoningModelError("bad_request");
  if (error instanceof Anthropic.APIError) return new ReasoningModelError(`api_error_${error.status ?? "unknown"}`);
  return new ReasoningModelError("provider_error");
}

/**
 * Thin adapter over the official @anthropic-ai/sdk client, implementing the
 * SDK-agnostic ReasoningModelClient boundary. This is the only file in the engine that
 * imports @anthropic-ai/sdk.
 */
export function createAnthropicReasoningModelClient(config: ClaudeReasoningConfig): ReasoningModelClient {
  // SDK-level retries are disabled: ClaudeReasoningProvider owns the single retry
  // policy (hard-capped at one), so retry behavior stays predictable and bounded.
  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs });

  return {
    async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
      try {
        const response = await client.messages.parse(
          {
            model: request.model,
            max_tokens: request.maxOutputTokens,
            system: request.system,
            messages: [{ role: "user", content: request.userPrompt }],
            // effort: "low" — conservative default for a single structured navigation
            // decision (this call happens once per step, potentially many times per run).
            output_config: { format: zodOutputFormat(request.outputSchema), effort: "low" },
          },
          { timeout: request.timeoutMs },
        );

        return {
          parsedOutput: response.parsed_output ?? null,
          stopReason: response.stop_reason ?? "unknown",
          usage: {
            inputTokens: response.usage?.input_tokens,
            outputTokens: response.usage?.output_tokens,
          },
        };
      } catch (error) {
        throw sanitizeError(error);
      }
    },
  };
}
