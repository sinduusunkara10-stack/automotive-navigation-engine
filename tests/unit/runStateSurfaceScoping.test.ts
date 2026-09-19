import { test } from "node:test";
import assert from "node:assert/strict";

import { MAIN_SURFACE_ID, RunState } from "../../src/core/state.js";
import type { RouteMemoryCandidate } from "../../src/types/routeMemory.js";

/**
 * Active surface tracking scaffolding (Phase 3 PR 2, see CLAUDE.md and
 * docs/architecture.md §25). Pure-logic coverage of RunState's surface stack
 * (pushSurface/popSurface/activeSurface) and the per-surface scoping of
 * lastBlockerTargetId/lastBlockerSignature/blockerSignatureRepeatCount/routeMemory/
 * lowConfidenceRetriedFingerprints -- no browser, no reasoning provider, matching this
 * repo's existing convention for fast unit coverage of core-loop state (e.g.
 * tests/unit/routeMemory.test.ts).
 */

const CANDIDATE_A: RouteMemoryCandidate = { id: "click:button::Continue", actionType: "click", label: 'button "Continue"' };
const CANDIDATE_B: RouteMemoryCandidate = { id: "click:button::Open", actionType: "click", label: 'button "Open"' };

test("activeSurface defaults to MAIN_SURFACE_ID before any push", () => {
  const state = new RunState();
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
  assert.equal(state.activeSurface, "main");
});

test("pushSurface makes the new surface active; popSurface returns to the previous one", () => {
  const state = new RunState();
  state.pushSurface("popup-1");
  assert.equal(state.activeSurface, "popup-1");
  const popped = state.popSurface();
  assert.equal(popped, "popup-1");
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("nested pushes stack correctly: popping unwinds one level at a time", () => {
  const state = new RunState();
  state.pushSurface("popup-1");
  state.pushSurface("popup-2");
  assert.equal(state.activeSurface, "popup-2");
  assert.equal(state.popSurface(), "popup-2");
  assert.equal(state.activeSurface, "popup-1");
  assert.equal(state.popSurface(), "popup-1");
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("popSurface never removes the last remaining entry -- popping past main is a no-op returning undefined", () => {
  const state = new RunState();
  assert.equal(state.popSurface(), undefined);
  assert.equal(state.activeSurface, MAIN_SURFACE_ID);
});

test("lastBlockerTargetId/lastBlockerSignature/blockerSignatureRepeatCount written on one surface do not leak onto another", () => {
  const state = new RunState();

  state.lastBlockerTargetId = "el-main-blocker";
  state.lastBlockerSignature = "div|Cookie banner";
  state.blockerSignatureRepeatCount = 2;

  state.pushSurface("popup-1");
  assert.equal(state.lastBlockerTargetId, undefined, "a freshly-entered surface must start with no blocker state at all");
  assert.equal(state.lastBlockerSignature, undefined);
  assert.equal(state.blockerSignatureRepeatCount, 0);

  state.lastBlockerTargetId = "el-popup-blocker";
  state.lastBlockerSignature = "div|Popup overlay";
  state.blockerSignatureRepeatCount = 1;

  state.popSurface();
  assert.equal(state.lastBlockerTargetId, "el-main-blocker", "returning to main must restore main's own state, untouched by the popup surface");
  assert.equal(state.lastBlockerSignature, "div|Cookie banner");
  assert.equal(state.blockerSignatureRepeatCount, 2);
});

test("re-entering a previously-visited surface preserves (does not reset) its own state", () => {
  const state = new RunState();
  state.pushSurface("popup-1");
  state.lastBlockerTargetId = "el-popup-blocker";
  state.popSurface();

  state.pushSurface("popup-1");
  assert.equal(state.lastBlockerTargetId, "el-popup-blocker", "re-entering the same surface id must resume its own preserved state, not a fresh bucket");
});

test("routeMemory is scoped per surface -- a candidate tried on one surface is invisible on another", () => {
  const state = new RunState();
  const fingerprint = "fp-1";

  state.routeMemory.record(fingerprint, CANDIDATE_A, "no_change");
  assert.equal(state.routeMemory.getTriedCandidates(fingerprint).length, 1);

  state.pushSurface("popup-1");
  assert.equal(state.routeMemory.getTriedCandidates(fingerprint).length, 0, "a route tried on main must not be visible from the popup surface's own routeMemory");

  state.routeMemory.record(fingerprint, CANDIDATE_B, "advanced");
  assert.equal(state.routeMemory.getTriedCandidates(fingerprint).length, 1);
  assert.equal(state.routeMemory.getTriedCandidates(fingerprint)[0]?.id, CANDIDATE_B.id);

  state.popSurface();
  const mainTried = state.routeMemory.getTriedCandidates(fingerprint);
  assert.equal(mainTried.length, 1, "main's own routeMemory must still show only the candidate tried on main");
  assert.equal(mainTried[0]?.id, CANDIDATE_A.id);
});

test("lowConfidenceRetriedFingerprints is scoped per surface -- no cross-surface leakage", () => {
  const state = new RunState();
  state.lowConfidenceRetriedFingerprints.add("fp-main");

  state.pushSurface("popup-1");
  assert.equal(state.lowConfidenceRetriedFingerprints.has("fp-main"), false);
  state.lowConfidenceRetriedFingerprints.add("fp-popup");

  state.popSurface();
  assert.equal(state.lowConfidenceRetriedFingerprints.has("fp-main"), true);
  assert.equal(state.lowConfidenceRetriedFingerprints.has("fp-popup"), false);
});

test("getExhaustedCandidates (which reads through the routeMemory getter) is also correctly surface-scoped", () => {
  const state = new RunState();
  const fingerprint = "fp-exhaust";
  state.routeMemory.record(fingerprint, CANDIDATE_A, "no_change");
  state.routeMemory.recordBranchResult(fingerprint, CANDIDATE_A.id, { depthReached: 1, result: "dead_end" });
  assert.equal(state.getExhaustedCandidates(fingerprint).size, 1);

  state.pushSurface("popup-1");
  assert.equal(state.getExhaustedCandidates(fingerprint).size, 0, "an exhausted candidate on main must not appear exhausted on a different surface");
});
