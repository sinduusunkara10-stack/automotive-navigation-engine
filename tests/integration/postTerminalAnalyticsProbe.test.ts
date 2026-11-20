import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { readPostTerminalAnalyticsProbeConfig } from "../../src/config/postTerminalAnalyticsProbeConfig.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { TaskResponse } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * POST_TERMINAL_ANALYTICS_PROBE_ENABLED: a diagnostics-only listener after a successful run's
 * terminal decision. The done page fires a GA4 collect on load and a delayed "lead" batch 4 s
 * later, after the run has ended.
 */

class ScriptedProvider implements ReasoningProvider {
  calls = 0;
  constructor(private readonly finalAction: "stop_success" | "stop_failure" = "stop_success") {}
  async decide(context: ReasoningContext): Promise<Decision> {
    this.calls += 1;
    if (context.observation.url.includes("post-terminal-probe-done")) {
      return { action: { type: this.finalAction }, rationale: "Done." };
    }
    const target = context.observation.interactiveElements.find((el) => el.accessibleName.trim() === "Finish request");
    return target
      ? { action: { type: "click", target: target.id }, rationale: "Finish." }
      : { action: { type: "stop_failure" }, rationale: "Missing CTA." };
  }
}

function task(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "post-terminal-probe-test",
    objective: "Finish the request.",
    startUrl: `${baseUrl}/post-terminal-probe-landing.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "done", type: "url_pattern", description: "Request complete", config: { pattern: `${baseUrl}/post-terminal-probe-done.html` }, required: true },
    ],
    captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events"],
    limits: { maxSteps: 6, maxBacktracks: 1 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.53.0",
  };
}

async function run(
  options: Parameters<typeof runTask>[0]["postTerminalAnalyticsProbe"],
  provider = new ScriptedProvider(),
): Promise<{ response: TaskResponse; provider: ScriptedProvider; elapsedMs: number }> {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const started = Date.now();
    const response = await runTask({ page, task: task(baseUrl), reasoning: provider, ...(options ? { postTerminalAnalyticsProbe: options } : {}) });
    return { response, provider, elapsedMs: Date.now() - started };
  } finally {
    await browser.close();
    await close();
  }
}

function capturedEventNames(response: TaskResponse): string[] {
  return (response.captures.ga4_network_events ?? []).flatMap((event) => [
    ...(event.params?.en ? [event.params.en] : []),
    ...(event.postDataParams ?? []).map((body) => body.en).filter((en): en is string => Boolean(en)),
  ]);
}

test("config: POST_TERMINAL_ANALYTICS_PROBE_ENABLED is off unless set to true, with a fixed 8 s duration", () => {
  assert.deepEqual(readPostTerminalAnalyticsProbeConfig({}), { enabled: false, durationMs: 8_000 });
  assert.equal(readPostTerminalAnalyticsProbeConfig({ POST_TERMINAL_ANALYTICS_PROBE_ENABLED: "false" }).enabled, false);
  assert.equal(readPostTerminalAnalyticsProbeConfig({ POST_TERMINAL_ANALYTICS_PROBE_ENABLED: "true" }).enabled, true);
  assert.equal(readPostTerminalAnalyticsProbeConfig({ POST_TERMINAL_ANALYTICS_PROBE_ENABLED: "1" }).enabled, true);
});

test("disabled: no probe runs, run timing is recorded, and the delayed hit is not captured", async () => {
  const { response, elapsedMs } = await run(undefined);
  assert.equal(response.status, "success");
  assert.equal(response.diagnostics.postTerminalAnalyticsProbe, undefined);
  const timing = response.diagnostics.runTiming!;
  assert.ok(Date.parse(timing.terminalDecisionAt) <= Date.parse(timing.listenersDetachedAt));
  assert.ok(Date.parse(timing.listenersDetachedAt) <= Date.parse(timing.runEndedAt));
  assert.ok(Date.parse(timing.runEndedAt) - Date.parse(timing.listenersDetachedAt) < 1_000, "no extra wait when disabled");
  assert.ok(capturedEventNames(response).includes("page_view"));
  assert.ok(!capturedEventNames(response).includes("lead"));
  assert.ok(elapsedMs < 8_000);
  const schema = await validateAgainstTaskResponseSchema(response);
  assert.ok(schema.valid, schema.errorsText);
});

test("enabled via env: late GA4 hits are recorded only in diagnostics, navigation does not restart, and the 8 s duration holds", { timeout: 60_000 }, async () => {
  const previous = process.env.POST_TERMINAL_ANALYTICS_PROBE_ENABLED;
  process.env.POST_TERMINAL_ANALYTICS_PROBE_ENABLED = "true";
  try {
    const { response, provider } = await run(undefined);
    assert.equal(response.status, "success");
    const probe = response.diagnostics.postTerminalAnalyticsProbe!;
    assert.ok(probe, "probe ran");
    assert.equal(probe.configuredDurationMs, 8_000);
    assert.ok(probe.probeDurationMs >= 8_000 && probe.probeDurationMs < 9_000, `duration ${probe.probeDurationMs}`);
    assert.equal(probe.lateHitCount, probe.lateHits.length);

    const lead = probe.lateHits.find((hit) => hit.eventNames.includes("lead"));
    assert.ok(lead, JSON.stringify(probe.lateHits));
    assert.deepEqual(lead.eventNames, ["lead", "form_complete"]);
    assert.equal(lead.requestPath, "/g/collect");
    assert.ok(lead.requestHost.startsWith("127.0.0.1"));
    assert.equal(lead.method, "POST");
    assert.equal(lead.isActivePage, true);
    assert.ok(lead.msAfterTerminalDecision > 0);
    assert.ok(Date.parse(lead.timestamp) >= Date.parse(probe.probeStartedAt));

    assert.ok(!capturedEventNames(response).includes("lead"), "late hits never enter captures");
    assert.ok(!JSON.stringify(response.analyticsReportingRows).includes("form_complete"), "or reporting rows");

    assert.equal(provider.calls, response.steps.length, "no reasoning call after the terminal decision");
    assert.equal(response.steps.length, 2, "no extra step");
    const timing = response.diagnostics.runTiming!;
    assert.ok(Date.parse(timing.listenersDetachedAt) <= Date.parse(probe.probeStartedAt));
    assert.ok(Date.parse(probe.probeEndedAt) <= Date.parse(timing.runEndedAt));
    assert.equal(probe.terminalDecisionAt, timing.terminalDecisionAt);
    const schema = await validateAgainstTaskResponseSchema(response);
    assert.ok(schema.valid, schema.errorsText);
  } finally {
    if (previous === undefined) delete process.env.POST_TERMINAL_ANALYTICS_PROBE_ENABLED;
    else process.env.POST_TERMINAL_ANALYTICS_PROBE_ENABLED = previous;
  }
});

test("enabled: a shorter configured duration is respected", async () => {
  const { response } = await run({ enabled: true, durationMs: 1_000 });
  const probe = response.diagnostics.postTerminalAnalyticsProbe!;
  assert.ok(probe.probeDurationMs >= 1_000 && probe.probeDurationMs < 1_500, `duration ${probe.probeDurationMs}`);
});

test("enabled: a run that does not end in success never runs the probe", async () => {
  const { response, elapsedMs } = await run({ enabled: true, durationMs: 8_000 }, new ScriptedProvider("stop_failure"));
  assert.notEqual(response.status, "success");
  assert.equal(response.diagnostics.postTerminalAnalyticsProbe, undefined);
  assert.ok(response.diagnostics.runTiming);
  assert.ok(elapsedMs < 8_000);
});
