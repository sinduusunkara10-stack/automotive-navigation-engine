import type { JourneyMemorySegment } from "../../types/journeyMemory.js";
import type { JourneyMemoryTimingConfig } from "../../config/journeyMemoryConfig.js";

const KEY_PREFIX = "nav-engine:journey-memory:";

function recordKey(domain: string, id: string): string {
  return `${KEY_PREFIX}record:${domain}:${id}`;
}

function indexKey(domain: string): string {
  return `${KEY_PREFIX}index:${domain}`;
}

function marketIndexKey(market: string): string {
  return `${KEY_PREFIX}market-index:${market.toLowerCase()}`;
}

const GLOBAL_INDEX_KEY = `${KEY_PREFIX}global-index`;
/** Global (cross-domain) index is only ever used for Tier3/4 fallback, and only ever surfaces structural/abstract guidance (see tiering.ts's isStructuralOnlyTier) -- bounded hard, never grown unbounded, since it exists purely as a last-resort widening path. */
const GLOBAL_INDEX_SCAN_LIMIT = 500;

/** Domain qualification lets two different registrable domains never collide on the same bare record id in the market/global indices. */
function qualifiedId(domain: string, id: string): string {
  return `${domain}::${id}`;
}

/**
 * The minimal subset of the ioredis client this store actually calls -- kept narrow and
 * structural (not a nominal ioredis import), the same convention as
 * src/api/redisTaskStore.ts's own RedisLike, so a test can inject any compatible client
 * (e.g. ioredis-mock).
 */
export interface JourneyMemoryRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  srem(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface JourneyMemoryStore {
  /**
   * Atomic per-record write: a single `SET key value EX ttl` is itself an atomic Redis
   * operation, and each record lives at its own key -- so concurrent writers producing
   * different record ids never race with each other at the storage layer (last-write-wins
   * is only ever possible for the *same* record id, and even then each write is a complete,
   * internally-consistent JSON value, never a partial one). The index SADD is a separate,
   * idempotent operation: a lost race on it just means a harmless repeat, never data loss
   * or corruption -- documented here per the binding contract's own atomicity requirement.
   */
  writeRecord(segment: JourneyMemorySegment): Promise<void>;
  readRecord(domain: string, id: string): Promise<JourneyMemorySegment | undefined>;
  deleteRecord(domain: string, id: string): Promise<void>;
  listDomain(domain: string, limit?: number): Promise<JourneyMemorySegment[]>;
  domainRecordIds(domain: string): Promise<string[]>;
  /** Tier3 (different domain, same market) lookup path -- see tiering.ts. */
  listByMarket(market: string, limit?: number): Promise<JourneyMemorySegment[]>;
  /** Tier4 (different domain, different market) last-resort lookup path -- see tiering.ts. */
  listGlobal(limit?: number): Promise<JourneyMemorySegment[]>;
}

export function createRedisJourneyMemoryStore(
  client: JourneyMemoryRedisLike,
  timing: Pick<JourneyMemoryTimingConfig, "retentionDays">,
): JourneyMemoryStore {
  const ttlSeconds = timing.retentionDays * 24 * 60 * 60;

  return {
    async writeRecord(segment) {
      const domain = segment.provenance.registrableDomain;
      await client.set(recordKey(domain, segment.id), JSON.stringify(segment), "EX", ttlSeconds);
      await client.sadd(indexKey(domain), segment.id);
      await client.expire(indexKey(domain), ttlSeconds);
      if (segment.provenance.market) {
        const mKey = marketIndexKey(segment.provenance.market);
        await client.sadd(mKey, qualifiedId(domain, segment.id));
        await client.expire(mKey, ttlSeconds);
      }
      await client.sadd(GLOBAL_INDEX_KEY, qualifiedId(domain, segment.id));
      await client.expire(GLOBAL_INDEX_KEY, ttlSeconds);
    },

    async readRecord(domain, id) {
      const raw = await client.get(recordKey(domain, id));
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as JourneyMemorySegment;
      } catch {
        return undefined;
      }
    },

    async deleteRecord(domain, id) {
      await client.del(recordKey(domain, id));
      await client.srem(indexKey(domain), id);
      await client.srem(GLOBAL_INDEX_KEY, qualifiedId(domain, id));
    },

    async domainRecordIds(domain) {
      return client.smembers(indexKey(domain));
    },

    async listDomain(domain, limit) {
      const ids = await client.smembers(indexKey(domain));
      const bounded = limit ? ids.slice(0, limit) : ids;
      const results = await Promise.all(
        bounded.map(async (id) => {
          const raw = await client.get(recordKey(domain, id));
          if (!raw) return undefined;
          try {
            return JSON.parse(raw) as JourneyMemorySegment;
          } catch {
            return undefined;
          }
        }),
      );
      return results.filter((r): r is JourneyMemorySegment => r !== undefined);
    },

    async listByMarket(market, limit) {
      const qualifiedIds = await client.smembers(marketIndexKey(market));
      const bounded = (limit ? qualifiedIds.slice(0, limit) : qualifiedIds).slice(0, GLOBAL_INDEX_SCAN_LIMIT);
      const results = await Promise.all(
        bounded.map(async (qid) => {
          const sep = qid.indexOf("::");
          if (sep < 0) return undefined;
          const domain = qid.slice(0, sep);
          const id = qid.slice(sep + 2);
          const raw = await client.get(recordKey(domain, id));
          if (!raw) return undefined;
          try {
            return JSON.parse(raw) as JourneyMemorySegment;
          } catch {
            return undefined;
          }
        }),
      );
      return results.filter((r): r is JourneyMemorySegment => r !== undefined);
    },

    async listGlobal(limit) {
      const qualifiedIds = await client.smembers(GLOBAL_INDEX_KEY);
      const bounded = (limit ? qualifiedIds.slice(0, limit) : qualifiedIds).slice(0, GLOBAL_INDEX_SCAN_LIMIT);
      const results = await Promise.all(
        bounded.map(async (qid) => {
          const sep = qid.indexOf("::");
          if (sep < 0) return undefined;
          const domain = qid.slice(0, sep);
          const id = qid.slice(sep + 2);
          const raw = await client.get(recordKey(domain, id));
          if (!raw) return undefined;
          try {
            return JSON.parse(raw) as JourneyMemorySegment;
          } catch {
            return undefined;
          }
        }),
      );
      return results.filter((r): r is JourneyMemorySegment => r !== undefined);
    },
  };
}

/**
 * Timeout-wraps a store operation to the given ceiling -- used by the orchestrator
 * (service.ts) to enforce the binding contract's pre-run/recovery lookup time budgets
 * (§9). Resolves to { timedOut: true } rather than throwing, so a slow/unavailable Redis
 * never fails the run -- it only means journey memory is silently absent for this
 * decision, with the reason recorded in diagnostics by the caller.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: false; value: T } | { timedOut: true }> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });
  try {
    const result = await Promise.race([promise.then((value) => ({ timedOut: false as const, value })), timeout]);
    return result;
  } finally {
    clearTimeout(timer!);
  }
}
