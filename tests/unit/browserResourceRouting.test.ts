import { test } from "node:test";
import assert from "node:assert/strict";
import type { BrowserContext, Frame, Page, Request, Response, Route } from "playwright";

import { attachLowMemoryResourceRouting } from "../../src/api/browserResourceRouting.js";

function fakeRequest(resourceType: string, page: Page, url = "http://127.0.0.1/thing"): Request {
  return {
    resourceType: () => resourceType,
    url: () => url,
    frame: () => ({ page: () => page }) as unknown as Frame,
  } as unknown as Request;
}

interface FakeRouteStats {
  fulfilled: unknown[];
  continuedCount: number;
}

function fakeRoute(resourceType: string, page: Page): { route: Route; stats: FakeRouteStats } {
  const stats: FakeRouteStats = { fulfilled: [], continuedCount: 0 };
  const route = {
    request: () => fakeRequest(resourceType, page),
    fulfill: async (options: unknown) => {
      stats.fulfilled.push(options);
    },
    continue: async () => {
      stats.continuedCount += 1;
    },
  } as unknown as Route;
  return { route, stats };
}

function fakeResponse(resourceType: string, page: Page, contentLength?: string): Response {
  return {
    request: () => fakeRequest(resourceType, page),
    headers: () => (contentLength !== undefined ? { "content-length": contentLength } : {}),
  } as unknown as Response;
}

interface FakeContextHandlers {
  route?: (route: Route) => Promise<void>;
  onNewPage?: (page: Page) => void;
}

interface FakePageHandlers {
  response?: (response: Response) => void;
  framenavigated?: (frame: Frame) => void;
  close?: () => void;
}

function fakeContext(): { context: BrowserContext; handlers: FakeContextHandlers; unrouteCalls: { count: number }; offCalls: { count: number } } {
  const handlers: FakeContextHandlers = {};
  const unrouteCalls = { count: 0 };
  const offCalls = { count: 0 };
  const context = {
    route: (_pattern: string, handler: (route: Route) => Promise<void>) => {
      handlers.route = handler;
    },
    unroute: async () => {
      unrouteCalls.count += 1;
    },
    on: (event: string, handler: (page: Page) => void) => {
      if (event === "page") handlers.onNewPage = handler;
    },
    off: () => {
      offCalls.count += 1;
    },
  } as unknown as BrowserContext;
  return { context, handlers, unrouteCalls, offCalls };
}

function fakePage(context: BrowserContext): { page: Page; handlers: FakePageHandlers; mainFrame: Frame } {
  const handlers: FakePageHandlers = {};
  const mainFrame = {} as unknown as Frame;
  const page = {
    context: () => context,
    mainFrame: () => mainFrame,
    on: (event: string, handler: (arg: unknown) => void) => {
      if (event === "response") handlers.response = handler as (response: Response) => void;
      if (event === "framenavigated") handlers.framenavigated = handler as (frame: Frame) => void;
    },
    once: (event: string, handler: () => void) => {
      if (event === "close") handlers.close = handler;
    },
    off: () => {},
  } as unknown as Page;
  return { page, handlers, mainFrame };
}

test("attachLowMemoryResourceRouting registers routing on the page's browser context, not the page itself", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);

  attachLowMemoryResourceRouting(page);

  assert.ok(handlers.route, "expected a context-level route handler to be registered");
  assert.ok(handlers.onNewPage, "expected a context 'page' listener so future popups are covered automatically");
});

test("attachLowMemoryResourceRouting fulfills blocked resource types with a 200 response, never continue()", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  attachLowMemoryResourceRouting(page);

  for (const resourceType of ["image", "media", "font"]) {
    const { route, stats } = fakeRoute(resourceType, page);
    await handlers.route!(route);
    assert.equal(stats.fulfilled.length, 1, `expected ${resourceType} to be fulfilled`);
    assert.equal((stats.fulfilled[0] as { status: number }).status, 200);
    assert.equal(stats.continuedCount, 0, `expected ${resourceType} to never be continued`);
  }
});

test("attachLowMemoryResourceRouting continues (never fulfills) document/script/xhr/fetch/other", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  attachLowMemoryResourceRouting(page);

  for (const resourceType of ["document", "script", "stylesheet", "xhr", "fetch", "other"]) {
    const { route, stats } = fakeRoute(resourceType, page);
    await handlers.route!(route);
    assert.equal(stats.fulfilled.length, 0, `expected ${resourceType} to never be fulfilled`);
    assert.equal(stats.continuedCount, 1, `expected ${resourceType} to be continued`);
  }
});

