import { test } from "node:test";
import assert from "node:assert/strict";

import { buildReasoningPrompt } from "../../src/reasoning/promptBuilder.js";
import { buildTestReasoningContext } from "./helpers/reasoningContext.js";

test("buildReasoningPrompt sends only the compact structured fields, never raw HTML or sensitive data", () => {
  const context = buildTestReasoningContext();
  const prompt = buildReasoningPrompt(context);

  const combined = `${prompt.system}\n${prompt.user}`;

  // Never raw HTML / DOM.
  assert.ok(!/<\s*html/i.test(combined));
  assert.ok(!/<\s*script/i.test(combined));
  assert.ok(!/<\s*div/i.test(combined));

  // Never cookies/storage/headers/auth values — these have no getter reachable from
  // ReasoningContext, but assert their names never leak in either (e.g. via a stray
  // notableText entry) to guard against future context fields introducing them.
  for (const forbidden of ["cookie", "authorization", "set-cookie", "localstorage", "sessionstorage", "bearer "]) {
    assert.ok(!combined.toLowerCase().includes(forbidden), `prompt must not mention "${forbidden}"`);
  }

  const payload = JSON.parse(prompt.user) as Record<string, unknown>;
  assert.equal(payload.objective, context.objective);
  assert.deepEqual(payload.allowedActions, context.allowedActions);
  assert.deepEqual(payload.allowedDomains, context.allowedDomains);

  const currentPage = payload.currentPage as Record<string, unknown>;
  assert.equal(currentPage.url, context.observation.url);
  assert.equal(currentPage.title, context.observation.title);

  const elements = currentPage.interactiveElements as Array<Record<string, unknown>>;
  assert.equal(elements.length, context.observation.interactiveElements.length);
  assert.equal(elements[0]?.id, "el-0");
  assert.equal(elements[0]?.type, "a");
  assert.equal(elements[0]?.accessibleName, "Continue");
  assert.equal(elements[0]?.destinationUrl, "https://example-fictional-oem.test/step2.html");
  // The second element has no destinationUrl on the observation — it must not appear
  // as an (undefined/null) key on the prompt payload either.
  assert.ok(!("destinationUrl" in (elements[1] ?? {})));

  const limits = payload.limits as Record<string, unknown>;
  assert.equal(limits.stepsRemaining, context.limits.maxSteps - context.limits.stepsUsed);
  assert.equal(limits.backtracksRemaining, context.limits.maxBacktracks - context.limits.backtracksUsed);
});

