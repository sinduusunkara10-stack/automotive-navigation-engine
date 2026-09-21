import { test } from "node:test";
import assert from "node:assert/strict";

import { findNewPages } from "../../src/actions/pagesReconciliation.js";

test("findNewPages returns nothing when after is a subset of before", () => {
  const a = {};
  const b = {};
  assert.deepEqual(findNewPages([a, b], [a]), []);
});

test("findNewPages returns entries present in after but not in before, by reference", () => {
  const a = {};
  const b = {};
  const c = {};
  assert.deepEqual(findNewPages([a], [a, b, c]), [b, c]);
});

test("findNewPages treats two distinct objects with identical shape as different", () => {
  const before = [{ id: 1 }];
  const after = [{ id: 1 }];
  // Reference equality, not structural equality -- a fresh object with the same shape as an
  // existing "before" entry is still reported as new, matching how Playwright Page objects
  // are only ever equal to themselves, never to a structurally similar object.
  assert.deepEqual(findNewPages(before, after), after);
});

test("findNewPages is a pure function: neither input array is mutated", () => {
  const a = {};
  const b = {};
  const before = [a];
  const after = [a, b];
  findNewPages(before, after);
  assert.deepEqual(before, [a]);
  assert.deepEqual(after, [a, b]);
});

test("findNewPages returns everything when before is empty", () => {
  const a = {};
  const b = {};
  assert.deepEqual(findNewPages([], [a, b]), [a, b]);
});

test("findNewPages returns nothing when after is empty", () => {
  const a = {};
  assert.deepEqual(findNewPages([a], []), []);
});
