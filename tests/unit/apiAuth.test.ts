import { test } from "node:test";
import assert from "node:assert/strict";

import { isAuthorized, readApiAuthConfig, MissingApiTokenError } from "../../src/api/auth.js";

test("readApiAuthConfig returns the configured token when present", () => {
  const config = readApiAuthConfig({ NAVIGATION_ENGINE_API_TOKEN: "a-real-token" });
  assert.equal(config.token, "a-real-token");
});

test("readApiAuthConfig throws MissingApiTokenError when the token is missing outside test mode", () => {
  assert.throws(() => readApiAuthConfig({ NODE_ENV: "production" }), MissingApiTokenError);
  assert.throws(() => readApiAuthConfig({}), MissingApiTokenError);
});

test("readApiAuthConfig throws when the token is only whitespace, even in test mode", () => {
  assert.throws(() => readApiAuthConfig({ NODE_ENV: "production", NAVIGATION_ENGINE_API_TOKEN: "   " }), MissingApiTokenError);
});

test("readApiAuthConfig does not throw in test mode when the token is missing (fails closed instead)", () => {
  const config = readApiAuthConfig({ NODE_ENV: "test" });
  assert.equal(config.token, undefined);
});

test("MissingApiTokenError never includes any token value in its message", () => {
  try {
    readApiAuthConfig({ NODE_ENV: "production" });
    assert.fail("expected readApiAuthConfig to throw");
  } catch (err) {
    assert.ok(err instanceof MissingApiTokenError);
    assert.doesNotMatch(err.message, /Bearer/i);
  }
});

test("isAuthorized accepts a matching bearer token", () => {
  const config = { token: "correct-token-value" };
  assert.equal(isAuthorized("Bearer correct-token-value", config), true);
});

test("isAuthorized rejects a missing Authorization header", () => {
  const config = { token: "correct-token-value" };
  assert.equal(isAuthorized(undefined, config), false);
});

test("isAuthorized rejects a mismatched token", () => {
  const config = { token: "correct-token-value" };
  assert.equal(isAuthorized("Bearer wrong-token-value", config), false);
});

test("isAuthorized rejects a token that is a prefix/near-miss of the correct one", () => {
  const config = { token: "correct-token-value" };
  assert.equal(isAuthorized("Bearer correct-token-valu", config), false);
  assert.equal(isAuthorized("Bearer correct-token-value-extra", config), false);
});

test("isAuthorized rejects malformed Authorization headers", () => {
  const config = { token: "correct-token-value" };
  assert.equal(isAuthorized("correct-token-value", config), false);
  assert.equal(isAuthorized("Basic correct-token-value", config), false);
  assert.equal(isAuthorized("Bearer", config), false);
  assert.equal(isAuthorized("Bearer ", config), false);
  assert.equal(isAuthorized("BearerXcorrect-token-value", config), false);
  assert.equal(isAuthorized("", config), false);
});

test("isAuthorized always rejects when no token is configured, even against an empty header", () => {
  const config = { token: undefined };
  assert.equal(isAuthorized(undefined, config), false);
  assert.equal(isAuthorized("Bearer anything", config), false);
});