test("buildReasoningPrompt bounds recentActions, notableText, and interactiveElements", () => {
  const manyElements = Array.from({ length: 60 }, (_, i) => ({
    id: `el-${i}`,
    role: "a",
    accessibleName: `Link ${i}`,
    visible: true,
  }));
  const manyNotableText = Array.from({ length: 20 }, (_, i) => `Heading ${i}`);
  const manyRecentActions = Array.from({ length: 10 }, () => ({ type: "wait" as const }));

  const context = buildTestReasoningContext({
    observation: {
      url: "https://example-fictional-oem.test/start.html",
      title: "Fictional start page",
      interactiveElements: manyElements,
      notableText: manyNotableText,
    },
    recentActions: manyRecentActions,
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as {
    currentPage: { interactiveElements: unknown[]; notableText: unknown[] };
    recentActions: unknown[];
  };

  assert.ok(payload.currentPage.interactiveElements.length < manyElements.length);
  assert.ok(payload.currentPage.notableText.length < manyNotableText.length);
  assert.ok(payload.recentActions.length < manyRecentActions.length);
});

// ---------------------------------------------------------------------------------------
// REGRESSION (production incident NIS-20260910-94E42B): after successfully reaching an
// offer-details page, the engine re-selected the exact same click action again. The repeat
// produced no observable page-state change, but nothing in `recentActions` told the
// reasoning model that -- it only ever carried `{type, target}`, identical on both calls,
// with no outcome evidence distinguishing "already tried, went nowhere" from "never tried
// yet". core/state.ts now fills in a generic, capture-module-independent
// `observedProgress` flag (a plain url/title diff, computed identically for every action
// type -- see RunState.resolveLastActionProgress) on each RecordedAction; this proves that
// flag actually reaches the prompt payload once buildReasoningPrompt maps it through, and
// that a still-unresolved (most recent) action is omitted rather than sent as a stray
// `null`/`undefined` key.
// ---------------------------------------------------------------------------------------

test("buildReasoningPrompt forwards each recentActions entry's observedProgress flag to the prompt payload", () => {
  const context = buildTestReasoningContext({
    recentActions: [
      { type: "click", target: "el-0", observedProgress: false },
      { type: "click", target: "el-1", observedProgress: true },
      { type: "scroll" },
    ],
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as {
    recentActions: Array<{ type: string; target?: string; observedProgress?: boolean }>;
  };

  assert.equal(payload.recentActions.length, 3);
  assert.equal(payload.recentActions[0]?.observedProgress, false);
  assert.equal(payload.recentActions[1]?.observedProgress, true);
  // The most recently recorded action has no outcome yet (no further observation has been
  // taken to compare against) -- it must be omitted, not sent as an explicit null/undefined.
  assert.ok(!("observedProgress" in (payload.recentActions[2] ?? {})));

  // The system prompt must explain the flag generically -- no brand/CTA/URL wording.
  assert.match(prompt.system, /observedProgress/);
});

// ---------------------------------------------------------------------------------------
// REGRESSION (real production configurator run, schemaVersion 1.3.0): the run blocked on
// repeated_action because Navigation Claude never selected the visible terminal-route
// controls the observation already contained -- it kept scrolling instead. Root cause
// traced to this file: MAX_INTERACTIVE_ELEMENTS truncated
// interactiveElements with a raw positional `.slice(0, N)`, in DOM-scan order, with no
// regard for relevance to the objective. A real page with 40+ visible interactive elements
// before the terminal-route controls (nav, footer, filter chips, language switcher, cookie
// banner, etc.) silently drops those controls from the prompt Navigation Claude actually
// receives, even though the *diagnostic* StepLog.observation (unaffected by this file) is
// never truncated -- so a human reading Get Task Result sees controls the model itself
// never saw. These tests reproduce that mechanism directly and deterministically, with no
// dependency on any real site: a purely synthetic objective/element set is enough to prove
// the defect and the fix, matching CLAUDE.md's rule that src/reasoning stays generic.
// ---------------------------------------------------------------------------------------

test("REGRESSION: a relevant interactive element positioned after the raw truncation cutoff must still reach the prompt", () => {
  const objective = "Reveal the completed configuration summary and stop once it is shown.";
  const fillerElements = Array.from({ length: 50 }, (_, i) => ({
    id: `el-${i}`,
    role: "a",
    accessibleName: `Footer link ${i}`,
    visible: true,
  }));
  const relevantElement = {
    id: "el-50",
    role: "button",
    accessibleName: "Show configuration summary",
    visible: true,
  };

  const context = buildTestReasoningContext({
    objective,
    observation: {
      url: "https://example-fictional-oem.test/configurator/step-4",
      title: "Configurator",
      interactiveElements: [...fillerElements, relevantElement],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };

  assert.ok(
    payload.currentPage.interactiveElements.some((el) => el.id === "el-50"),
    "the objective-relevant control must reach the prompt even though 50 irrelevant elements precede it in DOM order",
  );
});

test("REGRESSION: when nothing on the page is relevant to the objective yet, the prompt still degrades to the first-encountered elements (no crash, no empty page)", () => {
  const objective = "Reveal the completed configuration summary and stop once it is shown.";
  const fillerElements = Array.from({ length: 50 }, (_, i) => ({
    id: `el-${i}`,
    role: "a",
    accessibleName: `Footer link ${i}`,
    visible: true,
  }));

  const context = buildTestReasoningContext({
    objective,
    observation: {
      url: "https://example-fictional-oem.test/homepage",
      title: "Homepage",
      interactiveElements: fillerElements,
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: unknown[] } };
  assert.ok(payload.currentPage.interactiveElements.length > 0);
  assert.ok(payload.currentPage.interactiveElements.length < fillerElements.length);
});

test("REGRESSION: when the element list already fits under the cap, order is left exactly as observed (no needless reordering)", () => {
  const context = buildTestReasoningContext({
    observation: {
      url: "https://example-fictional-oem.test/start.html",
      title: "Start",
      interactiveElements: [
        { id: "el-0", role: "a", accessibleName: "Unrelated link", visible: true },
        { id: "el-1", role: "button", accessibleName: "Continue", visible: true },
      ],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };
  assert.deepEqual(
    payload.currentPage.interactiveElements.map((el) => el.id),
    ["el-0", "el-1"],
  );
});

test("REGRESSION: disabled, ariaState, and progressIndicatorText -- added to Observation for the semantic verifier -- must also reach Navigation Claude's own prompt", () => {
  const context = buildTestReasoningContext({
    observation: {
      url: "https://example-fictional-oem.test/configurator/step-4",
      title: "Configurator",
      interactiveElements: [
        {
          id: "el-0",
          role: "button",
          accessibleName: "Show configuration summary",
          visible: true,
          disabled: true,
          ariaState: { "aria-current": "step" },
        },
      ],
      progressIndicatorText: ["Step 4 of 4"],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as {
    currentPage: { interactiveElements: Array<Record<string, unknown>>; progressIndicatorText?: string[] };
  };

  assert.equal(payload.currentPage.interactiveElements[0]?.disabled, true);
  assert.deepEqual(payload.currentPage.interactiveElements[0]?.ariaState, { "aria-current": "step" });
  assert.deepEqual(payload.currentPage.progressIndicatorText, ["Step 4 of 4"]);
});

// ---------------------------------------------------------------------------------------
// REGRESSION (real production run): a full-viewport overlay (e.g. a consent-style banner)
// sat on top of the page's real terminal-route controls -- they were visible in the DOM
// but not actually clickable, while the overlay's own dismiss control was the only
// genuinely reachable one. Navigation Claude selected the overlay's control based on
// nothing but visibility, matching the underlying page, then failed to dispatch it
// because it never distinguished "visible" from "actually clickable right now". Root
// cause traced to src/observation/observationBuilder.ts's buildObservation never
// computing or forwarding whether a control is covered by another element -- only the
// separate, per-id readElementState (pre-dispatch revalidation only) did. These tests
// prove `covered` (once buildObservation computes it) reaches the actual prompt payload
// Navigation Claude sees, and that the structural fallback (stratifiedSample) does not
// prefer a covered element over an uncovered one within the same stratum. Entirely
// synthetic, generic fixtures -- no CTA wording, no site-specific selector.
// ---------------------------------------------------------------------------------------

test("REGRESSION: covered is forwarded to the prompt exactly as observed, never defaulted for an uncovered element", () => {
  const context = buildTestReasoningContext({
    observation: {
      url: "https://example-fictional-oem.test/configurator/step-4",
      title: "Configurator",
      interactiveElements: [
        { id: "el-0", role: "button", accessibleName: "Show configuration summary", visible: true, covered: true },
        { id: "el-1", role: "button", accessibleName: "Continue", visible: true },
      ],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as {
    currentPage: { interactiveElements: Array<Record<string, unknown>> };
  };

  assert.equal(payload.currentPage.interactiveElements[0]?.covered, true);
  assert.ok(!("covered" in (payload.currentPage.interactiveElements[1] ?? {})));
});

test("REGRESSION: a covered control reaching the structural fallback is still correctly flagged covered, and an uncovered alternative is not crowded out by it", () => {
  const fillers = buildManyElements(60);
  const coveredDecoy = { id: "el-60", role: "button", accessibleName: "Résumé", visible: true, covered: true };
  const uncoveredControl = { id: "el-61", role: "button", accessibleName: "Continuez", visible: true };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...fillers, coveredDecoy, uncoveredControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string; covered?: boolean }> } };

  const uncoveredEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-61");
  assert.ok(uncoveredEntry, "the uncovered terminal control must reach the prompt");

  const coveredEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-60");
  if (coveredEntry) {
    assert.equal(coveredEntry.covered, true, "a covered control must never be silently promoted as uncovered/actionable");
  }
});

// ---------------------------------------------------------------------------------------
// REGRESSION (real production run, second occurrence, schemaVersion 1.3.0): the previous
// fix (lexical objective-relevance ranking) does not, on its own, rescue a terminal-route
// control whose accessible name shares *zero* literal vocabulary with the objective --
// exactly the real-world case of an English objective and a non-English page. Verified
// empirically while diagnosing this: objectiveRelevanceScore("...summary...", "Résumé")
// is 0, because tokenize() (src/discovery/relevance.ts) splits on any non-[a-z0-9]
// character, so the accented "é" fragments "Résumé" into "sum" -- a different token string
// than "summary", not a substring match. A zero-relevance control then ties with ordinary
// filler content and, before this fix, lost the plain DOM-index tie-break whenever
// positioned after 40+ other elements -- exactly what a real, complex configurator page
// (many product/spec/finance controls before the final step) makes likely. These tests
// use entirely synthetic, generic fixtures -- no live brand, label, or element id.
// ---------------------------------------------------------------------------------------

const ENGLISH_OBJECTIVE =
  "Navigate to the official consumer vehicle configurator, proceed through the configuration steps using " +
  "existing defaults where necessary, and stop once the objective destination -- the completed " +
  "configuration summary -- has been reached and confirmed.";

function buildManyElements(count: number, offset = 0): Array<{ id: string; role: string; accessibleName: string; visible: boolean }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `el-${i + offset}`,
    role: i % 5 === 0 ? "button" : "a",
    accessibleName: `Option or link number ${i + offset}`,
    visible: true,
  }));
}

test("REGRESSION: a terminal-route control with a non-English label and zero direct token overlap with an English objective still reaches the prompt", () => {
  const fillers = buildManyElements(63);
  const terminalControl = { id: "el-63", role: "button", accessibleName: "Résumé", visible: true };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    successCriteria: [{ id: "objective-destination-reached", type: "url_pattern", description: ENGLISH_OBJECTIVE, required: true }],
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...fillers, terminalControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };
  assert.ok(
    payload.currentPage.interactiveElements.some((el) => el.id === "el-63"),
    "the non-English terminal control must still reach the prompt despite zero lexical overlap with the objective",
  );
});

test("REGRESSION: an alternative terminal-route control (also zero lexical overlap) reaches the prompt alongside the first", () => {
  const fillers = buildManyElements(63);
  const summaryControl = { id: "el-63", role: "button", accessibleName: "Résumé", visible: true };
  const continueControl = { id: "el-64", role: "button", accessibleName: "Continuez", visible: true };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    successCriteria: [{ id: "objective-destination-reached", type: "url_pattern", description: ENGLISH_OBJECTIVE, required: true }],
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...fillers, summaryControl, continueControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };
  const ids = payload.currentPage.interactiveElements.map((el) => el.id);
  assert.ok(ids.includes("el-63"), "the Résumé-equivalent control must reach the prompt");
  assert.ok(ids.includes("el-64"), "the Continuez-equivalent control must also reach the prompt");
});

test("REGRESSION: dozens of repetitive, zero-relevance controls cannot consume the entire prompt allowance and hide a structurally distinctive terminal control", () => {
  // 90 near-identical repetitive elements (e.g. a long, repeated list of spec/filter
  // toggles) followed by a single terminal control -- proves the structural fallback
  // spreads coverage across the whole page rather than being crowded out by bulk content.
  const repetitive = Array.from({ length: 90 }, (_, i) => ({
    id: `el-${i}`,
    role: "button",
    accessibleName: "Voir plus",
    visible: true,
  }));
  const terminalControl = { id: "el-90", role: "button", accessibleName: "Résumé", visible: true };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    successCriteria: [{ id: "objective-destination-reached", type: "url_pattern", description: ENGLISH_OBJECTIVE, required: true }],
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...repetitive, terminalControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string; accessibleName: string }> } };
  assert.ok(
    payload.currentPage.interactiveElements.some((el) => el.id === "el-90"),
    "the single structurally distinctive terminal control must survive alongside the repetitive bulk",
  );
  const repetitiveSelectedCount = payload.currentPage.interactiveElements.filter((el) => el.accessibleName === "Voir plus").length;
  assert.ok(
    repetitiveSelectedCount < payload.currentPage.interactiveElements.length,
    "the repetitive cluster must not consume the entire prompt allowance",
  );
});

test("selected prompt candidates always remain bounded by MAX_INTERACTIVE_ELEMENTS + the bounded group allowance (40 + 10 = 50), regardless of candidate count", () => {
  const manyElements = buildManyElements(500);
  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: manyElements,
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: unknown[] } };
  // Selection is normally capped at 40 (MAX_INTERACTIVE_ELEMENTS); the bounded
  // container-group allowance (MAX_GROUP_ADDITIONS) can add up to 10 more on top, but
  // selectedCount must never exceed that combined ceiling. This fixture is one giant
  // uninterrupted zero-relevance run (no relevance-scored elements anywhere), so per
  // MAX_CONTAINER_SPAN's own bound every stratum representative's natural run is far
  // longer than the cap and group-inclusion contributes nothing here at all --
  // selectedCount actually lands at exactly 40, still comfortably within the combined
  // ceiling this test asserts.
  assert.ok(payload.currentPage.interactiveElements.length <= 50);
  assert.equal(prompt.elementSelection.selectedCount, payload.currentPage.interactiveElements.length);
  assert.ok(prompt.elementSelection.candidateCount === 500);
});

test("REGRESSION: a disabled control reaching the structural fallback is still correctly flagged disabled, never silently promoted as actionable", () => {
  const fillers = buildManyElements(60);
  // A disabled decoy, positioned so it would otherwise be a strong structural (tail-
  // anchor) candidate, alongside a plain enabled control in the same region.
  const disabledDecoy = { id: "el-60", role: "button", accessibleName: "Résumé", visible: true, disabled: true };
  const enabledControl = { id: "el-61", role: "button", accessibleName: "Continuez", visible: true, disabled: false };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...fillers, disabledDecoy, enabledControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string; disabled?: boolean }> } };
  const enabledEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-61");
  assert.ok(enabledEntry, "the plain enabled control must reach the prompt");

  // A caller (or Navigation Claude) must never be told a control is actionable when it
  // isn't: if the disabled decoy also happens to be included, it must still be correctly
  // flagged disabled -- never silently promoted as an actionable candidate.
  const disabledEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-60");
  if (disabledEntry) {
    assert.equal(disabledEntry.disabled, true);
  }
});

