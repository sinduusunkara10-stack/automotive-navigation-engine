import { Redis as IORedis } from "ioredis";
import { createRedisJourneyMemoryStore, type JourneyMemoryRedisLike, type JourneyMemoryStore } from "./store.js";
import type { JourneyMemoryFlags, JourneyMemoryTimingConfig } from "../../config/journeyMemoryConfig.js";

/**
 * Optional injection point for tests (e.g. ioredis-mock), mirroring
 * src/api/taskStoreFactory.ts's own CreateTaskStoreOptions.
 */
export interface CreateJourneyMemoryStoreOptions {
  redisClientFactory?: (url: string) => JourneyMemoryRedisLike & { connect(): Promise<void>; quit(): Promise<unknown> };
}

/**
 * Unlike src/api/taskStoreFactory.ts's createTaskStore (which fails fast -- a misconfigured
 * TASK_STORE=redis must abort startup, since run-record persistence is load-bearing),
 * journey memory must fail *safe*: an unavailable/misconfigured Redis here never blocks the
 * server from starting or a run from proceeding -- it only means cross-run memory is
 * silently absent (see binding contract §1's fail-safe requirement, and
 * docs/journey-memory.md). Does NOT provision a new datastore: reuses the same REDIS_URL
 * env var / ioredis dependency the existing task store already uses, under a distinct
 * keyspace (nav-engine:journey-memory:*).
 */
export async function createJourneyMemoryStore(
  flags: JourneyMemoryFlags,
  timing: Pick<JourneyMemoryTimingConfig, "retentionDays">,
  env: NodeJS.ProcessEnv = process.env,
  options: CreateJourneyMemoryStoreOptions = {},
): Promise<JourneyMemoryStore | undefined> {
  if (!flags.enabled) {
    return undefined;
  }
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    return undefined;
  }

  try {
    const client: JourneyMemoryRedisLike & { connect(): Promise<void>; quit(): Promise<unknown> } = options.redisClientFactory
      ? options.redisClientFactory(redisUrl)
      : (new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 }) as unknown as JourneyMemoryRedisLike & {
          connect(): Promise<void>;
          quit(): Promise<unknown>;
        });
    await client.connect();
    return createRedisJourneyMemoryStore(client, timing);
  } catch {
    return undefined;
  }
}
