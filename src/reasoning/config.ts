// Reads env-based configuration for ClaudeReasoningProvider. Never logs the API key —
// only whether it is present. See .env.example for the full list of variables.

export interface ClaudeReasoningConfig {
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
  minConfidence: number;
}

// claude-sonnet-5 is the documented default: this provider is called once per navigation
// step (potentially many times per run), so a lower-cost/lower-latency model is the
// conservative choice for a single structured decision. Override via CLAUDE_MODEL for
// tasks that need stronger reasoning.
export const DEFAULT_CLAUDE_MODEL = "claude-sonnet-5";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MIN_CONFIDENCE = 0.5;

// Mirrors the maxSteps/maxBacktracks pattern in src/safety: a hard ceiling enforced
// regardless of configuration, so a misconfigured env var can never turn "retry once"
// into an unbounded retry loop.
const HARD_MAX_RETRIES = 1;

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "ANTHROPIC_API_KEY is required when REASONING_PROVIDER=claude. Set it in your environment " +
        "(see .env.example) — never commit it to source.",
    );
    this.name = "MissingApiKeyError";
  }
}

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function readClaudeReasoningConfig(env: NodeJS.ProcessEnv = process.env): ClaudeReasoningConfig {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new MissingApiKeyError();
  }

  return {
    apiKey,
    model: env.CLAUDE_MODEL?.trim() || DEFAULT_CLAUDE_MODEL,
    maxOutputTokens: readNumber(env.CLAUDE_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS, 64, 4096),
    timeoutMs: readNumber(env.CLAUDE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1000, 60000),
    maxRetries: Math.min(HARD_MAX_RETRIES, readNumber(env.CLAUDE_MAX_RETRIES, DEFAULT_MAX_RETRIES, 0, HARD_MAX_RETRIES)),
    minConfidence: readNumber(env.CLAUDE_MIN_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, 0, 1),
  };
}