test("REGRESSION: a control marked not visible is never prioritised by the structural fallback ahead of a visible one (defense in depth -- observationBuilder.ts already excludes invisible elements upstream)", () => {
  const fillers = buildManyElements(60);
  const invisibleDecoy = { id: "el-60", role: "button", accessibleName: "Résumé", visible: false };
  const visibleControl = { id: "el-61", role: "button", accessibleName: "Continuez", visible: true };

  const context = buildTestReasoningContext({
    objective: ENGLISH_OBJECTIVE,
    observation: {
      url: "https://example-fictional-oem.test/configurator",
      title: "Configurator",
      interactiveElements: [...fillers, invisibleDecoy, visibleControl],
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string; visible: boolean }> } };
  const visibleEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-61");
  assert.ok(visibleEntry, "the visible control must reach the prompt");

  const invisibleEntry = payload.currentPage.interactiveElements.find((el) => el.id === "el-60");
  if (invisibleEntry) {
    assert.equal(invisibleEntry.visible, false, "an invisible element must never be reported as visible");
  }
});

// ---------------------------------------------------------------------------------------
// consentInteractionPolicy (types/task-request.ts): a plain-language, generic system-
// prompt instruction driven entirely by the request's own consent policy enum -- no CTA
// wordlist, no translation table, no vendor/CMP-specific selector. The engine only ever
// decides WHETHER/HOW MUCH latitude the model has; which specific control best fits the
// resulting semantic description is left to the model, exactly like every other choice in
// this prompt.
// ---------------------------------------------------------------------------------------

