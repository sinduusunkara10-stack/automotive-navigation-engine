import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Request } from "playwright";

import { appendBounded } from "../../src/core/boundedArray.js";
import { recordMemorySample, MAX_MEMORY_SAMPLES } from "../../src/core/memoryDiagnostics.js";
import { captureDataLayer } from "../../src/capture-modules/dataLayer.js";
import { attachGa4NetworkCapture } from "../../src/capture-modules/ga4NetworkEvents.js";
import { recordDiagnosticError } from "../../src/capture-modules/errors.js";
import {
  MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT,
  MAX_GA4_NETWORK_EVENTS,
  MAX_ERROR_ENTRIES,
} from "../../src/config/captureLimits.js";
import type { Captures } from "../../src/types/task-response.js";

test("appendBounded keeps at most max entries, dropping the oldest first", () => {
  let arr: number[] = [];
  for (let i = 0; i < 10; i++) {
    arr = appendBounded(arr, i, 5);
  }
  assert.deepEqual(arr, [5, 6, 7, 8, 9]);
});

test("appendBounded never drops anything while under the cap", () => {
  const arr = appendBounded(appendBounded([], "a", 5), "b", 5);
  assert.deepEqual(arr, ["a", "b"]);
});

test("recordMemorySample bounds the number of retained samples to MAX_MEMORY_SAMPLES", () => {
  let samples: ReturnType<typeof recordMemorySample> = [];
  for (let i = 0; i < MAX_MEMORY_SAMPLES + 25; i++) {
    samples = recordMemorySample(samples, "step", i);
  }
  assert.equal(samples.length, MAX_MEMORY_SAMPLES);
  // The most recent samples (highest stepIndex) are the ones kept.
  assert.equal(samples[samples.length - 1]?.stepIndex, MAX_MEMORY_SAMPLES + 24);
});

test("captureDataLayer bounds window.dataLayer to the most recent MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT entries", async () => {
  const totalEntries = MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT + 100;
  const fakePage = {
    async evaluate() {
      return Array.from({ length: totalEntries }, (_, i) => ({ event: `evt_${i}` }));
    },
    url() {
      return "http://127.0.0.1/current-page.html";
    },
  } as unknown as Page;

  const captured = await captureDataLayer(fakePage, 0);
  assert.equal(captured.raw.length, MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT);
  // Keeps the most recent entries, not the earliest.
  assert.equal((captured.raw[captured.raw.length - 1] as { event: string }).event, `evt_${totalEntries - 1}`);
});

test("attachGa4NetworkCapture bounds captures.ga4_network_events to MAX_GA4_NETWORK_EVENTS", () => {
  let requestHandler: ((request: Request) => void) | undefined;
  const fakePage = {
    on(event: string, handler: (request: Request) => void) {
      if (event === "request") requestHandler = handler;
    },
    off() {},
  } as unknown as Page;

  const captures: Captures = {};
  attachGa4NetworkCapture(fakePage, captures, () => 0);
  assert.ok(requestHandler, "expected attachGa4NetworkCapture to register a request listener");

  const totalRequests = MAX_GA4_NETWORK_EVENTS + 50;
  for (let i = 0; i < totalRequests; i++) {
    const fakeRequest = { url: () => `http://127.0.0.1/g/collect?n=${i}` } as unknown as Request;
    requestHandler!(fakeRequest);
  }

  assert.equal(captures.ga4_network_events?.length, MAX_GA4_NETWORK_EVENTS);
  const last = captures.ga4_network_events?.[captures.ga4_network_events.length - 1];
  assert.equal(last?.params?.n, String(totalRequests - 1));
});

test("recordDiagnosticError bounds captures.errors to MAX_ERROR_ENTRIES", () => {
  const captures: Captures = {};
  const totalErrors = MAX_ERROR_ENTRIES + 40;
  for (let i = 0; i < totalErrors; i++) {
    recordDiagnosticError(captures, {
      category: "console_error",
      severity: "warning",
      message: `error number ${i}`,
      recoverable: true,
      stoppedRun: false,
    });
  }

  assert.equal(captures.errors?.length, MAX_ERROR_ENTRIES);
  const last = captures.errors?.[captures.errors.length - 1];
  assert.ok(last?.message.includes(String(totalErrors - 1)));
});
