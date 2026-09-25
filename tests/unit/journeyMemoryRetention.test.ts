import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyOutcomePrecedence,
  equivalenceKey,
  MULTI_FAILURE_DECAY_THRESHOLD,
  selectRecordsToEvict,
} from "../../src/core/journeyMemory/retention.js";
import type { ForwardMemorySegment } from "../../src/types/journeyMemory.js";

function segment(overrides: Partial<ForwardMemorySegment> & { id: string }): ForwardMemorySegment {
  return {
    kind: "forward",
    schemaVersion: "1.0.0",
    sourcePage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configurator", semanticSignature: "configure" },
    action: { actionType: "click", semanticLabel: "button::Continue" },
    destinationPage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configurator/finance", semanticSignature: "finance" },
    verifiedMilestoneIntent: "reached finance step",
    outcome: "success",
    confidence: 0.9,
    evidenceTier: "tier1",
    routePosition: 1,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-x", registrableDomain: "example-automotive-oem.com" },
    ...overrides,
  };
}

test("equivalenceKey is the same for two structurally identical forward segments from different runs", () => {
  const a = segment({ id: "a" });
  const b = segment({ id: "b", provenance: { runId: "run-y", registrableDomain: "example-automotive-oem.com" } });
  assert.equal(equivalenceKey(a), equivalenceKey(b));
});

test("a newer verified success supersedes (deletes) an older equivalent success", () => {
  const older = segment({ id: "older", outcome: "success", confidence: 0.9 });
  const incoming = segment({ id: "newer", outcome: "success", confidence: 0.95 });
  const result = applyOutcomePrecedence(incoming, [older]);
  assert.deepEqual(result.toDelete, ["older"]);
  assert.ok(result.toWrite.some((s) => s.id === "newer"));
});

test("a single new failure never deletes or decays an older equivalent success", () => {
  const older = segment({ id: "older-success", outcome: "success", confidence: 0.9 });
  const incoming = segment({ id: "new-failure", outcome: "failure", confidence: 0.2 });
  const result = applyOutcomePrecedence(incoming, [older]);
  assert.deepEqual(result.toDelete, []);
  assert.equal(result.confidenceChanges.length, 0);
  assert.ok(result.toWrite.some((s) => s.id === "new-failure"));
});

test(`confidence decays only once ${MULTI_FAILURE_DECAY_THRESHOLD} comparable recent failures have accumulated`, () => {
  const older = segment({ id: "older-success", outcome: "success", confidence: 0.9 });
  const failures = Array.from({ length: MULTI_FAILURE_DECAY_THRESHOLD - 1 }, (_, i) =>
    segment({ id: `fail-${i}`, outcome: "failure", confidence: 0.2 }),
  );
  const incoming = segment({ id: "final-failure", outcome: "failure", confidence: 0.2 });
  const result = applyOutcomePrecedence(incoming, [older, ...failures]);
  assert.equal(result.confidenceChanges.length, 1);
  assert.equal(result.confidenceChanges[0]?.recordId, "older-success");
  assert.ok(result.confidenceChanges[0]!.newConfidence < result.confidenceChanges[0]!.previousConfidence);
});

test("a new verified success restores a decayed equivalent record's confidence", () => {
  const decayed = segment({ id: "decayed", outcome: "success", confidence: 0.5 });
  const incoming = segment({ id: "new-success", outcome: "success", confidence: 0.9 });
  const result = applyOutcomePrecedence(incoming, [decayed]);
  const restored = result.toWrite.find((s) => s.id === "decayed");
  assert.ok(restored);
  assert.ok(restored!.confidence > 0.5);
});

test("selectRecordsToEvict evicts the lowest-confidence, then oldest, records once over the cap", () => {
  const records = [
    segment({ id: "low", confidence: 0.1, timestamp: new Date(Date.now() - 1000).toISOString() }),
    segment({ id: "mid", confidence: 0.5, timestamp: new Date().toISOString() }),
    segment({ id: "high", confidence: 0.9, timestamp: new Date().toISOString() }),
  ];
  const toEvict = selectRecordsToEvict(records, 2);
  assert.deepEqual(toEvict, ["low"]);
});

test("selectRecordsToEvict evicts nothing when at or under the cap", () => {
  const records = [segment({ id: "a" }), segment({ id: "b" })];
  assert.deepEqual(selectRecordsToEvict(records, 2), []);
});
