import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_ACTION_NAVIGATION_TIMEOUT_MS,
  InvalidActionNavigationTimeoutError,
  readActionNavigationTimeoutMs,
} from "../../src/config/actionNavigationConfig.js";

test("defaults to 30000ms when ACTION_NAVIGATION_TIMEOUT_MS is unset", () => {
  assert.equal(DEFAULT_ACTION_NAVIGATION_TIMEOUT_MS, 30000);
  assert.equal(readActionNavigationTimeoutMs({}), 30000);
});

test("defaults to 30000ms when ACTION_NAVIGATION_TIMEOUT_MS is empty/whitespace", () => {
  assert.equal(readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "" }), 30000);
  assert.equal(readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "   " }), 30000);
});

test("a valid positive-integer override is honoured", () => {
  assert.equal(readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "45000" }), 45000);
  assert.equal(readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "  1000  " }), 1000);
});

test("a non-numeric override fails clearly instead of silently falling back", () => {
  assert.throws(
    () => readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "not-a-number" }),
    InvalidActionNavigationTimeoutError,
  );
});

test("zero, negative, and fractional overrides all fail clearly", () => {
  assert.throws(
    () => readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "0" }),
    InvalidActionNavigationTimeoutError,
  );
  assert.throws(
    () => readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "-5000" }),
    InvalidActionNavigationTimeoutError,
  );
  assert.throws(
    () => readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "1500.5" }),
    InvalidActionNavigationTimeoutError,
  );
});

test("an override above the hard maximum fails clearly rather than silently clamping", () => {
  assert.throws(
    () => readActionNavigationTimeoutMs({ ACTION_NAVIGATION_TIMEOUT_MS: "999999999" }),
    InvalidActionNavigationTimeoutError,
  );
});

test("InvalidActionNavigationTimeoutError never exposes unrelated environment values", () => {
  try {
    readActionNavigationTimeoutMs({
      ACTION_NAVIGATION_TIMEOUT_MS: "bogus",
      NAVIGATION_ENGINE_API_TOKEN: "should-never-appear",
      ANTHROPIC_API_KEY: "sk-ant-should-never-appear",
    });
    assert.fail("expected readActionNavigationTimeoutMs to throw");
  } catch (err) {
    assert.ok(err instanceof InvalidActionNavigationTimeoutError);
    assert.doesNotMatch(err.message, /should-never-appear/);
    assert.doesNotMatch(err.message, /sk-ant/);
    assert.match(err.message, /bogus/);
  }
});
