import { test } from "node:test";
import assert from "node:assert/strict";

import { buildLaunchArgs } from "../../src/api/runner.js";

test("buildLaunchArgs omits the WebGL-disabling flags when low-memory mode is off", () => {
  const args = buildLaunchArgs(false);
  assert.ok(!args.includes("--disable-webgl"));
  assert.ok(!args.includes("--disable-webgl2"));
  assert.ok(args.includes("--disable-gpu"), "existing memory-safe flags must be unaffected");
});

test("buildLaunchArgs adds --disable-webgl and --disable-webgl2 when low-memory mode is on", () => {
  const args = buildLaunchArgs(true);
  assert.ok(args.includes("--disable-webgl"));
  assert.ok(args.includes("--disable-webgl2"));
  assert.ok(args.includes("--disable-gpu"), "existing memory-safe flags must still be present");
});
