import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { RunState } from "../../src/core/state.js";

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): pure-logic coverage of the Page-carrying extension to RunState's surface
 * stack (pushSurface(id, page)/activePage/adoptedSurfaceCount/nextAdoptedSurfaceId/
 * effectiveAllowedDomains) added on top of tests/unit/runStateSurfaceScoping.test.ts's own
 * pre-existing coverage of the stack mechanics themselves. Uses plain fake objects in place
 * of a real Playwright Page -- this mechanism never inspects the Page beyond identity, so a
 * fake reference is all it needs.
 */

function fakePage(label: string): Page {
  return { __fakePage: label } as unknown as Page;
}

test("activePage is undefined while on main -- the caller falls back to its own tracked page", () => {
  const state = new RunState();
  assert.equal(state.activePage, undefined);
});

test("pushSurface(id, page) makes that Page the activePage; popSurface returns to undefined (main)", () => {
  const state = new RunState();
  const popup = fakePage("popup-1");
  state.pushSurface("adopted-1", popup);
  assert.equal(state.activePage, popup);
  state.popSurface();
  assert.equal(state.activePage, undefined);
});

test("nested adoption: pushing a second Page while the first is active makes the second one activePage; popping unwinds one level at a time", () => {
  const state = new RunState();
  const popup1 = fakePage("popup-1");
  const popup2 = fakePage("popup-2 (nested, opened from popup-1)");
  state.pushSurface("adopted-1", popup1);
  state.pushSurface("adopted-2", popup2);
  assert.equal(state.activePage, popup2);
  state.popSurface();
  assert.equal(state.activePage, popup1);
  state.popSurface();
  assert.equal(state.activePage, undefined);
});

test("pushSurface without a page (pre-adoption stack mechanics, e.g. existing tests) leaves activePage undefined", () => {
  const state = new RunState();
  state.pushSurface("some-surface");
  assert.equal(state.activePage, undefined);
});

test("nextAdoptedSurfaceId returns fresh, stable, monotonically distinct ids and adoptedSurfaceCount never decreases on popSurface", () => {
  const state = new RunState();
  assert.equal(state.adoptedSurfaceCount, 0);

  const id1 = state.nextAdoptedSurfaceId();
  assert.equal(state.adoptedSurfaceCount, 1);
  state.pushSurface(id1, fakePage("p1"));

  const id2 = state.nextAdoptedSurfaceId();
  assert.equal(state.adoptedSurfaceCount, 2);
  state.pushSurface(id2, fakePage("p2"));

  assert.notEqual(id1, id2);

  state.popSurface();
  state.popSurface();
  // Popping never un-counts a surface that was ever adopted -- the per-run budget is a
  // one-way ratchet, not a count of currently-open surfaces.
  assert.equal(state.adoptedSurfaceCount, 2);
});

test("effectiveAllowedDomains returns the base list unchanged (same reference) when no surface ever extended trust", () => {
  const state = new RunState();
  const base = ["127.0.0.1"];
  assert.equal(state.effectiveAllowedDomains(base), base);

  state.pushSurface("adopted-1", fakePage("p1"));
  assert.equal(state.effectiveAllowedDomains(base), base);
});

test("extendAllowedDomainForCurrentSurface widens effectiveAllowedDomains only for the surface it was called on", () => {
  const state = new RunState();
  const base = ["127.0.0.1"];

  state.pushSurface("adopted-1", fakePage("p1"));
  state.extendAllowedDomainForCurrentSurface("localhost");
  assert.deepEqual(state.effectiveAllowedDomains(base), ["127.0.0.1", "localhost"]);

  // A nested surface pushed on top never inherits the parent's own extension.
  state.pushSurface("adopted-2", fakePage("p2"));
  assert.deepEqual(state.effectiveAllowedDomains(base), base);

  state.popSurface();
  assert.deepEqual(state.effectiveAllowedDomains(base), ["127.0.0.1", "localhost"]);

  state.popSurface();
  assert.equal(state.effectiveAllowedDomains(base), base);
});

test("re-entering a surface that previously extended trust resumes that same extension", () => {
  const state = new RunState();
  const base = ["127.0.0.1"];

  state.pushSurface("adopted-1", fakePage("p1"));
  state.extendAllowedDomainForCurrentSurface("localhost");
  state.popSurface();

  state.pushSurface("adopted-1", fakePage("p1-again"));
  assert.deepEqual(state.effectiveAllowedDomains(base), ["127.0.0.1", "localhost"]);
});
