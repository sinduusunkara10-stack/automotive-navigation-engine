import { test } from "node:test";
import assert from "node:assert/strict";

import {
  computeCandidateIdentity,
  computeDecisionPointFingerprint,
  RouteMemory,
} from "../../src/core/routeMemory.js";
import { RunState } from "../../src/core/state.js";
import type { Observation } from "../../src/types/task-response.js";
import type { SelectedAction } from "../../src/types/actions.js";

/**
 * Route Memory (Phase 1, docs/architecture.md "Route Memory" -- fingerprint, candidate
 * identity, candidate outcome tracking, and prompt-context surfacing of tried candidates at
 * the current decision point). Pure-logic coverage of src/core/routeMemory.ts and the
 * RunState wiring around it (src/core/state.ts) -- no browser, no reasoning provider, no
 * schema involvement, matching this repo's existing convention for fast unit coverage of
 * generic core-loop mechanisms (e.g. tests/unit/successEvaluator.test.ts,
 * tests/unit/coveredBySignature.test.ts). Every fixture below is purely synthetic, no
 * brand/market/CTA text, per CLAUDE.md's non-negotiable design rule.
 */

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: "https://example-fictional-oem.test/start.html",
    title: "Fictional start page",
    interactiveElements: [
      { id: "el-0", role: "a", accessibleName: "Continue", visible: true },
      { id: "el-1", role: "button", accessibleName: "Learn more", visible: true },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------
// computeDecisionPointFingerprint
// ---------------------------------------------------------------------------------------

test("computeDecisionPointFingerprint: identical url + element set fingerprints identically", () => {
  const a = observation();
  const b = observation();
  assert.equal(computeDecisionPointFingerprint(a), computeDecisionPointFingerprint(b));
});

test("computeDecisionPointFingerprint: a different url fingerprints differently, even with the same elements", () => {
  const a = observation({ url: "https://example-fictional-oem.test/start.html" });
  const b = observation({ url: "https://example-fictional-oem.test/other.html" });
  assert.notEqual(computeDecisionPointFingerprint(a), computeDecisionPointFingerprint(b));
});

test("computeDecisionPointFingerprint: a different set of available controls fingerprints differently", () => {
  const a = observation();
  const b = observation({
    interactiveElements: [{ id: "el-0", role: "a", accessibleName: "Continue", visible: true }],
  });
  assert.notEqual(computeDecisionPointFingerprint(a), computeDecisionPointFingerprint(b));
});

test("computeDecisionPointFingerprint: is independent of element id and DOM order -- only role+accessibleName matter, matching a fresh page load that reassigns ids and reorders elements", () => {
  const a = observation({
    interactiveElements: [
      { id: "el-0", role: "a", accessibleName: "Continue", visible: true },
      { id: "el-1", role: "button", accessibleName: "Learn more", visible: true },
    ],
  });
  const reloaded = observation({
    interactiveElements: [
      { id: "el-99", role: "button", accessibleName: "Learn more", visible: true },
      { id: "el-42", role: "a", accessibleName: "Continue", visible: true },
    ],
  });
  assert.equal(computeDecisionPointFingerprint(a), computeDecisionPointFingerprint(reloaded));
});

test("computeDecisionPointFingerprint: excludes hidden elements and deduplicates identical visible ones", () => {
  const withHiddenAndDuplicate = observation({
    interactiveElements: [
      { id: "el-0", role: "a", accessibleName: "Continue", visible: true },
      { id: "el-1", role: "a", accessibleName: "Continue", visible: true },
      { id: "el-2", role: "button", accessibleName: "Hidden duplicate nav link", visible: false },
    ],
  });
  const onlyOneVisibleContinue = observation({
    interactiveElements: [{ id: "el-0", role: "a", accessibleName: "Continue", visible: true }],
  });
  assert.equal(
    computeDecisionPointFingerprint(withHiddenAndDuplicate),
    computeDecisionPointFingerprint(onlyOneVisibleContinue),
  );
});

// ---------------------------------------------------------------------------------------
// computeCandidateIdentity
// ---------------------------------------------------------------------------------------

test("computeCandidateIdentity: resolves a click action's stable role+accessibleName identity from the observation", () => {
  const obs = observation();
  const candidate = computeCandidateIdentity({ type: "click", target: "el-0" }, obs);
  assert.ok(candidate);
  assert.equal(candidate?.actionType, "click");
  assert.equal(candidate?.label, 'a "Continue"');
  assert.equal(candidate?.id, "click::a::Continue");
});

test("computeCandidateIdentity: two click actions targeting an element with the same role+accessibleName produce the same identity even with different element ids", () => {
  const obs1 = observation({ interactiveElements: [{ id: "el-a", role: "a", accessibleName: "Continue", visible: true }] });
  const obs2 = observation({ interactiveElements: [{ id: "el-b", role: "a", accessibleName: "Continue", visible: true }] });
  const c1 = computeCandidateIdentity({ type: "click", target: "el-a" }, obs1);
  const c2 = computeCandidateIdentity({ type: "click", target: "el-b" }, obs2);
  assert.equal(c1?.id, c2?.id);
});

test("computeCandidateIdentity: returns undefined for a click with no target, or a target not present in the observation", () => {
  const obs = observation();
  assert.equal(computeCandidateIdentity({ type: "click" }, obs), undefined);
  assert.equal(computeCandidateIdentity({ type: "click", target: "el-does-not-exist" }, obs), undefined);
});

test("computeCandidateIdentity: resolves a navigate action's identity from its target URL", () => {
  const obs = observation();
  const candidate = computeCandidateIdentity(
    { type: "navigate", target: "https://example-fictional-oem.test/other.html" },
    obs,
  );
  assert.ok(candidate);
  assert.equal(candidate?.actionType, "navigate");
  assert.equal(candidate?.label, "https://example-fictional-oem.test/other.html");
});

test("computeCandidateIdentity: returns undefined for actions that are not route choices (scroll, wait, go_back, capture, stop_*)", () => {
  const obs = observation();
  const nonCandidateActions: SelectedAction[] = [
    { type: "scroll" },
    { type: "wait" },
    { type: "go_back" },
    { type: "capture" },
    { type: "stop_success" },
    { type: "stop_blocked" },
    { type: "stop_failure" },
  ];
  for (const action of nonCandidateActions) {
    assert.equal(computeCandidateIdentity(action, obs), undefined, `expected undefined for ${action.type}`);
  }
});

// ---------------------------------------------------------------------------------------
// RouteMemory
// ---------------------------------------------------------------------------------------

test("RouteMemory: records attempts and the most recent outcome per (fingerprint, candidate)", () => {
  const memory = new RouteMemory();
  const fp = "fingerprint-1";
  const candidate = { id: "click::button::Stay", actionType: "click" as const, label: 'button "Stay"' };

  memory.record(fp, candidate, "no_change");
  let tried = memory.getTriedCandidates(fp);
  assert.equal(tried.length, 1);
  assert.equal(tried[0]?.attempts, 1);
  assert.equal(tried[0]?.lastOutcome, "no_change");

  memory.record(fp, candidate, "failed");
  tried = memory.getTriedCandidates(fp);
  assert.equal(tried.length, 1);
  assert.equal(tried[0]?.attempts, 2);
  assert.equal(tried[0]?.lastOutcome, "failed");
});

test("RouteMemory: tracks distinct candidates at the same decision point independently", () => {
  const memory = new RouteMemory();
  const fp = "fingerprint-1";
  const stay = { id: "click::button::Stay", actionType: "click" as const, label: 'button "Stay"' };
  const learnMore = { id: "click::button::Learn more", actionType: "click" as const, label: 'button "Learn more"' };

  memory.record(fp, stay, "no_change");
  memory.record(fp, learnMore, "blocked");

  const tried = memory.getTriedCandidates(fp);
  assert.equal(tried.length, 2);
  const byLabel = Object.fromEntries(tried.map((c) => [c.label, c]));
  assert.equal(byLabel['button "Stay"']?.lastOutcome, "no_change");
  assert.equal(byLabel['button "Learn more"']?.lastOutcome, "blocked");
});

test("RouteMemory: the same candidate identity at two different decision points is tracked separately", () => {
  const memory = new RouteMemory();
  const candidate = { id: "click::button::Continue", actionType: "click" as const, label: 'button "Continue"' };

  memory.record("fingerprint-a", candidate, "advanced");
  assert.equal(memory.getTriedCandidates("fingerprint-b").length, 0);
  assert.equal(memory.getTriedCandidates("fingerprint-a").length, 1);
});

test("RouteMemory: getTriedCandidates returns nothing for an unseen decision point", () => {
  const memory = new RouteMemory();
  assert.deepEqual(memory.getTriedCandidates("never-seen"), []);
});

test("RouteMemory: updateLastOutcome upgrades the outcome without incrementing attempts, and is a no-op for an unknown candidate/fingerprint", () => {
  const memory = new RouteMemory();
  const fp = "fingerprint-1";
  const candidate = { id: "click::a::Detour", actionType: "click" as const, label: 'a "Detour"' };

  memory.record(fp, candidate, "no_change");
  memory.updateLastOutcome(fp, candidate.id, "advanced");

  const tried = memory.getTriedCandidates(fp);
  assert.equal(tried.length, 1);
  assert.equal(tried[0]?.attempts, 1, "updateLastOutcome must not count as a new attempt");
  assert.equal(tried[0]?.lastOutcome, "advanced");

  // No-op, must not throw or create a stray entry.
  memory.updateLastOutcome(fp, "click::does::not-exist", "advanced");
  memory.updateLastOutcome("never-seen-fingerprint", candidate.id, "advanced");
  assert.equal(memory.getTriedCandidates(fp).length, 1);
  assert.equal(memory.getTriedCandidates("never-seen-fingerprint").length, 0);
});

test("RouteMemory: getTriedCandidates sorts most-attempted-first, then alphabetically by label", () => {
  const memory = new RouteMemory();
  const fp = "fingerprint-1";
  const stay = { id: "click::button::Stay", actionType: "click" as const, label: 'button "Stay"' };
  const wait = { id: "click::button::Wait here", actionType: "click" as const, label: 'button "Wait here"' };
  const detour = { id: "click::a::Detour", actionType: "click" as const, label: 'a "Detour"' };

  memory.record(fp, stay, "no_change");
  memory.record(fp, stay, "no_change");
  memory.record(fp, stay, "no_change");
  memory.record(fp, wait, "no_change");
  memory.record(fp, detour, "advanced");

  const tried = memory.getTriedCandidates(fp);
  assert.deepEqual(
    tried.map((c) => c.label),
    ['button "Stay"', 'a "Detour"', 'button "Wait here"'],
  );
});

// ---------------------------------------------------------------------------------------
// RunState wiring: recordRouteMemoryOutcome / recordRouteMemoryPending / the deferred
// "no_change" -> "advanced" upgrade driven by resolveLastActionProgress.
// ---------------------------------------------------------------------------------------

test("RunState.recordRouteMemoryOutcome records blocked/failed outcomes immediately", () => {
  const state = new RunState();
  const fp = "fingerprint-1";
  const clickCandidate = { id: "click::a::Detour", actionType: "click" as const, label: 'a "Detour"' };
  const navCandidate = { id: "navigate::https://x.test/y", actionType: "navigate" as const, label: "https://x.test/y" };

  state.recordRouteMemoryOutcome(fp, clickCandidate, "failed");
  state.recordRouteMemoryOutcome(fp, navCandidate, "blocked");

  const tried = state.routeMemory.getTriedCandidates(fp);
  assert.equal(tried.length, 2);
  const byLabel = Object.fromEntries(tried.map((c) => [c.label, c]));
  assert.equal(byLabel['a "Detour"']?.lastOutcome, "failed");
  assert.equal(byLabel["https://x.test/y"]?.lastOutcome, "blocked");
});

test("RunState.recordRouteMemoryPending is provisionally 'no_change' and is upgraded to 'advanced' once the next observation shows the page moved on", () => {
  const state = new RunState();
  const fp = "fingerprint-1";
  const candidate = { id: "click::a::Continue", actionType: "click" as const, label: 'a "Continue"' };

  state.recordAction({ type: "click", target: "el-0" }, { url: "https://x.test/a.html", title: "A" });
  state.recordRouteMemoryPending(fp, candidate);

  assert.equal(state.routeMemory.getTriedCandidates(fp)[0]?.lastOutcome, "no_change");

  // Next step's observation shows the URL changed -- resolveLastActionProgress both fills
  // in RecordedAction.observedProgress (existing behaviour) and upgrades the pending route
  // memory entry to "advanced".
  state.resolveLastActionProgress("https://x.test/b.html", "B");

  const tried = state.routeMemory.getTriedCandidates(fp);
  assert.equal(tried[0]?.lastOutcome, "advanced");
  assert.equal(tried[0]?.attempts, 1, "the upgrade must not double-count as a second attempt");
});

test("RunState.recordRouteMemoryPending stays 'no_change' when the next observation shows no url/title change", () => {
  const state = new RunState();
  const fp = "fingerprint-1";
  const candidate = { id: "click::button::Stay", actionType: "click" as const, label: 'button "Stay"' };

  state.recordAction({ type: "click", target: "el-0" }, { url: "https://x.test/a.html", title: "A" });
  state.recordRouteMemoryPending(fp, candidate);

  state.resolveLastActionProgress("https://x.test/a.html", "A");

  const tried = state.routeMemory.getTriedCandidates(fp);
  assert.equal(tried[0]?.lastOutcome, "no_change");
});

test("RunState.resolveLastActionProgress is a no-op for route memory when no candidate is pending (e.g. after a scroll/wait, which computeCandidateIdentity never tracks)", () => {
  const state = new RunState();
  state.recordAction({ type: "scroll" }, { url: "https://x.test/a.html", title: "A" });
  // No recordRouteMemoryPending call -- nothing pending.
  assert.doesNotThrow(() => state.resolveLastActionProgress("https://x.test/b.html", "B"));
});
