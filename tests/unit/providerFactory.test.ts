import { test } from "node:test";
import assert from "node:assert/strict";

import { createReasoningProvider, UnsupportedReasoningProviderError } from "../../src/reasoning/providerFactory.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import { MissingApiKeyError } from "../../src/reasoning/config.js";

test("defaults to MockReasoningProvider when REASONING_PROVIDER is unset", () => {
  const provider = createReasoningProvider({});
  assert.ok(provider instanceof MockReasoningProvider);
});

test("defaults to MockReasoningProvider when REASONING_PROVIDER is empty", () => {
  const provider = createReasoningProvider({ REASONING_PROVIDER: "   " });
  assert.ok(provider instanceof MockReasoningProvider);
});

test("REASONING_PROVIDER=mock selects MockReasoningProvider explicitly", () => {
  const provider = createReasoningProvider({ REASONING_PROVIDER: "mock" });
  assert.ok(provider instanceof MockReasoningProvider);
});

test("REASONING_PROVIDER=claude selects ClaudeReasoningProvider when ANTHROPIC_API_KEY is set", () => {
  const provider = createReasoningProvider({
    REASONING_PROVIDER: "claude",
    ANTHROPIC_API_KEY: "test-fake-key-never-a-real-credential",
  });
  assert.ok(provider instanceof ClaudeReasoningProvider);
});

test("REASONING_PROVIDER=claude fails clearly (not a silent mock fallback) when ANTHROPIC_API_KEY is missing", () => {
  assert.throws(() => createReasoningProvider({ REASONING_PROVIDER: "claude" }), MissingApiKeyError);
});

test("an unsupported REASONING_PROVIDER value fails clearly instead of silently defaulting", () => {
  assert.throws(
    () => createReasoningProvider({ REASONING_PROVIDER: "gpt4" }),
    UnsupportedReasoningProviderError,
  );
});
