import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName } from "../helpers/scriptedReasoningProvider.js";

/**
 * Surface-relevance corrective work, PR 6 (diagnostics/n8n extraction wiring, your 2026-09-21
 * ask): full runTask()-level proof that the relevance/consent evidence PR 3/4/5 already
 * computed internally is now actually reaching the wire contract -- ActionResult.relevanceScore/
 * relevanceTier/consentActionTaken/adoptionRejectedReason ("relevance_rejected"), and
 * diagnostics.surfaceAdoption.attempts[] mirroring the same fields -- rather than only proven at
 * capture-modules/popupCapture.ts's own function-call level (tests/integration/
 * consentOnlyCandidateRejectTier.test.ts, surfaceRelevanceTrustPolicy.test.ts). Every response
 * here is also validated against schemas/task-response.schema.json directly, so this is proof
 * against the real JSON contract, not just the TypeScript types.
 *
 * extendedAllowedDomain's own wiring (the same one-line mapping in actions/click.ts) is not
 * re-proven at this full-runTask level: forcing a genuinely untrusted popup domain through
 * engine.ts's preflight domain discovery would require a second real hostname, which this
 * local test environment does not have. Its value is already fully verified at the
 * adoptOrCapturePopup level (surfaceRelevanceTrustPolicy.test.ts), the same precedent this
 * codebase already uses for domain-policy testing; only the mapping to ActionResult is new here,
 * and it is a direct, low-risk passthrough of that already-verified value.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

async function assertValidAgainstResponseSchema(response: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.ok(validate(response), ajv.errorsText(validate.errors));
}

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";

function baseTask(overrides: Partial<TaskRequest> & { startUrl: string }): TaskRequest {
  const { startUrl, ...rest } = overrides;
  return {
    schemaVersion: "1.24.0",
    taskId: "surface-relevance-diagnostics-test",
    objective: OBJECTIVE,
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_finance_application",
        type: "semantic_page_match",
        description: "Vehicle Finance Application",
        config: { minScore: 0.3 },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 3, maxBacktracks: 0 },
    safety: {
      allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
      consentInteractionPolicy: "accept_optional",
    },
    outputSchemaVersion: "1.25.0",
    ...rest,
  };
}

test("adopted candidate: relevanceScore/relevanceTier/consentActionTaken reach the wire on actionResult and diagnostics.surfaceAdoption, and the full response validates against the schema", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/surface-relevance-consent-reject-tier-source.html` });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Open Finance Tab")]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.schemaVersion, "1.25.0");
    assert.equal(response.status, "success");

    const adoptionStep = response.steps.find((s) => s.actionResult.surfaceAdopted === true);
    assert.ok(adoptionStep, "expected one step whose actionResult.surfaceAdopted is true");
    assert.equal(adoptionStep?.actionResult.adoptionRejectedReason, undefined);
    assert.equal(adoptionStep?.actionResult.relevanceTier, "adopt");
    assert.ok((adoptionStep?.actionResult.relevanceScore ?? 0) > 0, "expected a positive relevance score for the adopted (post-consent) content");
    assert.equal(adoptionStep?.actionResult.consentActionTaken, true);

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    const adoptedAttempt = surfaceAdoption?.attempts.find((a) => a.event === "adopted");
    assert.ok(adoptedAttempt, "expected an 'adopted' diagnostic attempt");
    assert.equal(adoptedAttempt?.relevanceTier, "adopt");
    assert.equal(adoptedAttempt?.consentActionTaken, true);
    assert.ok((adoptedAttempt?.relevanceScore ?? 0) > 0);

    await assertValidAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("relevance-rejected candidate: adoptionRejectedReason 'relevance_rejected' plus relevanceScore/relevanceTier/consentActionTaken reach the wire, and the full response validates against the schema", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/surface-relevance-consent-reject-tier-irrelevant-source.html` });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Open Newsletter Tab")]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.schemaVersion, "1.25.0");

    const rejectionStep = response.steps.find((s) => s.actionResult.adoptionRejectedReason === "relevance_rejected");
    assert.ok(rejectionStep, "expected one step rejected for relevance_rejected");
    assert.equal(rejectionStep?.actionResult.surfaceAdopted, undefined);
    assert.equal(rejectionStep?.actionResult.relevanceTier === "adopt", false);
    assert.equal(typeof rejectionStep?.actionResult.relevanceScore, "number");
    assert.equal(rejectionStep?.actionResult.consentActionTaken, true, "consent was still accepted once even though the revealed content was irrelevant");

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    const rejectedAttempt = surfaceAdoption?.attempts.find((a) => a.event === "rejected" && a.reason === "relevance_rejected");
    assert.ok(rejectedAttempt, "expected a 'rejected' diagnostic attempt with reason relevance_rejected");
    assert.equal(rejectedAttempt?.consentActionTaken, true);

    await assertValidAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
