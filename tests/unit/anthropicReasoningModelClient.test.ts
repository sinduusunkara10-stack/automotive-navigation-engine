import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";

import { sanitizeError } from "../../src/reasoning/anthropicReasoningModelClient.js";
import { ReasoningModelError } from "../../src/reasoning/reasoningModelClient.js";

// ---------------------------------------------------------------------------------------
// FIX (CONFIRMED ISSUE 2, run_a9eb40df-0191-44af-9ce9-acdcab7e8bb5): sanitizeError's final
// catch-all ("provider_error") swallowed two well-known, safely-distinguishable failure
// shapes -- the Anthropic SDK's zodOutputFormat().parse() helper (invoked internally by
// client.messages.parse()) throws a bare Anthropic.AnthropicError, never an APIError
// subclass, when the model's raw output isn't valid JSON at all, or when it parses but
// fails the requested decision schema -- so neither case was ever caught by the existing
// instanceof checks (all of which target APIError and its HTTP-status-carrying
// subclasses). These tests construct the real Anthropic SDK error classes directly (no
// network, no API key, no live model call) and assert on sanitizeError's returned
// category only -- never on any message content -- matching the file's own stated policy
// of never forwarding error.message across this boundary.
// ---------------------------------------------------------------------------------------

test("provider HTTP failure: an authentication error is classified precisely, not as provider_error", () => {
  const error = new Anthropic.AuthenticationError(401, { type: "error" }, "unauthorized", new Headers());
  const result = sanitizeError(error);
  assert.ok(result instanceof ReasoningModelError);
  assert.equal(result.category, "authentication_failed");
});

test("provider HTTP failure: a rate-limit error is classified precisely, not as provider_error", () => {
  const error = new Anthropic.RateLimitError(429, { type: "error" }, "too many requests", new Headers());
  const result = sanitizeError(error);
  assert.equal(result.category, "rate_limited");
});

test("provider HTTP failure: an unmapped 5xx server error still carries its status, not as provider_error", () => {
  const error = new Anthropic.InternalServerError(503, { type: "error" }, "service unavailable", new Headers());
  const result = sanitizeError(error);
  assert.equal(result.category, "api_error_503");
});

test("timeout: a connection-timeout error is classified precisely, not as provider_error", () => {
  const error = new Anthropic.APIConnectionTimeoutError();
  const result = sanitizeError(error);
  assert.equal(result.category, "timeout");
});

test("FIX (issue 2): a malformed/invalid decision response -- raw output isn't valid JSON at all -- is classified as response_parse_failed, not provider_error", () => {
  const error = new Anthropic.AnthropicError(
    "Failed to parse structured output as JSON: Unexpected token 'x', \"xyz not json\" is not valid JSON",
  );
  const result = sanitizeError(error);
  assert.equal(result.category, "response_parse_failed");
});

test("FIX (issue 2): a malformed/invalid decision response -- valid JSON but fails the decision schema -- is classified as response_schema_invalid, not provider_error", () => {
  const error = new Anthropic.AnthropicError(
    "Failed to parse structured output: Invalid input\nValidation issues:\n  - action: Invalid enum value. Expected 'click' | 'scroll', received 'unknown_action'",
  );
  const result = sanitizeError(error);
  assert.equal(result.category, "response_schema_invalid");
});

test("an AnthropicError with an unrecognised message shape safely degrades to provider_error rather than misclassifying", () => {
  const error = new Anthropic.AnthropicError("some future SDK error shape this code has never seen before");
  const result = sanitizeError(error);
  assert.equal(result.category, "provider_error");
});

test("a genuinely unknown, non-SDK error safely falls back to provider_error as the last resort", () => {
  const error = new Error("an entirely unrelated runtime error");
  const result = sanitizeError(error);
  assert.equal(result.category, "provider_error");
});

test("sanitisation: the classification never includes any fragment of the underlying error message", () => {
  const secretLookingMessage = "Failed to parse structured output as JSON: sk-ant-fake-secret-should-never-leak-12345";
  const error = new Anthropic.AnthropicError(secretLookingMessage);
  const result = sanitizeError(error);
  assert.equal(result.category, "response_parse_failed");
  assert.ok(!result.category.includes("sk-ant-fake-secret"));
  assert.ok(!JSON.stringify(result).includes("sk-ant-fake-secret"));
});
