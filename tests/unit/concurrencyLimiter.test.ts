import { test } from "node:test";
import assert from "node:assert/strict";

import { createConcurrencyLimiter } from "../../src/api/concurrencyLimiter.js";

test("tryAcquire succeeds up to max and rejects predictably beyond it", () => {
  const limiter = createConcurrencyLimiter(2);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.current, 2);
});

test("release frees a slot so a subsequent tryAcquire can succeed again", () => {
  const limiter = createConcurrencyLimiter(1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);

  limiter.release();
  assert.equal(limiter.current, 0);
  assert.equal(limiter.tryAcquire(), true);
});

test("release never drives current below zero", () => {
  const limiter = createConcurrencyLimiter(1);
  limiter.release();
  limiter.release();
  assert.equal(limiter.current, 0);
});

test("a limiter of max 1 (the Render-conservative default) allows exactly one in-flight acquire", () => {
  const limiter = createConcurrencyLimiter(1);
  assert.equal(limiter.tryAcquire(), true);
  assert.equal(limiter.tryAcquire(), false);
  assert.equal(limiter.tryAcquire(), false);
});
