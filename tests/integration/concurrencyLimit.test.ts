import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createApiServer } from "../../src/api/server.js";

const TEST_API_TOKEN = "test-only-navigation-engine-token-do-not-use-in-prod";
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_API_TOKEN}` };

/** A server that never finishes its HTTP response, so a run's initial navigation stays
 * in flight indefinitely -- exactly what's needed to keep a slot occupied at the
 * concurrency limiter for the duration of this test. */
async function startHangingServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    // Deliberately never call res.end().
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function buildTask(startUrl: string) {
  return {
    schemaVersion: "1.8.0",
    taskId: "concurrency-limit-task",
    objective: "Reach the fixture's success page by following the visible continue control.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        config: { pattern: "**success.html" },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.7.0",
  };
}

test("a second POST /v1/tasks is rejected with 503 while MAX_CONCURRENT_TASKS=1 is already occupied", async () => {
  const hanging = await startHangingServer();
  const server = await createApiServer({
    NODE_ENV: "test",
    NAVIGATION_ENGINE_API_TOKEN: TEST_API_TOKEN,
    MAX_CONCURRENT_TASKS: "1",
    // Kept short so the first (deliberately never-resolving) run finishes quickly once
    // this test's own assertions are done, rather than leaving a background browser
    // process running for the default 30s after the test file exits.
    INITIAL_NAVIGATION_TIMEOUT_MS: "1000",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const firstTask = buildTask(hanging.baseUrl);
    const firstRes = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify(firstTask),
    });
    assert.equal(firstRes.status, 202, "expected the first task to be accepted");

    const secondTask = buildTask(hanging.baseUrl);
    const secondRes = await fetch(`${baseUrl}/v1/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...AUTH_HEADERS },
      body: JSON.stringify(secondTask),
    });
    assert.equal(secondRes.status, 503, "expected the second task to be rejected while the limiter is full");
    const secondBody = await secondRes.json();
    assert.equal(secondBody.error, "concurrency_limit_reached");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await hanging.close();
  }
});
