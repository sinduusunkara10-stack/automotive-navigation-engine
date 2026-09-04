import { test } from "node:test";
import assert from "node:assert/strict";

import { createApiServer } from "../../src/api/server.js";
import { InvalidActionNavigationTimeoutError } from "../../src/config/actionNavigationConfig.js";

// NODE_ENV=test lets createApiServer skip the (unrelated) NAVIGATION_ENGINE_API_TOKEN
// requirement, isolating these assertions to ACTION_NAVIGATION_TIMEOUT_MS validation.

test("createApiServer starts normally when ACTION_NAVIGATION_TIMEOUT_MS is unset", async () => {
  const server = await createApiServer({ NODE_ENV: "test" });
  assert.ok(server);
  server.close();
});

test("createApiServer starts normally with a valid ACTION_NAVIGATION_TIMEOUT_MS override", async () => {
  const server = await createApiServer({ NODE_ENV: "test", ACTION_NAVIGATION_TIMEOUT_MS: "45000" });
  assert.ok(server);
  server.close();
});

test("createApiServer fails clearly at startup on an invalid ACTION_NAVIGATION_TIMEOUT_MS, before serving any request", async () => {
  await assert.rejects(
    createApiServer({ NODE_ENV: "test", ACTION_NAVIGATION_TIMEOUT_MS: "not-a-number" }),
    InvalidActionNavigationTimeoutError,
  );
});
