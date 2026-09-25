import { test } from "node:test";
import assert from "node:assert/strict";
import RedisMock from "ioredis-mock";

import { createRedisJourneyMemoryStore, withTimeout } from "../../src/core/journeyMemory/store.js";
import { createJourneyMemoryStore } from "../../src/core/journeyMemory/storeFactory.js";
import type { ForwardMemorySegment } from "../../src/types/journeyMemory.js";

const TIMING = { retentionDays: 90 };

// ioredis-mock instances created with no options share the same in-memory backing store by
// default (the same behaviour two real ioredis clients pointed at the same REDIS_URL would
// have -- exploited deliberately by the "persistence survives a simulated process restart"
// test below). Every other test here therefore uses its own distinct domain so it never
// collides with data another test in this same process/mock left behind.
let domainCounter = 0;
function uniqueDomain(): string {
  domainCounter += 1;
  return `example-${domainCounter}.test`;
}

function segment(id: string, domain: string, overrides: Partial<ForwardMemorySegment> = {}): ForwardMemorySegment {
  return {
    kind: "forward",
    id,
    schemaVersion: "1.0.0",
    sourcePage: { registrableDomain: domain, normalizedPath: "/configurator", semanticSignature: "configure" },
    action: { actionType: "click", semanticLabel: "button::Continue" },
    destinationPage: { registrableDomain: domain, normalizedPath: "/configurator/finance", semanticSignature: "finance" },
    verifiedMilestoneIntent: "reached finance step",
    outcome: "success",
    confidence: 0.9,
    evidenceTier: "tier1",
    routePosition: 1,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-x", registrableDomain: domain },
    ...overrides,
  };
}

test("writeRecord + readRecord round-trips a segment", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  const s = segment("rec-1", domain);
  await store.writeRecord(s);
  const read = await store.readRecord(domain, "rec-1");
  assert.deepEqual(read, s);
});

test("listDomain returns every record written for that domain", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  await store.writeRecord(segment("rec-2", domain));
  const all = await store.listDomain(domain);
  assert.equal(all.length, 2);
});

test("deleteRecord removes a record from both the value and the domain index", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await store.writeRecord(segment("rec-1", domain));
  await store.deleteRecord(domain, "rec-1");
  assert.equal(await store.readRecord(domain, "rec-1"), undefined);
  assert.deepEqual(await store.domainRecordIds(domain), []);
});

test("listByMarket and listGlobal surface records across domains (tier3/tier4 lookup paths)", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domainA = uniqueDomain();
  const domainB = uniqueDomain();
  const market = `market-${domainA}`;
  await store.writeRecord(segment("rec-1", domainA, { provenance: { runId: "run-a", registrableDomain: domainA, market } }));
  await store.writeRecord(segment("rec-2", domainB, { provenance: { runId: "run-b", registrableDomain: domainB, market } }));
  const byMarket = await store.listByMarket(market);
  assert.equal(byMarket.length, 2);
  const global = await store.listGlobal();
  assert.ok(global.length >= 2);
});

test("concurrent writers writing distinct record ids never corrupt each other's records (atomic per-key SET)", async () => {
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  const domain = uniqueDomain();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => store.writeRecord(segment(`rec-${i}`, domain, { confidence: i / 20 }))),
  );
  const all = await store.listDomain(domain);
  assert.equal(all.length, 20);
  const ids = new Set(all.map((r) => r.id));
  assert.equal(ids.size, 20);
});

test("persistence survives a simulated process restart -- a new client instance sees the same data (ioredis-mock's default shared backing store, same as two real ioredis clients pointed at the same REDIS_URL)", async () => {
  const domain = uniqueDomain();
  const clientA = new RedisMock();
  const storeA = createRedisJourneyMemoryStore(clientA as never, TIMING);
  await storeA.writeRecord(segment("rec-1", domain));

  const clientB = new RedisMock();
  const storeB = createRedisJourneyMemoryStore(clientB as never, TIMING);
  const read = await storeB.readRecord(domain, "rec-1");
  assert.ok(read);
  assert.equal(read!.id, "rec-1");
});

test("withTimeout resolves timedOut:true when the promise takes longer than the ceiling", async () => {
  const slow = new Promise((resolve) => setTimeout(resolve, 50));
  const result = await withTimeout(slow, 5);
  assert.equal(result.timedOut, true);
});

test("withTimeout resolves the value when the promise finishes within the ceiling", async () => {
  const fast = Promise.resolve(42);
  const result = await withTimeout(fast, 1000);
  assert.equal(result.timedOut, false);
  if (!result.timedOut) {
    assert.equal(result.value, 42);
  }
});

