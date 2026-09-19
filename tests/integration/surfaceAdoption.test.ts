import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { StepLog } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName, byAccessibleNameAndHeading } from "../helpers/scriptedReasoningProvider.js";

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): genuine multi-window Playwright integration coverage of the full
 * click-opens-a-popup -> decideSurfaceAdoption -> RunState.pushSurface(id, Page) ->
 * subsequent steps observe/act against the adopted Page path -- both popup mechanisms
 * (window.open() and target="_blank"), single- and multi-step journeys inside the adopted
 * surface, domain-policy rejection, a nested popup-from-popup chain (adopted within budget,
 * and separately rejected once the budget is exhausted), and nested/repeated-control
 * disambiguation inside the adopted surface. Regression coverage that the pre-existing
 * capture-only popup path is unaffected when allowSurfaceAdoption is unset lives in
 * tests/integration/crossClientAnalyticsCapture.test.ts, unchanged by this PR.
 */

function baseTask(overrides: Partial<TaskRequest> & { startUrl: string; successPattern: string }): TaskRequest {
  const { startUrl, successPattern, ...rest } = overrides;
  return {
    schemaVersion: "1.20.0",
    taskId: "surface-adoption-test",
    objective: "Reach the fixture's confirmed-offer page, following any partner tab it opens.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_milestone",
        type: "url_pattern",
        description: "The current page URL matches the expected milestone fixture.",
        config: { pattern: successPattern },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 10, maxBacktracks: 0 },
    safety: { allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.21.0",
    ...rest,
  };
}

function findAdoptionStep(steps: StepLog[]): StepLog | undefined {
  return steps.find((s) => s.actionResult.surfaceAdopted === true);
}

