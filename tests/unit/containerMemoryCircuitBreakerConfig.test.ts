import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readMemoryCircuitBreakerEnabled,
  readMemoryCircuitBreakerLimitBytesOverride,
  readMemoryCircuitBreakerSampleIntervalMs,
  readMemoryCircuitBreakerThresholdFraction,
  InvalidMemoryCircuitBreakerLimitBytesError,
  InvalidMemoryCircuitBreakerSampleIntervalError,
  InvalidMemoryCircuitBreakerThresholdError,
} from "../../src/config/containerMemoryCircuitBreakerConfig.js";

test("readMemoryCircuitBreakerEnabled defaults off and is on only for the literal \"true\"", () => {
  assert.equal(readMemoryCircuitBreakerEnabled({}), false);
  assert.equal(readMemoryCircuitBreakerEnabled({ MEMORY_CIRCUIT_BREAKER_ENABLED: "true" }), true);
  assert.equal(readMemoryCircuitBreakerEnabled({ MEMORY_CIRCUIT_BREAKER_ENABLED: "TRUE" }), true);
  assert.equal(readMemoryCircuitBreakerEnabled({ MEMORY_CIRCUIT_BREAKER_ENABLED: "1" }), false);
});

test("readMemoryCircuitBreakerThresholdFraction defaults to 0.75 and validates the (0,1] range", () => {
  assert.equal(readMemoryCircuitBreakerThresholdFraction({}), 0.75);
  assert.equal(readMemoryCircuitBreakerThresholdFraction({ MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION: "0.5" }), 0.5);
  assert.equal(readMemoryCircuitBreakerThresholdFraction({ MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION: "1" }), 1);
  assert.throws(
    () => readMemoryCircuitBreakerThresholdFraction({ MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION: "0" }),
    InvalidMemoryCircuitBreakerThresholdError,
  );
  assert.throws(
    () => readMemoryCircuitBreakerThresholdFraction({ MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION: "1.5" }),
    InvalidMemoryCircuitBreakerThresholdError,
  );
  assert.throws(
    () => readMemoryCircuitBreakerThresholdFraction({ MEMORY_CIRCUIT_BREAKER_THRESHOLD_FRACTION: "not-a-number" }),
    InvalidMemoryCircuitBreakerThresholdError,
  );
});

test("readMemoryCircuitBreakerSampleIntervalMs defaults to 3000ms and validates its bounds", () => {
  assert.equal(readMemoryCircuitBreakerSampleIntervalMs({}), 3000);
  assert.equal(readMemoryCircuitBreakerSampleIntervalMs({ MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS: "500" }), 500);
  assert.throws(
    () => readMemoryCircuitBreakerSampleIntervalMs({ MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS: "0" }),
    InvalidMemoryCircuitBreakerSampleIntervalError,
  );
  assert.throws(
    () => readMemoryCircuitBreakerSampleIntervalMs({ MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS: "999999" }),
    InvalidMemoryCircuitBreakerSampleIntervalError,
  );
  assert.throws(
    () => readMemoryCircuitBreakerSampleIntervalMs({ MEMORY_CIRCUIT_BREAKER_SAMPLE_INTERVAL_MS: "abc" }),
    InvalidMemoryCircuitBreakerSampleIntervalError,
  );
});

test("readMemoryCircuitBreakerLimitBytesOverride is unset by default and validates a positive integer", () => {
  assert.equal(readMemoryCircuitBreakerLimitBytesOverride({}), undefined);
  assert.equal(readMemoryCircuitBreakerLimitBytesOverride({ MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES: "536870912" }), 536870912);
  assert.throws(
    () => readMemoryCircuitBreakerLimitBytesOverride({ MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES: "-1" }),
    InvalidMemoryCircuitBreakerLimitBytesError,
  );
  assert.throws(
    () => readMemoryCircuitBreakerLimitBytesOverride({ MEMORY_CIRCUIT_BREAKER_LIMIT_BYTES: "abc" }),
    InvalidMemoryCircuitBreakerLimitBytesError,
  );
});