/**
 * Issue 5 (Redis persistence verification, binding acceptance-issue contract): the
 * remaining store-level tests this issue calls for beyond what the tests above already
 * cover (round-trip, listDomain, delete, tier3/tier4 lookup paths, concurrent writers,
 * process-restart survival). All against ioredis-mock (an in-process Redis test-double),
 * never a live network Redis -- see docs/journey-memory.md's own "what's verified where"
 * section for what remains owner-only.
 */

test("a written record is visible to a second, independent store instance (not process-local caching)", async () => {
  const domain = uniqueDomain();
  const writer = createRedisJourneyMemoryStore(new RedisMock() as never, TIMING);
  await writer.writeRecord(segment("rec-visibility-1", domain));

  const reader = createRedisJourneyMemoryStore(new RedisMock() as never, TIMING);
  const found = await reader.readRecord(domain, "rec-visibility-1");
  assert.ok(found, "expected the record written by one store instance to be readable from another");
});

test("a written record survives a simulated client disconnect/reconnect", async () => {
  const domain = uniqueDomain();
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, TIMING);
  await store.writeRecord(segment("rec-reconnect-1", domain));

  await client.disconnect();
  await client.connect();

  const found = await store.readRecord(domain, "rec-reconnect-1");
  assert.ok(found, "expected the record to survive a disconnect/reconnect");
});

test("TTL is actually set on write (record key + domain index key both carry a positive TTL bounded by retentionDays)", async () => {
  const domain = uniqueDomain();
  const client = new RedisMock();
  const store = createRedisJourneyMemoryStore(client as never, { retentionDays: 1 });
  await store.writeRecord(segment("rec-ttl-1", domain));

  const recordTtl = await client.ttl(`nav-engine:journey-memory:record:${domain}:rec-ttl-1`);
  const indexTtl = await client.ttl(`nav-engine:journey-memory:index:${domain}`);
  assert.ok(recordTtl > 0 && recordTtl <= 86400, `expected a positive TTL <= 1 day in seconds, got ${recordTtl}`);
  assert.ok(indexTtl > 0 && indexTtl <= 86400, `expected the domain index key to also carry a TTL, got ${indexTtl}`);
});

/**
 * storeFactory.ts (createJourneyMemoryStore): the fail-safe construction path
 * src/core/engine.ts actually calls -- distinct from the store.ts tests above, which
 * exercise an already-constructed store directly.
 */

test("createJourneyMemoryStore fails safe (returns undefined, never throws) when REDIS_URL is unset", async () => {
  const store = await createJourneyMemoryStore({ enabled: true, readEnabled: true, writeEnabled: true }, TIMING, {});
  assert.equal(store, undefined);
});

test("createJourneyMemoryStore fails safe when the injected client factory throws on connect", async () => {
  const store = await createJourneyMemoryStore(
    { enabled: true, readEnabled: true, writeEnabled: true },
    TIMING,
    { REDIS_URL: "redis://example-redis-host:6379" },
    {
      redisClientFactory: () => ({
        connect: async () => {
          throw new Error("simulated connection failure");
        },
        quit: async () => undefined,
        get: async () => null,
        set: async () => "OK",
        del: async () => 1,
        sadd: async () => 1,
        srem: async () => 1,
        smembers: async () => [],
        expire: async () => 1,
      }),
    },
  );
  assert.equal(store, undefined, "an unreachable Redis must never throw up through createJourneyMemoryStore/the run");
});

test("createJourneyMemoryStore returns undefined (fully inert) when flags.enabled is false, regardless of REDIS_URL", async () => {
  const store = await createJourneyMemoryStore(
    { enabled: false, readEnabled: false, writeEnabled: false },
    TIMING,
    { REDIS_URL: "redis://example-redis-host:6379" },
  );
  assert.equal(store, undefined);
});

test("createJourneyMemoryStore, given a working injected mock client factory, produces a functioning store using the same REDIS_URL pattern as the task store", async () => {
  const domain = uniqueDomain();
  const backing = new RedisMock();
  const store = await createJourneyMemoryStore(
    { enabled: true, readEnabled: true, writeEnabled: true },
    TIMING,
    { REDIS_URL: "redis://example-redis-host:6379" },
    {
      redisClientFactory: () => ({ ...(backing as unknown as object), connect: async () => undefined, quit: async () => undefined }) as never,
    },
  );
  assert.ok(store, "expected a working store to be produced");
  await store?.writeRecord(segment("rec-factory-1", domain));
  const found = await store?.readRecord(domain, "rec-factory-1");
  assert.ok(found);
});
