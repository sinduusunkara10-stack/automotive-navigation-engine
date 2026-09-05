import { Redis as IORedis } from "ioredis";
import { createInMemoryTaskStore } from "./inMemoryTaskStore.js";
import { createRedisTaskStore, type RedisLike } from "./redisTaskStore.js";
import type { TaskStore } from "./taskStore.js";
import { readTaskStoreTimingConfig } from "../config/taskStoreConfig.js";

export class InvalidTaskStoreBackendError extends Error {
  constructor(raw: string) {
    super(`TASK_STORE must be "memory" or "redis". Received: "${raw}".`);
    this.name = "InvalidTaskStoreBackendError";
  }
}

export class MissingRedisUrlError extends Error {
  constructor() {
    super("REDIS_URL is required when TASK_STORE=redis. Set it in your environment (see .env.example).");
    this.name = "MissingRedisUrlError";
  }
}

export class RedisUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      `Could not connect to Redis (TASK_STORE=redis): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "RedisUnavailableError";
  }
}

/**
 * Optional injection point for tests: pass a pre-built ioredis-compatible client (e.g.
 * ioredis-mock) instead of connecting to a real Redis server.
 */
export interface CreateTaskStoreOptions {
  redisClientFactory?: (url: string) => RedisLike & { connect(): Promise<void>; quit(): Promise<unknown> };
}

/**
 * Selects and constructs the run-record persistence backend from TASK_STORE/REDIS_URL,
 * matching this repo's fail-fast-at-startup convention (see src/api/auth.ts,
 * src/config/initialNavigationConfig.ts): a misconfigured or unreachable Redis aborts
 * server creation clearly, rather than the process silently falling back to in-memory (an
 * operator who set TASK_STORE=redis needs to know immediately if that never actually took
 * effect) or serving requests that would each fail individually once they try to persist.
 */
export async function createTaskStore(
  env: NodeJS.ProcessEnv = process.env,
  options: CreateTaskStoreOptions = {},
): Promise<TaskStore> {
  const backend = env.TASK_STORE?.trim() || "memory";
  const timing = readTaskStoreTimingConfig(env);

  if (backend === "memory") {
    return createInMemoryTaskStore(timing);
  }

  if (backend !== "redis") {
    throw new InvalidTaskStoreBackendError(backend);
  }

  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) {
    throw new MissingRedisUrlError();
  }

  const client: RedisLike & { connect(): Promise<void>; quit(): Promise<unknown> } = options.redisClientFactory
    ? options.redisClientFactory(redisUrl)
    : new IORedis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });

  try {
    await client.connect();
  } catch (err) {
    await client.quit().catch(() => {});
    throw new RedisUnavailableError(err);
  }

  // The factory's own connect() call above already proved reachability; the store then
  // reuses the same connected client for every subsequent read/write.
  return createRedisTaskStore(client, timing);
}