test("REGRESSION: the default policy (reject_optional) instructs the model to prefer a non-accepting control and never grant broad/optional consent", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "reject_optional" });
  const prompt = buildReasoningPrompt(context);
  assert.match(prompt.system, /"reject_optional"/);
  assert.match(prompt.system, /decline, reject optional consent, or.{0,10}continue without accepting/i);
  assert.match(prompt.system, /never click a control whose purpose is to grant broad or optional consent/i);
});

test("REGRESSION: reject_optional explicitly prefers a decline-and-continue control over a manage/settings control, even when both are present", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "reject_optional" });
  const prompt = buildReasoningPrompt(context);
  assert.match(prompt.system, /choose that control over one whose purpose is to manage\/customize consent settings/i);
  assert.match(prompt.system, /not a substitute for a direct decline-and-continue control/i);
});

test("REGRESSION: do_not_interact forbids clicking any consent/tracking-preference control at all, even to clear a blocker", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "do_not_interact" });
  const prompt = buildReasoningPrompt(context);
  assert.match(prompt.system, /"do_not_interact"/);
  assert.match(prompt.system, /never click any control whose semantic purpose is to manage consent/i);
});

test("REGRESSION: accept_optional is the only policy that permits granting optional consent, and only to clear a genuine blocker", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "accept_optional" });
  const prompt = buildReasoningPrompt(context);
  assert.match(prompt.system, /"accept_optional"/);
  assert.match(prompt.system, /you may click a control that grants optional consent/i);

  // No other policy's prompt ever grants this latitude.
  for (const policy of ["reject_optional", "essential_only", "do_not_interact"] as const) {
    const otherPrompt = buildReasoningPrompt(buildTestReasoningContext({ consentInteractionPolicy: policy }));
    assert.doesNotMatch(otherPrompt.system, /you may click a control that grants optional consent/i);
  }
});

