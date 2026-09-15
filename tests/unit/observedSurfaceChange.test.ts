import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyObservedSurfaceChange, type InteractionSnapshot } from "../../src/observation/observationBuilder.js";

/**
 * PR 1C-a (drawer/modal/half-window detection beyond role="dialog"/aria-modal, post-click
 * surface awareness): pure, deterministic unit coverage of classifyObservedSurfaceChange --
 * no browser, no fixture server, matching this repo's existing convention
 * (tests/unit/targetAttributableSideEffect.test.ts covers the stricter, target-attributed
 * sibling this function is deliberately kept separate from). Every fixture below is purely
 * synthetic, no brand/market/CTA text, per CLAUDE.md's non-negotiable design rule.
 */

function snapshot(overrides: Partial<InteractionSnapshot> = {}): InteractionSnapshot {
  return {
    hasDialog: false,
    interactiveIdentities: ["button::Continue", "a::Learn more"],
    ...overrides,
  };
}

test("a genuine dialog/modal appearing is classified as dialog_appeared", () => {
  const before = snapshot({ hasDialog: false });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Offer details" });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "dialog_appeared");
});

test("a dialog signature changing is classified as dialog_changed", () => {
  const before = snapshot({ hasDialog: true, dialogSignature: "dialog|Step 1" });
  const after = snapshot({ hasDialog: true, dialogSignature: "dialog|Step 2" });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "dialog_changed");
});

test("a newly-appeared large panel co-occurring with several new controls -- no ARIA dialog markup at all -- is classified as layer_panel_appeared", () => {
  const before = snapshot({ interactiveIdentities: ["button::View details"] });
  const after = snapshot({
    interactiveIdentities: [
      "button::View details",
      "button::Close panel",
      "a::Panel action one",
      "a::Panel action two",
    ],
    panelSignature: "div|Offer details panel",
  });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "layer_panel_appeared");
  assert.equal(result.newElementCount, 3);
});

test("a large panel appearing with NO new controls (e.g. a loading/backdrop-only overlay) is not treated as a new interactive surface", () => {
  const before = snapshot({ interactiveIdentities: ["button::View details"] });
  const after = snapshot({
    interactiveIdentities: ["button::View details"],
    panelSignature: "div|Loading overlay",
  });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "none");
});

test("a large panel appearing with only ONE new control does not clear the co-occurrence guard (shared with the elements_appeared fallback) -- not treated as a new surface at all", () => {
  const before = snapshot({ interactiveIdentities: ["button::View details"] });
  const after = snapshot({
    interactiveIdentities: ["button::View details", "button::Close panel"],
    panelSignature: "div|Offer details panel",
  });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "none");
  assert.equal(result.newElementCount, 1);
});

test("two or more new elements with no dialog and no panel signature is classified as elements_appeared (weak, no-ARIA fallback signal)", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  const after = snapshot({
    interactiveIdentities: ["button::Continue", "button::New control A", "button::New control B"],
  });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "elements_appeared");
  assert.equal(result.newElementCount, 2);
});

test("fewer than two new elements, no dialog, no panel -- no evidence of any new surface", () => {
  const before = snapshot({ interactiveIdentities: ["button::Continue"] });
  const after = snapshot({ interactiveIdentities: ["button::Continue", "button::One incidental control"] });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "none");
  assert.equal(result.newElementCount, 1);
});

test("an unchanged panelSignature (the same panel still on screen, nothing new) is not re-classified as newly appeared", () => {
  const before = snapshot({
    interactiveIdentities: ["button::View details", "button::Close panel"],
    panelSignature: "div|Offer details panel",
  });
  const after = snapshot({
    interactiveIdentities: ["button::View details", "button::Close panel"],
    panelSignature: "div|Offer details panel",
  });
  const result = classifyObservedSurfaceChange(before, after);
  assert.equal(result.type, "none");
});

test("no change at all is classified as none with zero new elements", () => {
  const before = snapshot();
  const after = snapshot();
  const result = classifyObservedSurfaceChange(before, after);
  assert.deepEqual(result, { type: "none", newElementCount: 0 });
});
