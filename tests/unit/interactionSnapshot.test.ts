import { test } from "node:test";
import assert from "node:assert/strict";

import { detectClickSideEffect, type InteractionSnapshot } from "../../src/observation/observationBuilder.js";

/**
 * Overlay-click-detection fix (see CLAUDE.md and docs/architecture.md §18): pure,
 * deterministic unit coverage of detectClickSideEffect -- no browser, no fixture server,
 * matching this repo's existing convention for fast coverage of generic decision logic
 * (e.g. tests/unit/branchExploration.test.ts, tests/unit/routeMemory.test.ts). Every
 * fixture below is purely synthetic, no brand/market/CTA text, per CLAUDE.md's
 * non-negotiable design rule.
 */

function snapshot(overrides: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    hasDialog: false,
    interactiveIdentities: ["button::Continue", "a::Learn more"],
    ...overrides,
  };
}

test("detectClickSideEffect: a dialog appearing where none existed before is detected as dialog_appeared", () => {
  const before = snapshot({ hasDialog: false });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|New action" });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, true);
  assert.equal(result.type, "dialog_appeared");
});

test("detectClickSideEffect: an already-open dialog whose signature changes is detected as dialog_changed", () => {
  const before = snapshot({ hasDialog: true, dialogSignature: "dialog|First step" });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Second step" });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, true);
  assert.equal(result.type, "dialog_changed");
});

test("detectClickSideEffect: an already-open dialog with an unchanged signature is not, by itself, evidence of a new side effect", () => {
  const before = snapshot({ hasDialog: true, dialogSignature: "dialog|Same content" });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Same content" });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, false);
});

test("detectClickSideEffect: at least two newly-appeared interactive elements are detected as interactive_surface_changed", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  const after = snapshot({
    interactiveIdentities: ["button::Continue", "button::Request a callback", "button::Close"],
  });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, true);
  assert.equal(result.type, "interactive_surface_changed");
});

test("detectClickSideEffect: exactly one newly-appeared interactive element is NOT treated as evidence on its own (guards against a single incidental ad/analytics/font-loading mutation being mistaken for a real overlay)", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  const after = snapshot({ interactiveIdentities: ["button::Continue", "button::Incidental banner close"] });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, false);
});

test("detectClickSideEffect: no dialog and no new interactive elements at all is never evidence", () => {
  const before = snapshot();
  const after = snapshot();
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, false);
});

test("detectClickSideEffect: elements merely disappearing (fewer identities, none new) is never evidence -- only genuinely NEW controls count", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue", "a::Learn more", "button::Extra"] });
  const after = snapshot({ interactiveIdentities: ["button::Continue"] });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, false);
});

test("detectClickSideEffect: dialog evidence takes priority even when the interactive-surface count alone would not have qualified", () => {
  const before = snapshot({ hasDialog: false, interactiveIdentities: ["button::Continue"] });
  const after = snapshot({
    hasDialog: true,
    dialogSignature: "dialog|One new control",
    interactiveIdentities: ["button::Continue", "button::One new control"],
  });
  const result = detectClickSideEffect({ before, after });
  assert.equal(result.detected, true);
  assert.equal(result.type, "dialog_appeared");
});
