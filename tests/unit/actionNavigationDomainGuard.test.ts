import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { executeNavigate } from "../../src/actions/navigate.js";

/**
 * Unit-level coverage of executeNavigate's own defense-in-depth domain check -- distinct
 * from src/safety's pre-dispatch check (src/reasoning/validateClaudeDecision.ts /
 * src/safety/index.ts), which already rejects an out-of-allowedDomains navigate target
 * before it ever reaches the action executor (see the integration-level test in
 * tests/integration/actionNavigation.test.ts). Calling executeNavigate directly bypasses
 * that layer, so this proves the executor never trusts a caller to have already checked.
 */
test("executeNavigate rejects a target outside allowedDomains without ever calling page.goto", async () => {
  const page = {
    goto: () => {
      throw new Error("must not navigate to a disallowed target");
    },
  } as unknown as Page;

  const result = await executeNavigate({
    page,
    action: { type: "navigate", target: "http://localhost:1/blocked.html" },
    allowedDomains: ["127.0.0.1"],
    timeoutMs: 1000,
    captures: {},
    stepIndex: 0,
    captureModules: [],
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /allowedDomains/);
  assert.equal(result.resultingUrl, undefined);
});

test("executeNavigate requires a target URL", async () => {
  const page = {} as unknown as Page;

  const result = await executeNavigate({
    page,
    action: { type: "navigate" },
    allowedDomains: ["127.0.0.1"],
    timeoutMs: 1000,
    captures: {},
    stepIndex: 0,
    captureModules: [],
  });

  assert.equal(result.success, false);
  assert.match(result.error ?? "", /target URL/);
});
