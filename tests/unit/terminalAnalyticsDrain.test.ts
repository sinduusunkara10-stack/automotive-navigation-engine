import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TERMINAL_ANALYTICS_DRAIN_CONFIG,
  TERMINAL_ANALYTICS_DRAIN_DEFAULT_HARD_CAP_MS,
  TERMINAL_ANALYTICS_DRAIN_FORM_HARD_CAP_MS,
  TERMINAL_ANALYTICS_DRAIN_QUIET_WINDOW_MS,
} from "../../src/config/terminalAnalyticsDrainConfig.js";
import {
  resolveTerminalAnalyticsDrainHardCapMs,
  runTerminalAnalyticsDrain,
  terminalAnalyticsDrainApplies,
} from "../../src/core/terminalAnalyticsDrain.js";
import type { Captures, DataLayerCapture, Ga4NetworkEventCapture } from "../../src/types/task-response.js";

function ga4(n: number): Ga4NetworkEventCapture {
  return { stepIndex: 3, requestUrl: `https://example.test/g/collect?n=${n}`, timestamp: new Date().toISOString(), method: "GET", source: "main_frame" };
}
function push(n: number): DataLayerCapture {
  return { stepIndex: 3, url: "https://example.test/", timestamp: new Date().toISOString(), raw: [{ event: `e${n}` }], source: "main_frame" };
}
/** The live listeners replace the array on every append (core/boundedArray.ts), so the fake does too. */
function appendGa4(captures: Captures, n: number, max = Infinity): void {
  const next = [...(captures.ga4_network_events ?? []), ga4(n)];
  captures.ga4_network_events = next.length > max ? next.slice(next.length - max) : next;
}

test("defaults: 1500 ms quiet window, 8000 ms after a verified form submission, 3000 ms otherwise", () => {
  assert.equal(TERMINAL_ANALYTICS_DRAIN_QUIET_WINDOW_MS, 1_500);
  assert.equal(TERMINAL_ANALYTICS_DRAIN_FORM_HARD_CAP_MS, 8_000);
  assert.equal(TERMINAL_ANALYTICS_DRAIN_DEFAULT_HARD_CAP_MS, 3_000);
  assert.equal(resolveTerminalAnalyticsDrainHardCapMs(DEFAULT_TERMINAL_ANALYTICS_DRAIN_CONFIG, true), 8_000);
  assert.equal(resolveTerminalAnalyticsDrainHardCapMs(DEFAULT_TERMINAL_ANALYTICS_DRAIN_CONFIG, false), 3_000);
});

test("applies only when GA4 network or dataLayer capture is enabled", () => {
  assert.equal(terminalAnalyticsDrainApplies(["ga4_network_events"]), true);
  assert.equal(terminalAnalyticsDrainApplies(["data_layer_evidence"]), true);
  assert.equal(terminalAnalyticsDrainApplies(["page_visits", "cta_clicks", "errors"]), false);
  assert.equal(terminalAnalyticsDrainApplies([]), false);
});

test("no activity: exits at the quiet window, not the hard cap, and reports nothing observed", async () => {
  const captures: Captures = { ga4_network_events: [ga4(0)], data_layer_evidence: [push(0)] };
  const { diagnostics, ga4Events, dataLayerPushes } = await runTerminalAnalyticsDrain({
    captures,
    quietWindowMs: 200,
    hardCapMs: 2_000,
    pollIntervalMs: 20,
    verifiedFormSubmission: false,
  });
  assert.equal(diagnostics.exitReason, "quiet_window");
  assert.ok(diagnostics.durationMs >= 200 && diagnostics.durationMs < 400, `duration ${diagnostics.durationMs}`);
  assert.equal(diagnostics.ga4HitsObserved, 0);
  assert.equal(diagnostics.dataLayerPushesObserved, 0);
  assert.equal(diagnostics.quietWindowMs, 200);
  assert.equal(diagnostics.hardCapMs, 2_000);
  assert.deepEqual([ga4Events.length, dataLayerPushes.length], [0, 0], "entries recorded before the drain are not drain evidence");
});

test("activity resets the quiet window: it ends one quiet window after the last new entry", async () => {
  const captures: Captures = { ga4_network_events: [], data_layer_evidence: [] };
  setTimeout(() => appendGa4(captures, 1), 100);
  setTimeout(() => {
    captures.data_layer_evidence = [push(2)];
  }, 250);
  const started = Date.now();
  const { diagnostics, ga4Events, dataLayerPushes } = await runTerminalAnalyticsDrain({
    captures,
    quietWindowMs: 200,
    hardCapMs: 3_000,
    pollIntervalMs: 20,
    verifiedFormSubmission: false,
  });
  const elapsed = Date.now() - started;
  assert.equal(diagnostics.exitReason, "quiet_window");
  assert.ok(elapsed >= 450 && elapsed < 700, `ended ${elapsed} ms after start, expected about 250 + 200`);
  assert.equal(diagnostics.ga4HitsObserved, 1);
  assert.equal(diagnostics.dataLayerPushesObserved, 1);
  assert.equal(ga4Events.length, 1);
  assert.equal(dataLayerPushes.length, 1);
});

test("continuous activity: stops at the hard cap, whichever cap the run selected", async () => {
  const captures: Captures = { ga4_network_events: [] };
  let n = 0;
  const timer = setInterval(() => appendGa4(captures, (n += 1)), 40);
  try {
    const { diagnostics } = await runTerminalAnalyticsDrain({
      captures,
      quietWindowMs: 300,
      hardCapMs: 600,
      pollIntervalMs: 20,
      verifiedFormSubmission: true,
    });
    assert.equal(diagnostics.exitReason, "hard_cap");
    assert.ok(diagnostics.durationMs >= 600 && diagnostics.durationMs < 800, `duration ${diagnostics.durationMs}`);
    assert.equal(diagnostics.verifiedFormSubmission, true);
    assert.ok(diagnostics.ga4HitsObserved >= 10, `observed ${diagnostics.ga4HitsObserved}`);
  } finally {
    clearInterval(timer);
  }
});

test("a capture array already at its cap still counts new entries (sliding window keeps the length constant)", async () => {
  const captures: Captures = { ga4_network_events: [ga4(0), ga4(1), ga4(2)] };
  setTimeout(() => appendGa4(captures, 3, 3), 60);
  const { diagnostics, ga4Events } = await runTerminalAnalyticsDrain({
    captures,
    quietWindowMs: 150,
    hardCapMs: 2_000,
    pollIntervalMs: 20,
    verifiedFormSubmission: false,
  });
  assert.equal(captures.ga4_network_events!.length, 3);
  assert.equal(diagnostics.ga4HitsObserved, 1);
  assert.equal(ga4Events.length, 1);
  assert.equal(diagnostics.exitReason, "quiet_window");
});
