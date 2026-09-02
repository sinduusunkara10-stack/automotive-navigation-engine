import { test } from "node:test";
import assert from "node:assert/strict";

import { diffDataLayer, type DataLayerSnapshot } from "../../src/capture-modules/dataLayerDelta.js";

/**
 * Pure-function coverage of the generic, mechanical dataLayer cursor/position delta (see
 * src/capture-modules/dataLayerDelta.ts) -- no page/browser needed. Every scenario the
 * function documents itself as handling, verified directly.
 */

const unavailable: DataLayerSnapshot = { available: false, raw: [] };

test("unavailable before and after: reported as unavailable, not as present-but-empty", () => {
  const delta = diffDataLayer(unavailable, unavailable);
  assert.deepEqual(delta, { available: false, newEntries: [] });
});

test("available after but not before (dataLayer newly materialised): reported as available and replaced, entire array is 'new'", () => {
  const after: DataLayerSnapshot = { available: true, raw: [{ event: "page_view" }] };
  const delta = diffDataLayer(unavailable, after);
  assert.equal(delta.available, true);
  assert.equal(delta.replaced, true);
  assert.deepEqual(delta.newEntries, after.raw);
});

test("available before but not after (dataLayer removed/undefined between snapshots): reported as unavailable", () => {
  const before: DataLayerSnapshot = { available: true, raw: [{ event: "page_view" }] };
  const delta = diffDataLayer(before, unavailable);
  assert.deepEqual(delta, { available: false, newEntries: [] });
});

test("present and identical before/after: available true, empty newEntries -- 'present but unchanged', distinct from unavailable", () => {
  const snapshot: DataLayerSnapshot = { available: true, raw: [{ event: "page_view" }] };
  const delta = diffDataLayer(snapshot, snapshot);
  assert.equal(delta.available, true);
  assert.deepEqual(delta.newEntries, []);
  assert.equal(delta.replaced, undefined, "an unchanged array must not be reported as replaced");
});

test("before is a genuine prefix of after: newEntries is just the appended suffix (the common case)", () => {
  const before: DataLayerSnapshot = { available: true, raw: [{ event: "page_view" }] };
  const after: DataLayerSnapshot = {
    available: true,
    raw: [{ event: "page_view" }, { event: "option_selected", option: "trim" }],
  };
  const delta = diffDataLayer(before, after);
  assert.equal(delta.available, true);
  assert.equal(delta.replaced, undefined);
  assert.deepEqual(delta.newEntries, [{ event: "option_selected", option: "trim" }]);
});

test("after is shorter than before (array reset to fewer entries): reported as replaced, entire after array is 'new'", () => {
  const before: DataLayerSnapshot = {
    available: true,
    raw: [{ event: "page_view" }, { event: "option_selected" }],
  };
  const after: DataLayerSnapshot = { available: true, raw: [{ event: "page_view", page: "fresh" }] };
  const delta = diffDataLayer(before, after);
  assert.equal(delta.replaced, true);
  assert.deepEqual(delta.newEntries, after.raw);
});

test("same length but diverging content (replaced with an equal-length array): reported as replaced", () => {
  const before: DataLayerSnapshot = { available: true, raw: [{ event: "page_view" }] };
  const after: DataLayerSnapshot = { available: true, raw: [{ event: "different_event" }] };
  const delta = diffDataLayer(before, after);
  assert.equal(delta.replaced, true);
  assert.deepEqual(delta.newEntries, after.raw);
});
