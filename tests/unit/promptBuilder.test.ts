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
