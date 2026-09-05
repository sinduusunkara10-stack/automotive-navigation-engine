import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runTask } from "../../src/core/engine.js";
import { startStaticServer } from "../helpers/staticServer.js";
import type { TaskRequest } from "../../src/types/task-request.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.8.0",
    taskId: "evidence-retention-task",
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
    limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      // "capture" deliberately omitted: MockReasoningProvider only ever captures once,
      // right before stop_success, which would otherwise add a 4th step and complicate
      // the exact step-count assertions below.
      allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.7.0",
  };
}

test("steps[] is bounded to maxStoredSteps, preserving the first and the final (terminal) step", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = buildTask(`${fixtures.baseUrl}/start.html`);

    // The real journey is start.html -[click]-> step2.html -[click]-> success.html
    // -[stop_success] -- 3 steps. maxStoredSteps=2 forces the middle step to be dropped.
    const result = await runTask({ page, task, maxStoredSteps: 2 });

    assert.equal(result.status, "success");
    assert.ok(result.steps.length <= 2, `expected at most 2 stored steps, got ${result.steps.length}`);
    assert.equal(result.steps[0]?.stepIndex, 0, "expected the first step to survive");
    const lastStep = result.steps[result.steps.length - 1];
    assert.equal(lastStep?.selectedAction.type, "stop_success", "expected the terminal step to survive");
    assert.equal(result.finalUrl, `${fixtures.baseUrl}/success.html`);
  } finally {
    await browser.close();
    await fixtures.close();
  }
});

test("steps[] is left untouched when the run has fewer steps than maxStoredSteps", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = buildTask(`${fixtures.baseUrl}/start.html`);

    const result = await runTask({ page, task, maxStoredSteps: 50 });

    assert.equal(result.status, "success");
    assert.equal(result.steps.length, 3);
    assert.deepEqual(
      result.steps.map((s) => s.stepIndex),
      [0, 1, 2],
    );
  } finally {
    await browser.close();
    await fixtures.close();
  }
});

test("observation.interactiveElements stored per step is bounded without affecting the run's own decision-making", async () => {
  // A bespoke page with far more interactive elements than the configured storage cap,
  // so a decision can still target any of them live even though only a handful survive
  // into the stored response -- proving the storage cap never reaches the live
  // observation the reasoning/validation loop itself uses (see core/engine.ts's
  // boundStepLogForStorage).
  const manyButtons = Array.from({ length: 40 }, (_, i) => `<button id="filler-${i}">Filler ${i}</button>`).join("\n");
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/start.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><html><head><title>Many Elements</title></head><body>${manyButtons}` +
            `<a href="/success.html" id="continue-link">Continue</a></body></html>`,
        );
      return;
    }
    if (path === "/success.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><html><head><title>Success</title></head><body><h1>Success</h1></body></html>");
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task: TaskRequest = {
      schemaVersion: "1.8.0",
      taskId: "evidence-retention-elements-task",
      objective: "Reach the success page by following the visible continue control.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "reached_success_page",
          type: "url_pattern",
          description: "x",
          config: { pattern: "**success.html" },
        },
      ],
      captureModules: [],
      limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: {
        allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
      outputSchemaVersion: "1.7.0",
    };

    const result = await runTask({ page, task, maxStoredInteractiveElementsPerObservation: 5 });

    // The run itself must still succeed -- MockReasoningProvider found and clicked the
    // "Continue" link among 41 live candidates even though storage only keeps 5.
    assert.equal(result.status, "success");
    assert.ok(result.steps.length > 0);
    for (const step of result.steps) {
      assert.ok(
        step.observation.interactiveElements.length <= 5,
        `expected at most 5 stored interactiveElements, got ${step.observation.interactiveElements.length}`,
      );
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