test("adopt -> single click -> milestone (window.open() popup mechanism)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-source-winopen.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
      },
    });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Open Offer Tab"), byAccessibleName("Confirm Offer")]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const adoptionStep = findAdoptionStep(response.steps);
    assert.ok(adoptionStep, "expected one step whose actionResult.surfaceAdopted is true");
    assert.equal(adoptionStep?.actionResult.openedNewContext, true);
    assert.equal(adoptionStep?.actionResult.adoptionRejectedReason, undefined);

    const adoptedSteps = response.steps.filter((s) => s.observation.activeSurface?.kind === "adopted_context");
    assert.ok(adoptedSteps.length > 0, "expected at least one step observed against the adopted surface");
    for (const s of adoptedSteps) {
      assert.equal(s.observation.activeSurface?.identity, "adopted-1");
    }
    // The tracked main page's own url/title never changed -- only the adopted popup did.
    assert.equal(response.steps[0]?.currentUrl, `${baseUrl}/surface-adopt-source-winopen.html`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("adopt -> popup opened after a delay past the old 250ms window is still detected while the page stays visibly active (regression: delayed surface detection, PR 1)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-source-delayed.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
      },
    });
    // The fixture's click handler opens the popup via setTimeout(..., 1500) -- well past the
    // previous fixed 250ms popup-listener grace window -- while a periodic status-text update
    // keeps the tracked page's own DOM demonstrably active (never fully quiet) until the popup
    // opens, so the settle wait this PR now ties the listener's lifetime to is still running
    // when the popup appears. Prior to this fix, the popup would have opened after the
    // listener was already torn down at the old fixed 250ms mark and gone completely
    // undetected regardless of the page's own activity.
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Open Offer Tab (Delayed)"), byAccessibleName("Confirm Offer")]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const adoptionStep = findAdoptionStep(response.steps);
    assert.ok(adoptionStep, "expected the delayed popup to still be detected and adopted");
    assert.equal(adoptionStep?.actionResult.openedNewContext, true);
    assert.equal(adoptionStep?.actionResult.adoptionRejectedReason, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test(
  "adopt -> popup opened after a delay with NO other page activity is still missed by PR 1 alone (documents the known remaining gap; closed by PR 2's pages() reconciliation, not yet implemented)",
  { skip: "Expected to fail until PR 2 (browserContext.pages() reconciliation) lands -- see click.ts's own PR 1 doc comment for why this case is out of PR 1's scope." },
  async () => {
    const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
    const browser = await chromium.launch();
    const page = await browser.newPage();

    try {
      const task = baseTask({
        startUrl: `${baseUrl}/surface-adopt-source-delayed-quiet.html`,
        successPattern: `${baseUrl}/surface-adopt-milestone.html`,
        safety: {
          allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
          allowSurfaceAdoption: true,
        },
      });
      // No correlated DOM activity on the tracked page while the popup's own 1500ms timer
      // runs -- domSettleProbe exits early (quiet_window, ~250ms) well before the popup
      // opens, the popup listener is torn down at that point, and the popup is missed. This
      // is the exact shape of the real production evidence that originally surfaced the
      // detection gap (a same-document, zero-DOM-change result before the tab appeared).
      const reasoning = new ScriptedReasoningProvider([
        byAccessibleName("Open Offer Tab (Delayed, Quiet)"),
        byAccessibleName("Confirm Offer"),
      ]);

      const response = await runTask({ page, task, reasoning });

      assert.equal(response.status, "success");
      const adoptionStep = findAdoptionStep(response.steps);
      assert.ok(adoptionStep, "expected the delayed popup to be detected and adopted");
    } finally {
      await page.close();
      await browser.close();
      await close();
    }
  },
);

test('adopt -> multiple sequential actions -> milestone (target="_blank" popup mechanism)', async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-source-blank.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      limits: { maxSteps: 12, maxBacktracks: 0 },
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
      },
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("View Offer (new tab)"),
      byAccessibleName("Continue to Details"),
      byAccessibleName("Finish Offer"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const adoptedSteps = response.steps.filter((s) => s.observation.activeSurface?.kind === "adopted_context");
    // Two distinct dispatched actions inside the adopted surface ("Continue to Details" then
    // "Finish Offer") -- proving this is a genuine multi-step journey inside the adopted tab,
    // not a single dispatch-and-check.
    assert.ok(adoptedSteps.length >= 2, `expected >= 2 steps inside the adopted surface, got ${adoptedSteps.length}`);
    const adoptedUrls = adoptedSteps.map((s) => s.currentUrl);
    assert.ok(adoptedUrls.some((u) => u.endsWith("surface-adopt-target-multistep.html")));
    assert.ok(adoptedUrls.some((u) => u.endsWith("surface-adopt-step2.html")));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("adoption rejected by domain policy: a landing domain outside allowedDomains is never adopted, and the run never leaves 'main'", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-source-rejected.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
        surfaceAdoptionDomainPolicy: "require_allowed_domain",
      },
    });
    const reasoning = new ScriptedReasoningProvider([byAccessibleName("Open External Offer")]);

    const response = await runTask({ page, task, reasoning });

    // Never reaches the milestone: the popup's own destination is what confirms the
    // offer, and it was never adopted (never observed/acted on).
    assert.notEqual(response.status, "success");

    const rejectedStep = response.steps.find((s) => s.actionResult.adoptionRejectedReason === "domain_rejected");
    assert.ok(rejectedStep, "expected one step whose actionResult.adoptionRejectedReason is 'domain_rejected'");
    assert.equal(rejectedStep?.actionResult.openedNewContext, true);
    assert.equal(rejectedStep?.actionResult.surfaceAdopted, undefined);

    for (const s of response.steps) {
      assert.deepEqual(s.observation.activeSurface, { kind: "main" });
    }
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("nested popup-from-popup: a popup opened from within an already-adopted popup is itself adopted within budget", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-nested-launcher.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      limits: { maxSteps: 12, maxBacktracks: 0 },
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
        maxAdoptedSurfacesPerRun: 5,
      },
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Partner Tab"),
      byAccessibleName("Open Nested Deal"),
      byAccessibleName("Confirm Nested Deal"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const adoptionSteps = response.steps.filter((s) => s.actionResult.surfaceAdopted === true);
    assert.equal(adoptionSteps.length, 2, "expected two distinct adoption events: the partner tab, then the nested deal tab opened from within it");

    const identities = new Set(
      response.steps
        .filter((s) => s.observation.activeSurface?.kind === "adopted_context")
        .map((s) => s.observation.activeSurface?.identity),
    );
    assert.equal(identities.size, 2, `expected exactly two distinct adopted-surface identities, saw ${[...identities].join(", ")}`);
    assert.ok(identities.has("adopted-1"));
    assert.ok(identities.has("adopted-2"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("nested popup-from-popup: once the per-run budget is exhausted, the nested popup is explicitly rejected -- never silently dropped", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-nested-launcher.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      limits: { maxSteps: 12, maxBacktracks: 0 },
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
        maxAdoptedSurfacesPerRun: 1,
      },
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Partner Tab"),
      byAccessibleName("Open Nested Deal"),
    ]);

    const response = await runTask({ page, task, reasoning });

    // Only the first (partner-tab) adoption succeeds; the nested one is explicitly rejected.
    const adoptionSteps = response.steps.filter((s) => s.actionResult.surfaceAdopted === true);
    assert.equal(adoptionSteps.length, 1);

    const budgetRejectedStep = response.steps.find((s) => s.actionResult.adoptionRejectedReason === "budget_exhausted");
    assert.ok(budgetRejectedStep, "expected one step whose actionResult.adoptionRejectedReason is 'budget_exhausted'");
    assert.equal(budgetRejectedStep?.actionResult.openedNewContext, true);

    // The run never reaches the milestone (the nested deal was never adopted), but it ends
    // deterministically rather than crashing or hanging.
    assert.notEqual(response.status, "success");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("nested/repeated-control disambiguation inside the adopted surface: the correct repeated-label 'Select' is chosen by its own card heading, and a button's own supporting text never leaks into its accessible name", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-source-cards.html`,
      successPattern: `${baseUrl}/surface-adopt-cards-picked-b.html`,
      safety: {
        allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowSurfaceAdoption: true,
      },
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Offer Tab"),
      byAccessibleNameAndHeading("Select", "Electric SUV"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    // Proves the *correct* repeated-label control was picked -- landing on card A's or C's
    // destination instead would mean disambiguation failed and some other "Select" was
    // clicked (e.g. the first one found in DOM order).
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-cards-picked-b.html`);

    const cardsStep = response.steps.find((s) => s.currentUrl.endsWith("surface-adopt-cards.html"));
    assert.ok(cardsStep, "expected one step observed against surface-adopt-cards.html");
    const elements = cardsStep?.observation.interactiveElements ?? [];

    const detailsButton = elements.find((el) => el.accessibleName === "Details");
    assert.ok(detailsButton, "expected the 'Details' button to be present");
    // "Button with supporting text": the adjacent paragraph must never leak into accessibleName.
    assert.equal(detailsButton?.accessibleName, "Details");

    const selectButtons = elements.filter((el) => el.accessibleName === "Select");
    assert.equal(selectButtons.length, 3, "expected all three repeated-label 'Select' buttons to be observed");
    const headings = new Set(selectButtons.map((el) => el.nearestHeadingText));
    assert.deepEqual(headings, new Set(["Compact Sedan", "Electric SUV", "Sports Coupe"]));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
