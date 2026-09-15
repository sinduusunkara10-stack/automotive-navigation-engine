import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectTargetAttributableSideEffect,
  type InteractionSnapshot,
  type TargetElementSnapshot,
} from "../../src/observation/observationBuilder.js";

/**
 * Target-attributable click-success fix (see CLAUDE.md and docs/architecture.md "Overlay-click
 * side effect detection"): pure, deterministic unit coverage of
 * detectTargetAttributableSideEffect -- no browser, no fixture server, matching this repo's
 * existing convention (tests/unit/interactionSnapshot.test.ts, which covers the underlying
 * whole-page detectClickSideEffect this function builds on). Every fixture below is purely
 * synthetic, no brand/market/CTA text, per CLAUDE.md's non-negotiable design rule.
 */

function snapshot(overrides: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    hasDialog: false,
    interactiveIdentities: ["button::Continue", "a::Learn more"],
    ...overrides,
  };
}

function target(overrides: Partial<TargetElementSnapshot> = {}): TargetElementSnapshot {
  return {
    attached: true,
    covered: false,
    ...overrides,
  };
}

test("REGRESSION (production incident): an intercepted click plus an unrelated element's own independent mutation elsewhere on the page is NOT detected -- no dialog, no target involvement", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  // An unrelated overlay (e.g. a cookie/consent banner) re-renders on its own, adding two
  // new controls with no role="dialog"/aria-modal markup -- the exact shape a real
  // production incident demonstrated being wrongly accepted as click-success evidence.
  const after = snapshot({
    interactiveIdentities: ["button::Continue", "button::Unrelated banner option A", "button::Unrelated banner option B"],
  });
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ covered: true }),
    targetAfter: target({ covered: true }), // still covered by the same thing -- never "newly" covered
  });
  assert.equal(result.detected, false, "an unattributed whole-page mutation with zero target involvement must never count as success evidence");
});

test("a target whose own aria-expanded flips to true is detected, even with zero other page evidence", () => {
  const before = snapshot();
  const after = snapshot();
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ ariaState: { "aria-expanded": "false" } }),
    targetAfter: target({ ariaState: { "aria-expanded": "true" } }),
  });
  assert.equal(result.detected, true);
  assert.equal(result.type, "interactive_surface_changed");
});

test("a target that becomes newly covered by whatever it opened is detected, even with no dialog markup", () => {
  const before = snapshot();
  const after = snapshot({ interactiveIdentities: ["button::Continue", "a::Learn more", "button::New panel control"] });
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ covered: false }),
    targetAfter: target({ covered: true, coveredBySignature: "div|dialog|New panel" }),
  });
  assert.equal(result.detected, true);
  assert.equal(result.type, "interactive_surface_changed");
});

test("a target that disappears from the DOM entirely (replaced by whatever it opened) is detected", () => {
  const before = snapshot();
  const after = snapshot();
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ attached: true }),
    targetAfter: target({ attached: false, covered: false }),
  });
  assert.equal(result.detected, true);
});

test("a genuine dialog/modal appearing is trusted unconditionally, exactly like detectClickSideEffect, even when the target's own state is completely unchanged", () => {
  const before = snapshot({ hasDialog: false });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Deep-linked control" });
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ covered: true }),
    targetAfter: target({ covered: true }), // unchanged -- the dialog signal alone is enough
  });
  assert.equal(result.detected, true, "an author-declared dialog/modal signal is standards-based evidence, trusted on its own");
  assert.equal(result.type, "dialog_appeared");
});

test("a dialog signature changing (not merely appearing) is also trusted unconditionally", () => {
  const before = snapshot({ hasDialog: true, dialogSignature: "dialog|Step 1" });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Step 2" });
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target(),
    targetAfter: target(),
  });
  assert.equal(result.detected, true);
  assert.equal(result.type, "dialog_changed");
});

test("no dialog, no target involvement, and fewer than two new interactive elements is never evidence", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  const after = snapshot({ interactiveIdentities: ["button::Continue", "button::One incidental control"] });
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target(),
    targetAfter: target(),
  });
  assert.equal(result.detected, false);
});

test("the target becoming newly covered by the SAME obstruction it was already reported under is not itself re-triggered -- only a transition from uncovered to covered counts", () => {
  const before = snapshot();
  const after = snapshot();
  const result = detectTargetAttributableSideEffect({
    before,
    after,
    targetBefore: target({ covered: true, coveredBySignature: "div|dialog|Same overlay" }),
    targetAfter: target({ covered: true, coveredBySignature: "div|dialog|Same overlay" }),
  });
  assert.equal(result.detected, false, "the target was already covered before this click -- nothing changed as a result of it");
});
