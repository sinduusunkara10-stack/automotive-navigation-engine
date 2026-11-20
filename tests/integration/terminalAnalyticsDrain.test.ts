import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { CaptureModuleName } from "../../src/types/captureModule.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { TaskResponse } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Terminal analytics drain: after a terminal success the engine passively waits until 1500 ms pass
 * with no new GA4 collect request or live dataLayer push (hard cap 3000 ms; 8000 ms after a
 * verified form submission). terminal-drain-done.html fires GA4 collect beacons on a schedule that
 * the CTA's query string selects.
 */

class ScriptedProvider implements ReasoningProvider {
  readonly callTimes: number[] = [];
  constructor(private readonly cta: string) {}
  async decide(context: ReasoningContext): Promise<Decision> {
    this.callTimes.push(Date.now());
    if (context.observation.url.includes("terminal-drain-done")) {
      return { action: { type: "stop_success" }, rationale: "Done." };
    }
    const target = context.observation.interactiveElements.find((el) => el.accessibleName.trim() === this.cta);
    return target
      ? { action: { type: "click", target: target.id }, rationale: `Click ${this.cta}.` }
      : { action: { type: "stop_failure" }, rationale: "Missing CTA." };
  }
}

function task(baseUrl: string, captureModules: CaptureModuleName[]): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "terminal-drain-test",
    objective: "Finish the request.",
    startUrl: `${baseUrl}/terminal-drain-landing.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "done", type: "url_pattern", description: "Request complete", config: { pattern: `${baseUrl}/terminal-drain-done.html**` }, required: true },
    ],
    captureModules,
    limits: { maxSteps: 6, maxBacktracks: 1 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.53.0",
  };
}

const ANALYTICS: CaptureModuleName[] = ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events"];

async function run(cta: string, captureModules: CaptureModuleName[] = ANALYTICS) {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const provider = new ScriptedProvider(cta);
  try {
    const started = Date.now();
    const response = await runTask({ page, task: task(baseUrl, captureModules), reasoning: provider });
    return { response, provider, elapsedMs: Date.now() - started };
  } finally {
    await browser.close();
    await close();
  }
}

function ga4Names(response: TaskResponse): string[] {
  return (response.captures.ga4_network_events ?? []).map((event) => event.params?.en).filter((en): en is string => Boolean(en));
}

test("delayed hits 1.0 s and 2.0 s after load are captured in the normal result, and reported under the final action", { timeout: 60_000 }, async () => {
  const { response, provider } = await run("Finish delayed");
  assert.equal(response.status, "success");
  const names = ga4Names(response);
  assert.ok(names.includes("vehicle_view") && names.includes("lead"), `captured ${names.join(",")}`);

  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.ok(drain, "drain ran");
  assert.ok(drain.ga4HitsObserved >= 1, `observed ${drain.ga4HitsObserved} during the drain`);
  assert.equal(drain.quietWindowMs, 1_500);
  assert.equal(drain.hardCapMs, 3_000);
  assert.equal(drain.verifiedFormSubmission, false);

  const leadRows = response.analyticsReportingRows.filter(
    (row) => row.recordType === "ANALYTICS_EVENT" && JSON.stringify(row).includes('"lead"'),
  );
  assert.ok(leadRows.length > 0, "the lead hit became a reporting row");
  assert.ok(leadRows.every((row) => row.actionId === "terminal-drain-test:action:0"), JSON.stringify(leadRows.map((r) => r.actionId)));
  assert.ok(leadRows.every((row) => row.stepIndex === 0));
  assert.equal(provider.callTimes.length, response.steps.length, "no reasoning call beyond the recorded steps");
  const schema = await validateAgainstTaskResponseSchema(response);
  assert.ok(schema.valid, schema.errorsText);
});

test("quiet exit: the drain ends one quiet window after the last hit, well before the hard cap, with no new step", { timeout: 60_000 }, async () => {
  const { response, provider } = await run("Finish quick");
  assert.equal(response.status, "success");
  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.equal(drain.exitReason, "quiet_window");
  assert.ok(drain.durationMs >= 1_500 && drain.durationMs < 3_000, `duration ${drain.durationMs}`);
  assert.ok(ga4Names(response).includes("vehicle_view"));

  assert.deepEqual(response.steps.map((s) => s.selectedAction.type), ["click", "stop_success"], "navigation does not restart");
  assert.equal(provider.callTimes.length, 2);
  assert.ok(Math.max(...provider.callTimes) <= Date.parse(drain.startedAt), "no reasoning call during the drain");
  const timing = response.diagnostics.runTiming!;
  assert.ok(Date.parse(timing.terminalDecisionAt) <= Date.parse(drain.startedAt));
  assert.ok(Date.parse(drain.endedAt) <= Date.parse(timing.listenersDetachedAt));
});

test("non-form hard cap: a page that never goes quiet is cut off at 3 s", { timeout: 60_000 }, async () => {
  const { response } = await run("Finish streaming");
  assert.equal(response.status, "success");
  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.equal(drain.exitReason, "hard_cap");
  assert.equal(drain.hardCapMs, 3_000);
  assert.ok(drain.durationMs >= 3_000 && drain.durationMs < 3_800, `duration ${drain.durationMs}`);
  assert.ok(drain.ga4HitsObserved >= 3, `observed ${drain.ga4HitsObserved}`);
  assert.deepEqual(response.steps.map((s) => s.selectedAction.type), ["click", "stop_success"]);
});

test("a page with no analytics after the final action still waits only one quiet window", { timeout: 60_000 }, async () => {
  const { response } = await run("Finish silent");
  const drain = response.diagnostics.terminalAnalyticsDrain!;
  assert.equal(drain.exitReason, "quiet_window");
  assert.ok(drain.durationMs >= 1_500 && drain.durationMs < 2_500, `duration ${drain.durationMs}`);
  assert.equal(drain.ga4HitsObserved, 0);
});

test("no analytics capture module: no drain, no extra wait, no diagnostics field", { timeout: 60_000 }, async () => {
  const { response, elapsedMs } = await run("Finish streaming", ["page_visits", "cta_clicks"]);
  assert.equal(response.status, "success");
  assert.equal(response.diagnostics.terminalAnalyticsDrain, undefined);
  assert.ok(elapsedMs < 3_000, `took ${elapsedMs} ms`);
  const timing = response.diagnostics.runTiming!;
  assert.ok(Date.parse(timing.listenersDetachedAt) - Date.parse(timing.terminalDecisionAt) < 1_000);
  assert.equal(response.captures.ga4_network_events, undefined);
});

test("a run that does not end in success never drains", { timeout: 60_000 }, async () => {
  const { response, elapsedMs } = await run("Missing CTA");
  assert.notEqual(response.status, "success");
  assert.equal(response.diagnostics.terminalAnalyticsDrain, undefined);
  assert.ok(elapsedMs < 4_000, `took ${elapsedMs} ms`);
});
