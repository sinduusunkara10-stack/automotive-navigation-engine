import { test } from "node:test";
import assert from "node:assert/strict";
import RedisMock from "ioredis-mock";

import { createRedisJourneyMemoryStore } from "../../src/core/journeyMemory/store.js";
import { recordJourneySegments, retrieveJourneyMemoryContext } from "../../src/core/journeyMemory/service.js";
import type { ForwardMemorySegment } from "../../src/types/journeyMemory.js";

const TIMING = { retentionDays: 90 };
const FLAGS_FULL = { enabled: true, readEnabled: true, writeEnabled: true };
const FLAGS_READ_OFF = { enabled: true, readEnabled: false, writeEnabled: true };
const FLAGS_OFF = { enabled: false, readEnabled: false, writeEnabled: false };

// See journeyMemoryStore.test.ts's own comment: ioredis-mock shares its backing store by
// default across every `new RedisMock()` in this process, so each test uses its own domain.
let domainCounter = 0;
function uniqueDomain(): string {
  domainCounter += 1;
  return `example-svc-${domainCounter}.test`;
}

function segment(id: string, domain: string, overrides: Partial<ForwardMemorySegment> = {}): ForwardMemorySegment {
  return {
    kind: "forward",
    id,
    schemaVersion: "1.0.0",
    sourcePage: { registrableDomain: domain, normalizedPath: "/configurator", semanticSignature: "configure price vehicle" },
    action: { actionType: "click", semanticLabel: "button::Continue" },
    destinationPage: { registrableDomain: domain, normalizedPath: "/configurator/finance", semanticSignature: "finance personalise" },
    verifiedMilestoneIntent: "reached finance step",
    outcome: "success",
    confidence: 0.9,
    evidenceTier: "tier1",
    routePosition: 1,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-x", registrableDomain: domain, market: "uk" },
    ...overrides,
  };
}

function lookupParamsFor(domain: string) {
  return {
    timeoutMs: 1000,
    objectiveText: "reach the finance personalisation step",
    milestoneIntent: "reached finance step",
    currentSemanticSignature: "configure price vehicle",
    currentDomain: domain,
    currentMarket: "uk",
  };
}

test("retrieval is disabled (unavailableReason: disabled) when journey memory is off", async () => {
  const ctx = await retrieveJourneyMemoryContext(undefined, FLAGS_OFF, lookupParamsFor(uniqueDomain()));
  assert.equal(ctx.enabled, false);
  assert.equal(ctx.unavailableReason, "disabled");
});

test("retrieval reports storage_unavailable when no store is available", async () => {
  const ctx = await retrieveJourneyMemoryContext(undefined, FLAGS_FULL, lookupParamsFor(uniqueDomain()));
  assert.equal(ctx.storageAvailable, false);
  assert.equal(ctx.unavailableReason, "storage_unavailable");
});

test("retrieval reports no_match when the store is available but empty", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const ctx = await retrieveJourneyMemoryContext(store, FLAGS_FULL, lookupParamsFor(uniqueDomain()));
  assert.equal(ctx.storageAvailable, true);
  assert.equal(ctx.lookupCompleted, true);
  assert.equal(ctx.unavailableReason, "no_match");
});

test("retrieval finds and accepts a strongly matching same-domain same-market record", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  const ctx = await retrieveJourneyMemoryContext(store, FLAGS_FULL, lookupParamsFor(domain));
  assert.equal(ctx.candidatesConsidered, 1);
  assert.ok(ctx.accepted.length + ctx.ambiguous.length >= 1);
});

test("retrieval respects the READ_ENABLED flag independent of ENABLED/WRITE (read-off collects without using)", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  const ctx = await retrieveJourneyMemoryContext(store, FLAGS_READ_OFF, lookupParamsFor(domain));
  assert.equal(ctx.unavailableReason, "disabled");
  assert.equal(ctx.accepted.length, 0);
});

test("retrieval reports durations for every measured phase", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  const ctx = await retrieveJourneyMemoryContext(store, FLAGS_FULL, lookupParamsFor(domain));
  assert.ok(ctx.durations.totalMs >= 0);
  assert.ok(typeof ctx.durations.redisMs === "number");
  assert.ok(typeof ctx.durations.scoringMs === "number");
});

test("retrieval honours a very small timeout budget and reports timeout", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  const ctx = await retrieveJourneyMemoryContext(store, FLAGS_FULL, { ...lookupParamsFor(domain), timeoutMs: 0 });
  assert.equal(ctx.lookupCompleted, false);
  assert.equal(ctx.unavailableReason, "timeout");
});

test("recordJourneySegments is a no-op when write is disabled", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  const result = await recordJourneySegments(store, { enabled: true, readEnabled: true, writeEnabled: false }, [segment("rec-1", domain)], 500);
  assert.equal(result.segmentsWritten, 0);
});

test("recordJourneySegments writes segments and applies dedup precedence against existing records", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("older", domain, { outcome: "success", confidence: 0.8 }));
  const result = await recordJourneySegments(store, FLAGS_FULL, [segment("newer", domain, { outcome: "success", confidence: 0.95 })], 500);
  assert.equal(result.segmentsWritten, 1);
  const remaining = await store.listDomain(domain);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, "newer");
});

test("recordJourneySegments never fails the run when Redis errors -- fails safe", async () => {
  const brokenStore = {
    writeRecord: async () => {
      throw new Error("redis exploded");
    },
    readRecord: async () => undefined,
    deleteRecord: async () => {},
    listDomain: async () => {
      throw new Error("redis exploded");
    },
    domainRecordIds: async () => [],
    listByMarket: async () => [],
    listGlobal: async () => [],
  };
  const result = await recordJourneySegments(brokenStore as never, FLAGS_FULL, [segment("rec-1", uniqueDomain())], 500);
  assert.equal(result.segmentsWritten, 0);
});

test("500-record-per-domain cap is enforced lazily on write", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  const segments = Array.from({ length: 5 }, (_, i) =>
    segment(`rec-${i}`, domain, { confidence: i / 10, action: { actionType: "click", semanticLabel: `button::Step-${i}` } }),
  );
  await recordJourneySegments(store, FLAGS_FULL, segments, 3);
  const remaining = await store.listDomain(domain);
  assert.ok(remaining.length <= 3);
});
