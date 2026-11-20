/**
 * Drawer/modal formalization (Phase 3 PR 5, see CLAUDE.md and docs/architecture.md "Drawer/
 * modal formalization"): the counterpart to surfaceAdoption.ts's decision logic, but for a
 * same-document overlay (a drawer/modal/side panel) instead of a genuinely separate Page.
 * `RunState.pushSurface`/`popSurface` already support a Page-less surface (used by PR 2's own
 * pre-adoption stack-mechanics tests) -- this module only decides *when* to enter/leave one,
 * from the same generic, brand-agnostic evidence the engine already collects for other
 * purposes: Observation.activeDialog (a visible role="dialog"/aria-modal/native <dialog>) and
 * RecordedAction.surfaceChangeType (the broader, non-aria-markup-dependent heuristic already
 * used by src/reasoning/promptBuilder.ts's own prompt guidance and by branch exploration's
 * surfacesOpened tracking).
 *
 * Pure decision logic, no Page, no side effects -- fully unit-testable, exactly like
 * core/surfaceAdoption.ts's decideSurfaceAdoption.
 */

/**
 * Whether this step should enter a new in_document surface. Considered while on "main" OR on
 * an already-adopted "adopted_context" surface (adopted-context panel-evidence fix) -- a
 * drawer/panel/modal opened inside a tab the engine has already adopted (e.g. a configurator
 * opened as its own browsing context) is exactly as real an in-page surface as one opened on
 * "main", and the panel-evidence subsystem this nesting enables (causal linkage, scoped
 * headings/interactiveText, relevance context) must not be unavailable just because the
 * parent happens not to be "main". Never considered while already on an in_document surface --
 * a second drawer/panel opening from within an already-tracked in_document surface (nested
 * drawers, two levels deep) stays out of scope (see docs/architecture.md "Known limitations");
 * it simply leaves the existing in_document surface active rather than incorrectly nesting or
 * replacing it. This is still only one level of in-document nesting, exactly as before -- the
 * parent surface it nests under is just no longer restricted to "main".
 */
export function shouldEnterInDocumentSurface(params: {
  currentSurfaceKind: "main" | "adopted_context" | "in_document";
  activeDialogPresent: boolean;
  lastActionSurfaceChangeType: string | undefined;
}): boolean {
  return (
    params.currentSurfaceKind !== "in_document" &&
    (params.activeDialogPresent || Boolean(params.lastActionSurfaceChangeType))
  );
}

/**
 * Whether the currently-active in_document surface should be left because it visibly closed
 * on its own (its own "Close"/dismiss control, or navigating away entirely) -- never a
 * go_back this engine dispatched, which core/surfaceReturn.ts's returnToParentSurface already
 * handles identically for this surface kind (it is Page-less, so nothing is closed, only
 * popped). Only decidable for a surface that was entered via a genuine activeDialog signal:
 * that gives a symmetric "is it still there" check on every later observation. A surface
 * entered only via the one-shot surfaceChangeType heuristic (a non-aria drawer/panel) has no
 * equivalent persistent presence signal, so it is left active until an explicit return -- a
 * documented, honest scope limit rather than a guessed-at heuristic.
 */
export function shouldLeaveInDocumentSurface(params: {
  activeSurfaceIsInDocument: boolean;
  enteredViaActiveDialog: boolean;
  activeDialogPresent: boolean;
}): boolean {
  return params.activeSurfaceIsInDocument && params.enteredViaActiveDialog && !params.activeDialogPresent;
}