test("diagnostics() reports blocked counts/estimated bytes and allowed counts/measured bytes separately, per page and at run level", async () => {
  const { context, handlers } = fakeContext();
  const { page, handlers: pageHandlers } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  await handlers.route!(fakeRoute("image", page).route);
  await handlers.route!(fakeRoute("image", page).route);
  await handlers.route!(fakeRoute("script", page).route);
  pageHandlers.response!(fakeResponse("script", page, "12345"));
  await handlers.route!(fakeRoute("xhr", page).route);
  pageHandlers.response!(fakeResponse("xhr", page));

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

  assert.equal(diagnostics.byPage.length, 1);
  assert.equal(diagnostics.byPage[0]?.role, "original");
  assert.equal(diagnostics.byPage[0]?.registrationCompleted, true);
});

test("a popup Page created in the same context is registered immediately and protected without a second attach call", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  const { page: popup } = fakePage(context);
  handlers.onNewPage!(popup);

  // The popup's own first request is blocked by the SAME context-level handler -- no
  // per-popup attach call was made anywhere.
  const { route, stats } = fakeRoute("image", popup);
  await handlers.route!(route);
  assert.equal(stats.fulfilled.length, 1, "expected the popup's own heavy resource to be blocked immediately");

  const diagnostics = attached.diagnostics();
  assert.equal(diagnostics.byPage.length, 2);
  const popupEntry = diagnostics.byPage.find((p) => p.role === "popup");
  assert.ok(popupEntry, "expected the popup to have its own routing diagnostics entry");
  assert.equal(popupEntry?.byResourceType.find((e) => e.resourceType === "image")?.blockedCount, 1);
});

test("describePage labels an adopted/nested popup's role for diagnostics without touching blocking behaviour", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  const { page: popup } = fakePage(context);
  handlers.onNewPage!(popup);
  attached.describePage(popup, "adopted_popup", { surfaceId: "adopted-1" });

  const diagnostics = attached.diagnostics();
  const popupEntry = diagnostics.byPage.find((p) => p.surfaceId === "adopted-1");
  assert.equal(popupEntry?.role, "adopted_popup");
  assert.equal(popupEntry?.contextId, "main");
});

test("re-registering an already-tracked page is a safe no-op: no duplicate route handler, marked as prevented", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  // Re-observing the same popup twice (e.g. a fingerprint-cached re-adoption) must not add
  // a second registration.
  handlers.onNewPage!(page);
  handlers.onNewPage!(page);

  const diagnostics = attached.diagnostics();
  assert.equal(diagnostics.byPage.length, 1, "expected exactly one entry for the repeatedly-observed page");
  assert.equal(diagnostics.byPage[0]?.duplicateRegistrationPrevented, true);
});

test("calling attachLowMemoryResourceRouting twice for the same context returns the same handle (idempotent)", async () => {
  const { context } = fakeContext();
  const { page } = fakePage(context);
  const first = attachLowMemoryResourceRouting(page);
  const second = attachLowMemoryResourceRouting(page);
  assert.equal(first, second);
});

test("navigationCount increments on main-frame navigations, not child frames", async () => {
  const { context, handlers } = fakeContext();
  const { page, handlers: pageHandlers, mainFrame } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  pageHandlers.framenavigated!(mainFrame);
  pageHandlers.framenavigated!(mainFrame);
  pageHandlers.framenavigated!({} as unknown as Frame); // a child frame -- never counted

  const diagnostics = attached.diagnostics();
  assert.equal(diagnostics.byPage[0]?.navigationCount, 2);
  void handlers.route;
});

test("closing a page releases its listeners and preserves its final diagnostics", async () => {
  const { context, handlers } = fakeContext();
  const { page } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  const { page: popup, handlers: popupHandlers } = fakePage(context);
  handlers.onNewPage!(popup);
  await handlers.route!(fakeRoute("image", popup).route);

  popupHandlers.close!();

  const diagnostics = attached.diagnostics();
  const popupEntry = diagnostics.byPage.find((p) => p.pageId !== diagnostics.byPage.find((q) => q.role === "original")?.pageId);
  assert.ok(popupEntry, "expected the closed popup's diagnostics to still be present");
  assert.equal(popupEntry?.routingReleasedOnClose, true);
  assert.ok(popupEntry?.closedAt);
  assert.equal(popupEntry?.byResourceType.find((e) => e.resourceType === "image")?.blockedCount, 1);
});

test("detach() unroutes the context, removes the page listener, and preserves still-open pages' diagnostics", async () => {
  const { context, handlers, unrouteCalls, offCalls } = fakeContext();
  const { page } = fakePage(context);
  const attached = attachLowMemoryResourceRouting(page);

  await handlers.route!(fakeRoute("image", page).route);
  await attached.detach();

  assert.equal(unrouteCalls.count, 1);
  assert.equal(offCalls.count, 1, "expected the context's 'page' listener to be removed");

  const diagnostics = attached.diagnostics();
  assert.equal(diagnostics.byPage.length, 1, "expected the still-open original page's diagnostics to survive detach");
  assert.equal(diagnostics.byPage[0]?.byResourceType.find((e) => e.resourceType === "image")?.blockedCount, 1);
});
