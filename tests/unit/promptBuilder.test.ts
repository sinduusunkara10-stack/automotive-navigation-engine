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
