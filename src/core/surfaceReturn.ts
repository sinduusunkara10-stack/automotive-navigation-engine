/**
 * Return-to-parent recovery (Phase 3 PR 4, see CLAUDE.md and docs/architecture.md
 * "Return-to-parent recovery"): the counterpart to surfaceAdoption.ts's forward direction
 * (adopting a popup/new-tab as the active surface) -- verifiably leaving an adopted surface
 * and resuming on whichever Page sits beneath it on RunState's surface stack.
 *
 * Deliberately not fingerprint-based, unlike milestone-anchored recovery's go_back handling
 * elsewhere in core/: popping the surface stack always deterministically returns to the same
 * live parent Page object RunState already holds a reference to (or the run's own original
 * tracked page, for a surface adopted directly under "main") -- there is no browser-history
 * ambiguity here to resolve by re-observing and matching a fingerprint. Verification is
 * therefore just "is the parent Page still open and readable", not "does it look like the
 * page we expect".
 */

import type { Page } from "playwright";
import type { RunState } from "./state.js";
import { MAIN_SURFACE_ID } from "./state.js";

export interface ReturnToParentResult {
  restored: boolean;
  poppedSurfaceId: string;
  parentSurfaceId: string;
  parentUrl?: string;
  /** Why restored is false. Absent when restored is true. */
  reason?: "parent_closed" | "parent_navigation_unverified";
}

/**
 * Leaves the current (non-"main") surface: closes its own Page if still open (a deliberate
 * go_back-triggered return undoes the adoption, exactly as an ordinary go_back undoes a
 * navigation -- it is never left dangling in the background for a later step to stumble
 * back into), pops it off RunState's surface stack, and verifies the parent surface's own
 * Page is still usable. Never called when state.activeSurface is already MAIN_SURFACE_ID --
 * callers guard on that (there is no parent to return to).
 */
export async function returnToParentSurface(params: { state: RunState; mainPage: Page }): Promise<ReturnToParentResult> {
  const { state, mainPage } = params;
  const poppedSurfaceId = state.activeSurface;
  const childPage = state.activePage;

  if (childPage && !childPage.isClosed()) {
    await childPage.close().catch(() => {
      // Closing is best-effort tidiness, never a condition the return itself depends on --
      // a page that refuses to close (already navigating away, torn down by the site
      // itself) is not a reason to fail the return to its still-live parent.
    });
  }

  state.popSurface();
  const parentSurfaceId = state.activeSurface;
  const parentPage = state.activePage ?? mainPage;

  if (parentPage.isClosed()) {
    return { restored: false, poppedSurfaceId, parentSurfaceId, reason: "parent_closed" };
  }

  try {
    const parentUrl = parentPage.url();
    return { restored: true, poppedSurfaceId, parentSurfaceId, parentUrl };
  } catch {
    return { restored: false, poppedSurfaceId, parentSurfaceId, reason: "parent_navigation_unverified" };
  }
}

export interface ClosedSurfaceRecovery {
  poppedSurfaceId: string;
  parentSurfaceId: string;
}

/**
 * Unexpected-closure detection: the site itself (not a go_back this engine dispatched)
 * closed the currently active adopted surface's own Page -- e.g. a "Continue" button inside
 * the adopted tab that calls window.close() once its own flow finishes. Called once at the
 * top of every runStep, before `page` is resolved for the step, so the rest of the step never
 * observes/dispatches against an already-closed Page. Pops every closed surface in turn
 * (handling the rare case of a closed surface sitting beneath another closed one) until it
 * finds one that is still open, or returns to "main". Never closes anything itself -- the
 * surface is already closed by the time this runs; it only updates RunState's own bookkeeping
 * to match reality.
 */
export function detectClosedAdoptedSurfaces(state: RunState): ClosedSurfaceRecovery[] {
  const recovered: ClosedSurfaceRecovery[] = [];
  while (state.activeSurface !== MAIN_SURFACE_ID && state.activePage?.isClosed()) {
    const poppedSurfaceId = state.activeSurface;
    state.popSurface();
    recovered.push({ poppedSurfaceId, parentSurfaceId: state.activeSurface });
  }
  return recovered;
}