test("REGRESSION: essential_only never permits granting broad/optional consent, and never claims to alter a granular settings screen", () => {
  const context = buildTestReasoningContext({ consentInteractionPolicy: "essential_only" });
  const prompt = buildReasoningPrompt(context);
  assert.match(prompt.system, /"essential_only"/);
  assert.match(prompt.system, /never click a control whose purpose is to grant broad or optional consent/i);
  assert.match(prompt.system, /never guess at or alter a granular settings screen/i);
});

// ---------------------------------------------------------------------------------------
// FIX (real production run): a stratum can contain several *adjacent* zero-relevance
// elements that together form one semantic decision group (e.g. several sibling controls
// of one dismissible panel) -- stratifiedSample picks only one representative per stratum,
// so the group could be silently split across the truncation boundary depending purely on
// where the arithmetic stratum edges land, with no regard for which elements are actually
// related. The fix (MAX_CONTAINER_SPAN/MAX_GROUP_ADDITIONS in promptBuilder.ts) walks the
// natural, uninterrupted run of zero-relevance elements around a stratum representative
// (bounded by relevance-scored elements on either side, or by the array edge) and includes
// the whole run when it's short enough to plausibly be one small shared container -- purely
// structural, no CTA text dictionary, no consent-keyword list, no brand-specific wording.
// This fixture is entirely generic/synthetic (no live brand, label, or element id).
// ---------------------------------------------------------------------------------------

