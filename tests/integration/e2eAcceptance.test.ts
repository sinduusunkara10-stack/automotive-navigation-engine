import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName, byAccessibleNameAndHeading } from "../helpers/scriptedReasoningProvider.js";

/**
 * Phase 3 end-to-end acceptance tests (see CLAUDE.md and docs/architecture.md "Drawer/modal
 * formalization"): the two full journeys the whole five-PR pass exists to prove, each against
 * a local fixture reproducing its shape.
 *
 * Test 1 (new tab): original page -> continue -> new tab opens with multiple CTAs -> the
 * correct one is selected among several repeated-label candidates -> multiple subsequent
 * steps inside the tab -> the requested milestone is verified.
 *
 * Test 2 (drawer/modal): original page -> a same-document drawer opens -> its own nested
 * controls are correctly disambiguated -> the correct nested CTA is selected -> multiple
 * subsequent steps -> the milestone is verified; plus a variant proving return-to-parent
 * (PR 4's machinery) works identically for a Page-less in_document surface as it does for a
 * genuinely separate adopted Page.
 */

function baseTask(overrides: Partial<TaskRequest> & { startUrl: string; successPattern: string }): TaskRequest {
  const { startUrl, successPattern, ...rest } = overrides;
  return {
    schemaVersion: "1.24.0",
    taskId: "e2e-acceptance-test",
    // Deliberately short and vocabulary-matched to e2e-newtab-cards.html's own title text
    // ("Choose a Vehicle -- Confirmation") -- see surfaceAdoption.test.ts's own baseTask
    // comment for why (surface-relevance corrective work, PR 5). Only test 1 (new tab) below
    // ever opens a real popup and so is the only one this gate applies to; test 2/2-variant
    // (drawer/modal) use the Page-less in_document surface path, untouched by relevance
    // scoring.
    objective: "Choose a vehicle and reach the confirmation milestone.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_milestone",
        type: "url_pattern",
        description: "The confirmation milestone page is reached.",
        config: { pattern: successPattern },
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 10, maxBacktracks: 3 },
    safety: {
      allowedActions: ["click", "capture", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
    },
    outputSchemaVersion: "1.25.0",
    ...rest,
  };
}

test("end-to-end acceptance 1 (new tab): continue -> new tab with multiple CTAs -> correct one selected -> multi-step -> milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/e2e-newtab-source.html`,
      successPattern: `${baseUrl}/e2e-newtab-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Continue"),
      byAccessibleNameAndHeading("Select", "Electric SUV"),
      byAccessibleName("Continue"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/e2e-newtab-milestone.html`);

    // Proves the *correct* repeated-label "Select" was chosen -- landing on card A's or C's
    // own detail page instead would mean disambiguation failed.
    assert.ok(response.steps.some((s) => s.currentUrl.endsWith("e2e-newtab-detail-b.html")));
    assert.ok(!response.steps.some((s) => s.currentUrl.endsWith("e2e-newtab-detail-a.html")));
    assert.ok(!response.steps.some((s) => s.currentUrl.endsWith("e2e-newtab-detail-c.html")));

    const adoptedSteps = response.steps.filter((s) => s.observation.activeSurface?.kind === "adopted_context");
    assert.ok(adoptedSteps.length >= 2, "expected multiple steps observed inside the adopted tab");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("end-to-end acceptance 2 (drawer/modal): open drawer -> nested controls prioritized and disambiguated -> correct CTA -> multi-step -> milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/e2e-drawer-source.html`,
      successPattern: `${baseUrl}/e2e-drawer-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Finance Drawer"),
      byAccessibleNameAndHeading("Select", "Flex Plan"),
      byAccessibleName("Continue"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/e2e-drawer-milestone.html`);

    // Proves the *correct* repeated-label "Select" (inside the drawer) was chosen.
    assert.ok(response.steps.some((s) => s.currentUrl.endsWith("e2e-drawer-detail-flex.html")));
    assert.ok(!response.steps.some((s) => s.currentUrl.endsWith("e2e-drawer-detail-standard.html")));
    assert.ok(!response.steps.some((s) => s.currentUrl.endsWith("e2e-drawer-detail-premium.html")));

    // The step observed right after the drawer opened is reported as "in_document", not
    // "main" -- drawer/modal formalization (Phase 3 PR 5) making that explicit rather than
    // only implicit in activeDialog/covered element counts.
    const drawerStep = response.steps.find((s) => s.currentUrl.endsWith("e2e-drawer-source.html") && s.observation.activeDialog);
    assert.ok(drawerStep, "expected a step observed with the drawer's own activeDialog present");
    assert.deepEqual(drawerStep?.observation.activeSurface?.kind, "in_document");

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present for the in_document lifecycle too");
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "adopted"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("end-to-end acceptance 2 variant (drawer dead end): an explicit go_back off a drawer returns to 'main' (bookkeeping-only, since it is Page-less) and the run continues to the milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/e2e-drawer-deadend-source.html`,
      successPattern: `${baseUrl}/e2e-drawer-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Support Drawer"),
      "go_back",
      byAccessibleName("Continue After Drawer"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/e2e-drawer-milestone.html`);

    const goBackStep = response.steps.find((s) => s.selectedAction.type === "go_back");
    assert.ok(goBackStep, "expected one step whose selectedAction is go_back");
    assert.equal(goBackStep?.actionResult.success, true);

    const stepAfterReturn = response.steps[response.steps.indexOf(goBackStep!) + 1];
    assert.deepEqual(stepAfterReturn?.observation.activeSurface, { kind: "main" });

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "adopted" && a.surfaceId.startsWith("in_document-")));
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "returned" && a.surfaceId.startsWith("in_document-")));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
