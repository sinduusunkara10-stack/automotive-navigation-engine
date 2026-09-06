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

test("selected prompt candidates always remain bounded by MAX_INTERACTIVE_ELEMENTS (40), regardless of candidate count", () => {
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
  assert.ok(payload.currentPage.interactiveElements.length <= 40);
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

test("REGRESSION: the system prompt never mentions accepting/granting consent as a preference under any policy except the explicit accept_optional opt-in", () => {
  // Guards against a future edit accidentally biasing the *default* wording toward
  // acceptance -- the one behaviour this whole mechanism must never default to.
  const defaultPrompt = buildReasoningPrompt(buildTestReasoningContext({ consentInteractionPolicy: "reject_optional" }));
  assert.doesNotMatch(defaultPrompt.system, /prefer.{0,40}accept/i);
});