test("FIX: an adjacent zero-relevance decision group bounded by relevant elements reaches the prompt together, while content outside that boundary does not, and the total stays bounded", () => {
  const objective = "Advance through the product setup wizard and confirm the final review step.";

  // 205 elements: 203 zero-relevance plus 2 relevance-scored "boundary" elements (sharing
  // objective vocabulary) flanking a 3-element decision group at indices 61-63 -- the
  // boundaries give the group a natural, provable edge, distinct from an unrelated
  // open-ended run of filler. With MAX_INTERACTIVE_ELEMENTS=40, 2 relevant matches, and
  // TAIL_ANCHOR_COUNT=5, the structural strata pool is exactly 198 wide over 33 strata --
  // an exact stratum width of 6, so stratum 10 covers pool positions [60, 66), which maps
  // (skipping the boundary at true index 60) to true indices {61, 62, 63, 65, 66, 67}.
  const elements = Array.from({ length: 205 }, (_, i) => ({
    id: `el-${i}`,
    role: "button",
    accessibleName: `Row ${i}`,
    visible: true,
  }));

  elements[60] = { id: "el-60", role: "text", accessibleName: "Product setup step information", visible: true };
  // Three adjacent controls -- generic fixture wording for "continue without optional
  // consent / manage settings / accept all", deliberately not the real incident's wording.
  // stratifiedSample always prefers the first actionable, non-option-like element in a
  // stratum, so el-61 (the group's first member) becomes stratum 10's sole representative.
  elements[61] = { id: "el-61", role: "button", accessibleName: "Continue without accepting optional data", visible: true };
  elements[62] = { id: "el-62", role: "button", accessibleName: "Manage settings", visible: true };
  elements[63] = { id: "el-63", role: "button", accessibleName: "Accept all data collection", visible: true };
  elements[64] = { id: "el-64", role: "text", accessibleName: "Product setup step information", visible: true };

  const context = buildTestReasoningContext({
    objective,
    observation: {
      url: "https://example-fictional-oem.test/setup",
      title: "Setup wizard",
      interactiveElements: elements,
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };
  const ids = payload.currentPage.interactiveElements.map((el) => el.id);

  assert.ok(ids.includes("el-61"), "the stratum-selected member of the decision group must reach the prompt");
  assert.ok(ids.includes("el-62"), "a member of the same natural run as the selected group member must reach the prompt too");
  assert.ok(ids.includes("el-63"), "the whole adjacent decision group must reach the prompt together");

  // el-59 sits just before the left boundary (relevant, at el-60) -- outside the group's
  // natural run entirely. el-65/66/67 are the *rest* of stratum 10's own window, on the
  // far side of the right boundary (el-64) -- proving the boundary actually stopped the
  // walk rather than it silently continuing to sweep in the whole stratum window.
  assert.ok(!ids.includes("el-59"), "content on the far side of the group's left boundary must not be pulled in");
  assert.ok(!ids.includes("el-65"), "content on the far side of the group's right boundary must not be pulled in");
  assert.ok(!ids.includes("el-66"), "content on the far side of the group's right boundary must not be pulled in");
  assert.ok(!ids.includes("el-67"), "content on the far side of the group's right boundary must not be pulled in");

  // Bound: normal per-tier selection is capped at MAX_INTERACTIVE_ELEMENTS (40); group
  // inclusion can add at most MAX_GROUP_ADDITIONS (10) more, never unbounded.
  assert.ok(prompt.elementSelection.selectedCount > 40, "group inclusion must have added elements beyond the normal cap");
  assert.ok(prompt.elementSelection.selectedCount <= 50, "selectedCount must never exceed limit + MAX_GROUP_ADDITIONS");
  assert.equal(payload.currentPage.interactiveElements.length, prompt.elementSelection.selectedCount);

  // Deduplication: every selected id is unique.
  assert.equal(new Set(ids).size, ids.length, "the final selection must never contain duplicate elements");
});

// ---------------------------------------------------------------------------------------
// CONFIRMED ISSUE 1 (run_a9eb40df-0191-44af-9ce9-acdcab7e8bb5): PR #35's fixed +/-2
// index-distance neighbour pull still split a real, adjacent decision group when its
// primary decline/continue control sat *three* index positions away from the
// stratum-selected anchor, with two purely informational links in between it and the
// manage/accept controls -- exactly the shape reproduced generically below (never the
// real incident's brand, wording, URL, or selector). The container-span walk above fixes
// this generally: it recovers the group's *entire* natural run regardless of which member
// happens to be the stratum's own pick, and regardless of how many non-action informational
// elements sit between the group's ends.
// ---------------------------------------------------------------------------------------

test("FIX (issue 1): a five-element overlay group -- decline, two informational links, manage, accept -- reaches the prompt together even though the decline control sits three positions before the stratum-selected manage control", () => {
  const objective = "Advance through the product setup wizard and confirm the final review step.";

  // 205 elements: 203 zero-relevance plus 2 relevance-scored boundary elements flanking a
  // 5-element overlay group at indices 184-188. Stratum 30 (pool [180,186)) picks el-180
  // (plain filler) as its own representative; stratum 31 (pool [186,192)) picks el-187
  // ("Manage settings") as its own representative -- reproducing the reported shape
  // exactly: the primary decline/continue control (el-184) is three index positions before
  // the stratum-selected manage control (el-187), with two informational links in between.
  const elements = Array.from({ length: 205 }, (_, i) => ({
    id: `el-${i}`,
    role: "button",
    accessibleName: `Row ${i}`,
    visible: true,
  }));

  elements[183] = { id: "el-183", role: "text", accessibleName: "Product setup step information", visible: true };
  elements[184] = { id: "el-184", role: "button", accessibleName: "Continue without accepting optional data", visible: true };
  elements[185] = { id: "el-185", role: "link", accessibleName: "Cookie policy information", visible: true };
  elements[186] = { id: "el-186", role: "link", accessibleName: "Privacy policy information", visible: true };
  elements[187] = { id: "el-187", role: "button", accessibleName: "Manage settings", visible: true };
  elements[188] = { id: "el-188", role: "button", accessibleName: "Accept all", visible: true };
  elements[189] = { id: "el-189", role: "text", accessibleName: "Product setup step information", visible: true };

  const context = buildTestReasoningContext({
    objective,
    observation: {
      url: "https://example-fictional-oem.test/setup",
      title: "Setup wizard",
      interactiveElements: elements,
    },
  });

  const prompt = buildReasoningPrompt(context);
  const payload = JSON.parse(prompt.user) as { currentPage: { interactiveElements: Array<{ id: string }> } };
  const ids = payload.currentPage.interactiveElements.map((el) => el.id);

  assert.ok(ids.includes("el-187"), "the stratum-selected manage control must reach the prompt");
  assert.ok(
    ids.includes("el-184"),
    "the primary decline/continue control must reach the prompt even though it is three positions before the selected manage control -- this is the exact issue-1 regression",
  );
  assert.ok(ids.includes("el-185"), "the informational link between decline and manage must reach the prompt");
  assert.ok(ids.includes("el-186"), "the second informational link between decline and manage must reach the prompt");
  assert.ok(ids.includes("el-188"), "the accept control must reach the prompt alongside the rest of the group");

  // Unrelated controls just outside the overlay (immediately past each boundary) are not
  // added.
  assert.ok(!ids.includes("el-182"), "content just outside the overlay's left boundary must not be pulled in");
  assert.ok(!ids.includes("el-190"), "content just outside the overlay's right boundary must not be pulled in");

  // The prompt selection ceiling remains enforced.
  assert.ok(prompt.elementSelection.selectedCount > 40, "group inclusion must have added elements beyond the normal cap");
  assert.ok(prompt.elementSelection.selectedCount <= 50, "selectedCount must never exceed limit + MAX_GROUP_ADDITIONS");
  assert.equal(payload.currentPage.interactiveElements.length, prompt.elementSelection.selectedCount);

  // Deduplication remains correct.
  assert.equal(new Set(ids).size, ids.length, "the final selection must never contain duplicate elements");
});

test("REGRESSION: the system prompt never mentions accepting/granting consent as a preference under any policy except the explicit accept_optional opt-in", () => {
  // Guards against a future edit accidentally biasing the *default* wording toward
  // acceptance -- the one behaviour this whole mechanism must never default to.
  const defaultPrompt = buildReasoningPrompt(buildTestReasoningContext({ consentInteractionPolicy: "reject_optional" }));
  assert.doesNotMatch(defaultPrompt.system, /prefer.{0,40}accept/i);
});
