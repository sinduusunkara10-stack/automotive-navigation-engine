import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildAnalyticsReportingRowsItems } from "../../n8n/buildAnalyticsReportingRows.js";

/**
 * Guards against the source-of-truth (n8n/buildAnalyticsReportingRows.ts) and its deployable
 * plain-JS n8n twin ever hand-diverging again: this generates the twin fresh from the TS source
 * via n8n/generateNode.mjs, executes it exactly as n8n's Code node would ($input.all() + a
 * top-level return), and asserts its output is identical to calling the TS module directly on
 * the same fixture -- a real ("Get Task Result"-shaped) wrapper, not a simplified test object.
 */

const repoRoot = path.resolve(import.meta.dirname, "../..");

function runGeneratedNode(items: unknown[]): unknown {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "n8n-node-"));
  const outputPath = path.join(tmpDir, "build-analytics-reporting-rows-node.generated.js");
  try {
    execFileSync(process.execPath, [path.join(repoRoot, "n8n/generateNode.mjs"), outputPath], { stdio: "pipe" });
    const code = readFileSync(outputPath, "utf8");
    const fakeInput = { all: () => items.map((json) => ({ json })) };
    // eslint-disable-next-line no-new-func -- executing the generated n8n Code node body exactly as n8n would
    const run = new Function("$input", code);
    return run(fakeInput);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

test("the generated deployable node produces output identical to the TypeScript source, against a realistic Get Task Result fixture", () => {
  const analyticsReportingRows = [
    {
      runId: "run-1",
      taskId: "task-1",
      schemaVersion: "1.38.0",
      journeySequence: 1,
      recordType: "START_PAGE",
      stepIndex: 0,
      timestamp: "2026-09-28T00:00:00.000Z",
      eventRole: "START_PAGE",
      eventClassification: "JOURNEY_MARKER",
      correlationStatus: "NOT_APPLICABLE",
      sourcePageUrl: "https://www.example-automotive-oem.com/vehicles/model-x/overview.html",
    },
    {
      runId: "run-1",
      taskId: "task-1",
      schemaVersion: "1.38.0",
      journeySequence: 2,
      recordType: "ANALYTICS_EVENT",
      stepIndex: 1,
      timestamp: "2026-09-28T00:00:05.000Z",
      eventRole: "ASSOCIATED_RESULT",
      eventClassification: "PHYSICAL_PAGE_CHANGE",
      correlationStatus: "CONFIRMED",
      eventId: "evt_1",
      evidenceSource: "popup_context",
      contextId: "popup:2",
      eventName: "page_view",
      measurementId: "G-EXAMPLE123",
      rawEvidenceJson: JSON.stringify({
        params: { cid: "111.222", sid: "333", tid: "G-EXAMPLE123", _fplc: "abc" },
        requestUrl: "https://sst.example-automotive-oem.com/g/collect?cid=111.222&tid=G-EXAMPLE123",
      }),
    },
  ];

  // The real, owner-reported production shape: an HTTP-Request-node item wrapping the engine's
  // TaskResponse under body.result.
  const realisticGetTaskResultItem = {
    headers: { "content-type": "application/json" },
    statusCode: 200,
    statusMessage: "OK",
    body: {
      runId: "run-1",
      taskId: "task-1",
      status: "completed",
      result: {
        schemaVersion: "1.38.0",
        status: "success",
        analyticsReportingRows,
        diagnostics: { surfaceAdoption: { attempts: [{ stepIndex: 1, surfaceId: "s1", event: "adopted" }] } },
      },
    },
  };

  const expected = buildAnalyticsReportingRowsItems([realisticGetTaskResultItem]);
  const actual = runGeneratedNode([realisticGetTaskResultItem]);

  assert.deepEqual(actual, expected);
  assert.ok((expected as unknown[]).length > 0, "the realistic fixture must produce reporting rows");
  const serialized = JSON.stringify(actual);
  assert.ok(!serialized.includes("111.222"), "cid must be redacted in the generated node's output too");
  assert.ok(serialized.includes("[redacted]"));
});
