import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page, Request, Response, Route } from "playwright";

import { attachLowMemoryResourceRouting } from "../../src/api/browserResourceRouting.js";

function fakeRequest(resourceType: string, url = "http://127.0.0.1/thing"): Request {
  return { resourceType: () => resourceType, url: () => url } as unknown as Request;
}

interface FakeRouteStats {
  fulfilled: unknown[];
  continuedCount: number;
}

function fakeRoute(resourceType: string): { route: Route; stats: FakeRouteStats } {
  const stats: FakeRouteStats = { fulfilled: [], continuedCount: 0 };
  const route = {
    request: () => fakeRequest(resourceType),
    fulfill: async (options: unknown) => {
      stats.fulfilled.push(options);
    },
    continue: async () => {
      stats.continuedCount += 1;
    },
  } as unknown as Route;
  return { route, stats };
}

function fakeResponse(resourceType: string, contentLength?: string): Response {
  return {
    request: () => fakeRequest(resourceType),
    headers: () => (contentLength !== undefined ? { "content-length": contentLength } : {}),
  } as unknown as Response;
}

test("attachLowMemoryResourceRouting fulfills blocked resource types with a 200 response, never continue()", async () => {
  const handlers: { route?: (route: Route) => Promise<void> } = {};
  const fakePage = {
    route: (_pattern: string, handler: (route: Route) => Promise<void>) => {
      handlers.route = handler;
    },
    on: () => {},
    off: () => {},
    unroute: async () => {},
  } as unknown as Page;

  attachLowMemoryResourceRouting(fakePage);
  assert.ok(handlers.route, "expected a route handler to be registered");

  for (const resourceType of ["image", "media", "font"]) {
    const { route, stats } = fakeRoute(resourceType);
    await handlers.route!(route);
    assert.equal(stats.fulfilled.length, 1, `expected ${resourceType} to be fulfilled`);
    assert.equal((stats.fulfilled[0] as { status: number }).status, 200);
    assert.equal(stats.continuedCount, 0, `expected ${resourceType} to never be continued`);
  }
});

test("attachLowMemoryResourceRouting continues (never fulfills) document/script/xhr/fetch/other", async () => {
  const handlers: { route?: (route: Route) => Promise<void> } = {};
  const fakePage = {
    route: (_pattern: string, handler: (route: Route) => Promise<void>) => {
      handlers.route = handler;
    },
    on: () => {},
    off: () => {},
    unroute: async () => {},
  } as unknown as Page;

  attachLowMemoryResourceRouting(fakePage);

  for (const resourceType of ["document", "script", "stylesheet", "xhr", "fetch", "other"]) {
    const { route, stats } = fakeRoute(resourceType);
    await handlers.route!(route);
    assert.equal(stats.fulfilled.length, 0, `expected ${resourceType} to never be fulfilled`);
    assert.equal(stats.continuedCount, 1, `expected ${resourceType} to be continued`);
  }
});

test("diagnostics() reports blocked counts/estimated bytes and allowed counts/measured bytes separately", async () => {
  const handlers: { route?: (route: Route) => Promise<void>; response?: (response: Response) => void } = {};
  const fakePage = {
    route: (_pattern: string, handler: (route: Route) => Promise<void>) => {
      handlers.route = handler;
    },
    on: (event: string, handler: (response: Response) => void) => {
      if (event === "response") handlers.response = handler;
    },
    off: () => {},
    unroute: async () => {},
  } as unknown as Page;

  const attached = attachLowMemoryResourceRouting(fakePage);

  // Two blocked images.
  await handlers.route!(fakeRoute("image").route);
  await handlers.route!(fakeRoute("image").route);
  // One allowed script, with a real measured response size.
  await handlers.route!(fakeRoute("script").route);
  handlers.response!(fakeResponse("script", "12345"));
  // One allowed xhr with no content-length header at all (measured bytes stay 0 for it).
  await handlers.route!(fakeRoute("xhr").route);
  handlers.response!(fakeResponse("xhr"));

  const diagnostics = attached.diagnostics();
  assert.equal(diagnostics.mode, "low_memory");
  const byType = new Map(diagnostics.byResourceType.map((e) => [e.resourceType, e]));

  const image = byType.get("image");
  assert.equal(image?.blockedCount, 2);
  assert.equal(image?.allowedCount, 0);
  assert.ok(image!.blockedBytesEstimated > 0, "expected a non-zero estimate, clearly not a measurement");

  const script = byType.get("script");
  assert.equal(script?.allowedCount, 1);
  assert.equal(script?.blockedCount, 0);
  assert.equal(script?.allowedBytesMeasured, 12345, "expected the real Content-Length header value");

  const xhr = byType.get("xhr");
  assert.equal(xhr?.allowedCount, 1);
  assert.equal(xhr?.allowedBytesMeasured, 0, "no Content-Length header present -- never fabricated");
});

test("detach() removes the response listener and unroutes the page", async () => {
  let offCalls = 0;
  let unrouteCalls = 0;
  const fakePage = {
    route: () => {},
    on: () => {},
    off: () => {
      offCalls += 1;
    },
    unroute: async () => {
      unrouteCalls += 1;
    },
  } as unknown as Page;

  const attached = attachLowMemoryResourceRouting(fakePage);
  await attached.detach();

  assert.equal(offCalls, 1);
  assert.equal(unrouteCalls, 1);
});
