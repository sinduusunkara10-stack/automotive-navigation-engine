import { test } from "node:test";
import assert from "node:assert/strict";
import RedisMock from "ioredis-mock";

import {
  createTaskStore,
  InvalidTaskStoreBackendError,
  MissingRedisUrlError,
  RedisUnavailableError,
} from "../../src/api/taskStoreFactory.js";

test("defaults to the in-memory backend when TASK_STORE is unset", async () => {
  const store = await createTaskStore({});
  await store.createRun("run_factory_1", "task-factory-1");
  const record = await store.getRun("run_factory_1");
  assert.equal(record?.status, "running");
});

test("TASK_STORE=memory is equivalent to unset", async () => {
  const store = await createTaskStore({ TASK_STORE: "memory" });
  await store.createRun("run_factory_2", "task-factory-2");
  assert.ok(await store.getRun("run_factory_2"));
});

test("an unrecognized TASK_STORE value fails clearly at startup", async () => {
  await assert.rejects(createTaskStore({ TASK_STORE: "sqlite" }), InvalidTaskStoreBackendError);
});

test("TASK_STORE=redis without REDIS_URL fails clearly at startup", async () => {
  await assert.rejects(createTaskStore({ TASK_STORE: "redis" }), MissingRedisUrlError);
});

test("TASK_STORE=redis fails clearly at startup when Redis is unreachable", async () => {
  await assert.rejects(
    createTaskStore(
      { TASK_STORE: "redis", REDIS_URL: "redis://127.0.0.1:1" },
      {
        redisClientFactory: () => ({
          async connect() {
            throw new Error("ECONNREFUSED (simulated)");
          },
          async quit() {
            return "OK";
          },
          async get() {
            return null;
          },
          async set() {
            return "OK";
          },
        }),
      },
    ),
    RedisUnavailableError,
  );
});

test("TASK_STORE=redis succeeds and returns a working store when Redis is reachable", async () => {
  const store = await createTaskStore(
    { TASK_STORE: "redis", REDIS_URL: "redis://127.0.0.1:6379" },
    {
      // ioredis-mock connects synchronously at construction and throws if connect() is
      // called again -- unlike real ioredis, which needs an explicit connect() call under
      // lazyConnect. This wrapper's connect() is therefore a no-op; the factory's fail-fast
      // check is exercised for real in the "unreachable" test above, using a client whose
      // connect() genuinely rejects.
      redisClientFactory: () => {
        const mock = new RedisMock();
        return {
          get: (key: string) => mock.get(key),
          set: (key: string, value: string, mode: "EX", seconds: number) => mock.set(key, value, mode, seconds),
          async connect() {},
          async quit() {
            return mock.quit();
          },
        };
      },
    },
  );
  await store.createRun("run_factory_3", "task-factory-3");
  const record = await store.getRun("run_factory_3");
  assert.equal(record?.status, "running");
});
