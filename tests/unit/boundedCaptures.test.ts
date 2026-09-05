import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Request } from "playwright";

import { appendBounded, appendBoundedPreservingEnds, capPreservingEnds } from "../../src/core/boundedArray.js";
import { recordMemorySample, MAX_MEMORY_SAMPLES } from "../../src/core/memoryDiagnostics.js";
import { captureDataLayer } from "../../src/capture-modules/dataLayer.js";
import { attachGa4NetworkCapture } from "../../src/capture-modules/ga4NetworkEvents.js";
import { recordDiagnosticError } from "../../src/capture-modules/errors.js";
import { executeCapture } from "../../src/actions/capture.js";
import {
  MAX_DATA_LAYER_RAW_ENTRIES_PER_SNAPSHOT,
  MAX_GA4_NETWORK_EVENTS,
  MAX_ERROR_ENTRIES,
  MAX_SCREENSHOTS_KEEP_FIRST,
  readMaxScreenshotsPerRun,
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

test("capPreservingEnds keeps both the first entries and the most recent once over the cap", () => {
  const arr = Array.from({ length: 20 }, (_, i) => i);
  const result = capPreservingEnds(arr, 5, 2);
  // First 2 (head) + most recent 3 (tail) -- the middle (2..16) is what's dropped.
  assert.deepEqual(result, [0, 1, 17, 18, 19]);
});

test("capPreservingEnds never drops anything while under the cap", () => {
  const arr = [1, 2, 3];
  assert.deepEqual(capPreservingEnds(arr, 5, 2), [1, 2, 3]);
});

test("capPreservingEnds clamps keepFirst to at most half of max, so the final entry always survives", () => {
  const arr = Array.from({ length: 10 }, (_, i) => i);
  // keepFirst (8) is far larger than max (4) -- without clamping this would keep only
  // the first 4 and lose the final entry entirely.
  const result = capPreservingEnds(arr, 4, 8);
  assert.equal(result.length, 4);
  assert.equal(result[result.length - 1], 9, "the most recent entry must always survive");
  assert.equal(result[0], 0, "the first entry must still survive");
});

test("appendBoundedPreservingEnds behaves identically to repeated capPreservingEnds calls, one append at a time", () => {
  let arr: number[] = [];
  for (let i = 0; i < 20; i++) {
    arr = appendBoundedPreservingEnds(arr, i, 5, 2);
  }
  assert.deepEqual(arr, [0, 1, 17, 18, 19]);
});

test("appendBoundedPreservingEnds never exceeds max at any point during repeated appends", () => {
  let arr: number[] = [];
  for (let i = 0; i < 50; i++) {
    arr = appendBoundedPreservingEnds(arr, i, 5, 2);
    assert.ok(arr.length <= 5);
  }
});

test("executeCapture bounds captures.screenshots to the configured maximum, preserving the first captures and the most recent", async () => {
  const fakePage = {
    async screenshot() {
      return Buffer.from("");
    },
    url() {
      return "http://127.0.0.1/current-page.html";
    },
  } as unknown as Page;

  const captures: Captures = {};
  const max = readMaxScreenshotsPerRun();
  const totalCaptures = max + 10;
  for (let i = 0; i < totalCaptures; i++) {
    await executeCapture(fakePage, captures, i, ["screenshots"]);
  }

  assert.equal(captures.screenshots?.length, max);
  for (let i = 0; i < MAX_SCREENSHOTS_KEEP_FIRST; i++) {
    assert.equal(captures.screenshots?.[i]?.stepIndex, i, `expected the ${i}th earliest screenshot to survive`);
  }
  assert.equal(
    captures.screenshots?.[captures.screenshots.length - 1]?.stepIndex,
    totalCaptures - 1,
    "expected the most recent screenshot to survive",
  );
});
