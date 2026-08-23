import { MockReasoningProvider } from "./mockReasoningProvider.js";
import { ClaudeReasoningProvider } from "./claudeReasoningProvider.js";
import { readClaudeReasoningConfig } from "./config.js";
import type { ReasoningProvider } from "./reasoningProvider.js";

const SUPPORTED_PROVIDERS = ["mock", "claude"] as const;
type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export class UnsupportedReasoningProviderError extends Error {
  constructor(value: string) {
    super(
      `Unsupported REASONING_PROVIDER "${value}". Supported values are: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
    this.name = "UnsupportedReasoningProviderError";
  }
}

function isSupportedProvider(value: string): value is SupportedProvider {
  return (SUPPORTED_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Selects the reasoning provider from REASONING_PROVIDER. A missing/empty value
 * defaults safely to the mock provider (task requirement #2); an explicit but
 * unsupported value fails clearly rather than silently falling back, so a typo never
 * silently runs the wrong provider. "claude" additionally requires ANTHROPIC_API_KEY
 * (enforced by readClaudeReasoningConfig below) — that failure is also clear, never a
 * silent mock fallback.
 */
export function createReasoningProvider(env: NodeJS.ProcessEnv = process.env): ReasoningProvider {
  const raw = env.REASONING_PROVIDER?.trim();
  if (!raw) {
    return new MockReasoningProvider();
  }
  if (!isSupportedProvider(raw)) {
    throw new UnsupportedReasoningProviderError(raw);
  }
  if (raw === "claude") {
    return new ClaudeReasoningProvider({ config: readClaudeReasoningConfig(env) });
  }
  return new MockReasoningProvider();
}
