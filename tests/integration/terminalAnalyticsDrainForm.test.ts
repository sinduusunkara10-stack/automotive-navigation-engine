import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { SemanticCriterionVerifier, SemanticVerificationInput, SemanticVerificationOutcome } from "../../src/reasoning/semanticCriterionVerifier.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { TaskResponse } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Terminal analytics drain after a verified form submission (the verified-submission fixture): the
 * run ends on the fill_form step itself, so the hard cap is the longer 8 s one. `beacons` is an
 * init script that fires GA4 collect requests from the page after load.
 */

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

class FillFormOnly implements ReasoningProvider {
  calls = 0;
  async decide(): Promise<Decision> {
    this.calls += 1;
    return this.calls === 1 ? { action: { type: "fill_form" }, rationale: "fill" } : { action: { type: "stop_blocked" }, rationale: "unexpected" };
  }
}

class ConfirmedSubmissionVerifier implements SemanticCriterionVerifier {
  async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
    if (input.criterionDescription === "load the above starturl") return { satisfied: true, confidence: 0.9, evidence: input.pageEvidence.title };
    return input.verifiedFormSubmission && input.verifiedFormSubmission.confirmationSignals.length > 0
      ? { satisfied: true, confidence: 0.9, evidence: "verified submission" }
      : { satisfied: false, confidence: 0.9, evidence: "page chrome only" };
  }
}

function task(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "terminal-drain-form-test",
    objective: "1. load the above starturl\n2. fill out the details of the form\n3. submit the form\n4. stop and return",
    startUrl: `${baseUrl}/post-submit-journey.html?dom=light`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "step-1", type: "semantic_page_match", description: "load the above starturl", config: { minScore: 2 } },
      { id: "step-2", type: "semantic_page_match", description: "fill out the details of the form", config: { minScore: 2 } },
      { id: "step-3", type: "semantic_page_match", description: "submit the form", config: { minScore: 2 } },
      { id: "step-4", type: "semantic_page_match", description: "stop and return", config: { minScore: 2 } },
    ],
    captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events"],
    limits: { maxSteps: 6, maxBacktracks: 2, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "fill_form", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    outputSchemaVersion: "1.53.0",
  };
}

async function run(beacons: string): Promise<{ response: TaskResponse; provider: FillFormOnly }> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.addInitScript(beacons);
    const provider = new FillFormOnly();
    const response = await runTask({ page, task: task(baseUrl), reasoning: provider, semanticVerifier: new ConfirmedSubmissionVerifier() });
    return { response, provider };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

const collect = (name: string) => `navigator.sendBeacon("/g/collect?v=2&tid=G-DRAINTEST&en=${name}", "x=1")`;

test("verified submission, page quiet after the confirmation: the drain ends at the quiet window and selects the 8 s cap", { timeout: 60_000 }, async () => {
  const { response, provider } = await run("");
  assert.equal(response.status, "success");
  assert.equal(response.diagnostics.finishReason, "objective_complete_after_verified_submission");
  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.equal(drain.verifiedFormSubmission, true);
  assert.equal(drain.hardCapMs, 8_000);
  assert.equal(drain.exitReason, "quiet_window");
  assert.ok(drain.durationMs >= 1_500 && drain.durationMs < 3_500, `duration ${drain.durationMs}`);
  assert.equal(provider.calls, 1, "no reasoning call during the drain");
  assert.deepEqual(response.steps.map((s) => s.selectedAction.type), ["fill_form"]);
  const schema = await validateAgainstTaskResponseSchema(response);
  assert.ok(schema.valid, schema.errorsText);
});

test("verified submission: a conversion batch sent 2 s after the first hits is captured and reported under the fill_form action", { timeout: 60_000 }, async () => {
  // Page load fires page_view; the batch follows 2.2 s later. A form that confirms in under a second leaves
  // the drain waiting through it: the gap between consecutive hits stays under the 1.5 s quiet window.
  const { response } = await run(
    `window.addEventListener("load", () => { ${collect("page_view")}; setTimeout(() => ${collect("mid_step")}, 1100); setTimeout(() => ${collect("lead")}, 2200); setTimeout(() => ${collect("form_complete")}, 3300); });`,
  );
  assert.equal(response.status, "success");
  const names = (response.captures.ga4_network_events ?? []).map((e) => e.params?.en);
  assert.ok(names.includes("lead") && names.includes("form_complete"), `captured ${names.join(",")}`);
  const fillStep = response.steps.find((s) => s.selectedAction.type === "fill_form")!;
  const rows = response.analyticsReportingRows.filter((row) => row.recordType === "ANALYTICS_EVENT" && /"(lead|form_complete)"/.test(JSON.stringify(row)));
  const drainRows = rows.filter((row) => row.actionId === `terminal-drain-form-test:action:${fillStep.stepIndex}`);
  assert.ok(drainRows.length > 0, JSON.stringify(rows.map((r) => [r.actionId, r.stepIndex])));
  assert.ok(!rows.some((row) => row.actionId === "terminal-drain-form-test:start"), "never reported under the start page");
});

test("verified submission, traffic that never stops: the drain is cut off at the 8 s cap", { timeout: 60_000 }, async () => {
  const { response } = await run(`window.addEventListener("load", () => setInterval(() => ${collect("stream")}, 400));`);
  assert.equal(response.status, "success");
  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.equal(drain.exitReason, "hard_cap");
  assert.equal(drain.hardCapMs, 8_000);
  assert.ok(drain.durationMs >= 8_000 && drain.durationMs < 8_800, `duration ${drain.durationMs}`);
  assert.ok(drain.ga4HitsObserved >= 15, `observed ${drain.ga4HitsObserved}`);
});
