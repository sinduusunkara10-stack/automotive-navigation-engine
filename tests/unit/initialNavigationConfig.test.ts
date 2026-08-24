import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_INITIAL_NAVIGATION_TIMEOUT_MS,
  InvalidInitialNavigationTimeoutError,
  readInitialNavigationTimeoutMs,
} from "../../src/config/initialNavigationConfig.js";

test("defaults to 30000ms when INITIAL_NAVIGATION_TIMEOUT_MS is unset", () => {
  assert.equal(DEFAULT_INITIAL_NAVIGATION_TIMEOUT_MS, 30000);
  assert.equal(readInitialNavigationTimeoutMs({}), 30000);
});

test("defaults to 30000ms when INITIAL_NAVIGATION_TIMEOUT_MS is empty/whitespace", () => {
  assert.equal(readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "" }), 30000);
  assert.equal(readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "   " }), 30000);
});

test("a valid positive-integer override is honoured", () => {
  assert.equal(readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "45000" }), 45000);
  assert.equal(readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "  1000  " }), 1000);
});

test("a non-numeric override fails clearly instead of silently falling back", () => {
  assert.throws(
    () => readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "not-a-number" }),
    InvalidInitialNavigationTimeoutError,
  );
});

test("zero, negative, and fractional overrides all fail clearly", () => {
  assert.throws(
    () => readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "0" }),
    InvalidInitialNavigationTimeoutError,
  );
  assert.throws(
    () => readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "-5000" }),
    InvalidInitialNavigationTimeoutError,
  );
  assert.throws(
    () => readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "1500.5" }),
    InvalidInitialNavigationTimeoutError,
  );
});

test("an override above the hard maximum fails clearly rather than silently clamping", () => {
  assert.throws(
    () => readInitialNavigationTimeoutMs({ INITIAL_NAVIGATION_TIMEOUT_MS: "999999999" }),
    InvalidInitialNavigationTimeoutError,
  );
});

test("InvalidInitialNavigationTimeoutError never exposes unrelated environment values", () => {
  try {
    readInitialNavigationTimeoutMs({
      INITIAL_NAVIGATION_TIMEOUT_MS: "bogus",
      NAVIGATION_ENGINE_API_TOKEN: "should-never-appear",
      ANTHROPIC_API_KEY: "sk-ant-should-never-appear",
    });
    assert.fail("expected readInitialNavigationTimeoutMs to throw");
  } catch (err) {
    assert.ok(err instanceof InvalidInitialNavigationTimeoutError);
    assert.doesNotMatch(err.message, /should-never-appear/);
    assert.doesNotMatch(err.message, /sk-ant/);
    assert.match(err.message, /bogus/);
  }
});
