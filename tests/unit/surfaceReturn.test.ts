import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { RunState, MAIN_SURFACE_ID } from "../../src/core/state.js";
import { detectClosedAdoptedSurfaces, returnToParentSurface } from "../../src/core/surfaceReturn.js";

/**
 * Return-to-parent recovery (Phase 3 PR 4, see CLAUDE.md and docs/architecture.md
 * "Return-to-parent recovery"): pure-logic coverage of returnToParentSurface's verified-
 * return state machine and detectClosedAdoptedSurfaces' unexpected-closure detection, using
 * fake Page objects in place of real Playwright Pages -- neither mechanism inspects a Page
 * beyond isClosed()/url()/close(), so a fake with just those three is a complete stand-in.
 */

function fakePage(label: string, opts: { closed?: boolean; url?: string; urlThrows?: boolean } = {}): Page & {
  __label: string;
  closeCalls: number;
} {
  const state = { closed: opts.closed ?? false };
  return {
    __label: label,
    closeCalls: 0,
    isClosed: () => state.closed,
    url: () => {
      if (opts.urlThrows) {
        throw new Error("navigation in progress");
      }
      return opts.url ?? `https://example.test/${label}`;
    },
    close: async function (this: { closeCalls: number }) {
      this.closeCalls += 1;
      state.closed = true;
    },
  } as unknown as Page & { __label: string; closeCalls: number };
}

test("returnToParentSurface: pops back to main, closes the child page, reports the parent's url", async () => {
  const state = new RunState();
  const mainPage = fakePage("main");
  const popup = fakePage("popup-1");
  state.pushSurface("adopted-1", popup);

  const result = await returnToParentSurface({ state, mainPage });

  assert.equal(result.restored, true);
  assert.equal(result.poppedSurfaceId, "adopted-1");
  assert.equal(result.parentSurfaceId, MAIN_SURFACE_ID);
  assert.equal(result.parentUrl, mainPage.url());
  assert.equal(popup.closeCalls, 1);
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("returnToParentSurface: nested adoption returns to the immediate parent surface, not main", async () => {
  const state = new RunState();
  const mainPage = fakePage("main");
  const popup1 = fakePage("popup-1");
  const popup2 = fakePage("popup-2 (nested)");
  state.pushSurface("adopted-1", popup1);
  state.pushSurface("adopted-2", popup2);

  const result = await returnToParentSurface({ state, mainPage });

  assert.equal(result.restored, true);
  assert.equal(result.poppedSurfaceId, "adopted-2");
  assert.equal(result.parentSurfaceId, "adopted-1");
  assert.equal(result.parentUrl, popup1.url());
  assert.equal(popup2.closeCalls, 1);
  assert.equal(state.activeSurface, "adopted-1");
  assert.equal(state.activePage, popup1);
});

test("returnToParentSurface: an already-closed child page is never re-closed", async () => {
  const state = new RunState();
  const mainPage = fakePage("main");
  const popup = fakePage("popup-1", { closed: true });
  state.pushSurface("adopted-1", popup);

  const result = await returnToParentSurface({ state, mainPage });

  assert.equal(result.restored, true);
  assert.equal(popup.closeCalls, 0);
});

test("returnToParentSurface: a closed parent surface is reported as restored: false, reason parent_closed", async () => {
  const state = new RunState();
  const mainPage = fakePage("main");
  const popup1 = fakePage("popup-1", { closed: true });
  const popup2 = fakePage("popup-2 (nested)");
  state.pushSurface("adopted-1", popup1);
  state.pushSurface("adopted-2", popup2);

  const result = await returnToParentSurface({ state, mainPage });

  assert.equal(result.restored, false);
  assert.equal(result.reason, "parent_closed");
  assert.equal(result.poppedSurfaceId, "adopted-2");
  assert.equal(result.parentSurfaceId, "adopted-1");
  // The surface stack itself still unwinds even though the parent couldn't be verified --
  // a caller decides what to do next (e.g. stop the run), but state isn't left stuck on a
  // surface whose own Page has already closed.
  assert.equal(state.activeSurface, "adopted-1");
});

test("returnToParentSurface: a parent whose url() throws (mid-navigation) is reported as restored: false, reason parent_navigation_unverified", async () => {
  const state = new RunState();
  const mainPage = fakePage("main", { urlThrows: true });
  const popup = fakePage("popup-1");
  state.pushSurface("adopted-1", popup);

  const result = await returnToParentSurface({ state, mainPage });

  assert.equal(result.restored, false);
  assert.equal(result.reason, "parent_navigation_unverified");
  assert.equal(result.parentUrl, undefined);
});

test("detectClosedAdoptedSurfaces: on main, with nothing adopted, returns no recoveries", () => {
  const state = new RunState();
  assert.deepEqual(detectClosedAdoptedSurfaces(state), []);
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("detectClosedAdoptedSurfaces: an adopted surface that is still open is left untouched", () => {
  const state = new RunState();
  const popup = fakePage("popup-1");
  state.pushSurface("adopted-1", popup);

  assert.deepEqual(detectClosedAdoptedSurfaces(state), []);
  assert.equal(state.activeSurface, "adopted-1");
});

test("detectClosedAdoptedSurfaces: a closed adopted surface is popped and reported", () => {
  const state = new RunState();
  const popup = fakePage("popup-1", { closed: true });
  state.pushSurface("adopted-1", popup);

  const recovered = detectClosedAdoptedSurfaces(state);

  assert.deepEqual(recovered, [{ poppedSurfaceId: "adopted-1", parentSurfaceId: MAIN_SURFACE_ID }]);
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("detectClosedAdoptedSurfaces: a chain of closed nested surfaces is unwound down to the first still-open (or main) surface", () => {
  const state = new RunState();
  const popup1 = fakePage("popup-1", { closed: true });
  const popup2 = fakePage("popup-2 (nested)", { closed: true });
  state.pushSurface("adopted-1", popup1);
  state.pushSurface("adopted-2", popup2);

  const recovered = detectClosedAdoptedSurfaces(state);

  assert.deepEqual(recovered, [
    { poppedSurfaceId: "adopted-2", parentSurfaceId: "adopted-1" },
    { poppedSurfaceId: "adopted-1", parentSurfaceId: MAIN_SURFACE_ID },
  ]);
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("detectClosedAdoptedSurfaces: stops as soon as it reaches a still-open surface, even if main is further down", () => {
  const state = new RunState();
  const popup1 = fakePage("popup-1"); // still open
  const popup2 = fakePage("popup-2 (nested)", { closed: true });
  state.pushSurface("adopted-1", popup1);
  state.pushSurface("adopted-2", popup2);

  const recovered = detectClosedAdoptedSurfaces(state);

  assert.deepEqual(recovered, [{ poppedSurfaceId: "adopted-2", parentSurfaceId: "adopted-1" }]);
  assert.equal(state.activeSurface, "adopted-1");
});
