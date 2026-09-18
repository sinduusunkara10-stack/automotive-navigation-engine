import { test } from "node:test";
import assert from "node:assert/strict";

import { shouldEnterInDocumentSurface, shouldLeaveInDocumentSurface } from "../../src/core/inDocumentSurface.js";

/**
 * Drawer/modal formalization (Phase 3 PR 5, see CLAUDE.md and docs/architecture.md "Drawer/
 * modal formalization"): pure-logic coverage of the entry/exit decision functions, mirroring
 * tests/unit/surfaceAdoption.test.ts's own coverage of decideSurfaceAdoption.
 */

test("shouldEnterInDocumentSurface: enters when a genuine activeDialog appears while on main", () => {
  assert.equal(
    shouldEnterInDocumentSurface({ onMain: true, activeDialogPresent: true, lastActionSurfaceChangeType: undefined }),
    true,
  );
});

test("shouldEnterInDocumentSurface: enters when the last action carried a surfaceChangeType, even with no activeDialog (a non-aria drawer/panel)", () => {
  assert.equal(
    shouldEnterInDocumentSurface({
      onMain: true,
      activeDialogPresent: false,
      lastActionSurfaceChangeType: "layer_panel_appeared",
    }),
    true,
  );
});

test("shouldEnterInDocumentSurface: never enters while already off main -- no nested drawer-within-drawer support in this PR", () => {
  assert.equal(
    shouldEnterInDocumentSurface({ onMain: false, activeDialogPresent: true, lastActionSurfaceChangeType: undefined }),
    false,
  );
});

test("shouldEnterInDocumentSurface: no-op when neither signal is present", () => {
  assert.equal(
    shouldEnterInDocumentSurface({ onMain: true, activeDialogPresent: false, lastActionSurfaceChangeType: undefined }),
    false,
  );
});

test("shouldLeaveInDocumentSurface: leaves once a dialog-entered surface's own activeDialog signal disappears", () => {
  assert.equal(
    shouldLeaveInDocumentSurface({ activeSurfaceIsInDocument: true, enteredViaActiveDialog: true, activeDialogPresent: false }),
    true,
  );
});

test("shouldLeaveInDocumentSurface: stays while the activeDialog signal is still present", () => {
  assert.equal(
    shouldLeaveInDocumentSurface({ activeSurfaceIsInDocument: true, enteredViaActiveDialog: true, activeDialogPresent: true }),
    false,
  );
});

test("shouldLeaveInDocumentSurface: never auto-leaves a surface entered only via the one-shot surfaceChangeType heuristic (no symmetric presence signal)", () => {
  assert.equal(
    shouldLeaveInDocumentSurface({ activeSurfaceIsInDocument: true, enteredViaActiveDialog: false, activeDialogPresent: false }),
    false,
  );
});

test("shouldLeaveInDocumentSurface: no-op while not currently on an in_document surface at all", () => {
  assert.equal(
    shouldLeaveInDocumentSurface({ activeSurfaceIsInDocument: false, enteredViaActiveDialog: true, activeDialogPresent: false }),
    false,
  );
});
