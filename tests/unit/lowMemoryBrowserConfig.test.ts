import { test } from "node:test";
import assert from "node:assert/strict";

import { readLowMemoryBrowserMode } from "../../src/config/lowMemoryBrowserConfig.js";

test("readLowMemoryBrowserMode defaults to off when unset", () => {
  assert.equal(readLowMemoryBrowserMode({}), false);
});

test("readLowMemoryBrowserMode is on only for the literal string \"true\" (case-insensitive)", () => {
  assert.equal(readLowMemoryBrowserMode({ LOW_MEMORY_BROWSER_MODE: "true" }), true);
  assert.equal(readLowMemoryBrowserMode({ LOW_MEMORY_BROWSER_MODE: "TRUE" }), true);
  assert.equal(readLowMemoryBrowserMode({ LOW_MEMORY_BROWSER_MODE: " true " }), true);
});

test("readLowMemoryBrowserMode is off for any other value, including common near-misses", () => {
  for (const value of ["false", "1", "yes", "on", ""]) {
    assert.equal(readLowMemoryBrowserMode({ LOW_MEMORY_BROWSER_MODE: value }), false, `expected "${value}" to be off`);
  }
});
