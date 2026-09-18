import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { ScriptedReasoningProvider, byAccessibleName } from "../helpers/scriptedReasoningProvider.js";

/**
 * Return-to-parent recovery (Phase 3 PR 4, see CLAUDE.md and docs/architecture.md
 * "Return-to-parent recovery"): genuine multi-window Playwright integration coverage of
 * leaving an adopted surface and resuming on its parent -- both when a go_back is the
 * reasoning layer's own explicit decision, and when the engine's own journey-replanning
 * fallback substitutes one after a dead end -- plus the site itself closing an adopted
 * surface before any go_back was ever dispatched. Unit coverage of the underlying
 * returnToParentSurface/detectClosedAdoptedSurfaces mechanics themselves (verified/failed
 * restore, nested chains) lives in tests/unit/surfaceReturn.test.ts.
 */

function baseTask(overrides: Partial<TaskRequest> & { startUrl: string; successPattern: string }): TaskRequest {
  const { startUrl, successPattern, ...rest } = overrides;
  return {
    schemaVersion: "1.20.0",
    taskId: "surface-return-test",
    objective: "Reach the fixture's milestone page, returning to the original tab if a partner tab leads nowhere.",
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
    limits: { maxSteps: 10, maxBacktracks: 3 },
    safety: {
      allowedActions: ["click", "capture", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
    },
    outputSchemaVersion: "1.21.0",
    ...rest,
  };
}

test("explicit go_back while off 'main': returns to the parent tab, then continues on it to the milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-return-source.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Partner Tab"),
      "go_back",
      byAccessibleName("Continue After Return"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const goBackStep = response.steps.find((s) => s.selectedAction.type === "go_back");
    assert.ok(goBackStep, "expected one step whose selectedAction is go_back");
    assert.equal(goBackStep?.actionResult.success, true);

    // The step immediately after the return is observed against "main" again, not the
    // (now-closed) adopted surface.
    const stepAfterReturn = response.steps[response.steps.indexOf(goBackStep!) + 1];
    assert.deepEqual(stepAfterReturn?.observation.activeSurface, { kind: "main" });
    assert.equal(stepAfterReturn?.currentUrl, `${baseUrl}/surface-adopt-return-source.html`);

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    assert.equal(surfaceAdoption?.returnAttempts, 1);
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "adopted"));
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "returned"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("dead end inside the adopted surface: the engine's own journey-replanning fallback substitutes go_back, then continues on the parent to the milestone", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-return-source.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      // stop_failure deliberately excluded: ScriptedReasoningProvider's own fallback prefers
      // stop_failure over stop_blocked whenever both are allowed, but journey replanning
      // (below) only ever engages for a stop_blocked decision -- exactly what a real
      // reasoning layer proposes when it finds no permitted action on a genuine dead end.
      safety: {
        allowedActions: ["click", "capture", "go_back", "stop_success", "stop_blocked"],
        allowSurfaceAdoption: true,
      },
    });
    // No explicit "go_back" in this queue -- the partner tab is a genuine dead end (nothing
    // on it matches "Continue After Return"), so the reasoning layer proposes stop_blocked
    // and the engine's own journey-replanning fallback (core/loop.ts) is what substitutes
    // go_back here, off "main" -- proving that internal substitution path, not just an
    // explicitly-scripted one.
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Partner Tab"),
      byAccessibleName("Continue After Return"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    const goBackStep = response.steps.find((s) => s.selectedAction.type === "go_back");
    assert.ok(goBackStep, "expected the journey-replanning fallback to have dispatched a go_back");

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "returned"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("the site closes the adopted tab itself, mid-journey: detected as an unexpected closure, and the run recovers on the parent tab", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask({
      startUrl: `${baseUrl}/surface-adopt-return-source.html`,
      successPattern: `${baseUrl}/surface-adopt-milestone.html`,
      limits: { maxSteps: 14, maxBacktracks: 3 },
    });
    const reasoning = new ScriptedReasoningProvider([
      byAccessibleName("Open Self-Closing Tab"),
      byAccessibleName("Continue After Return"),
    ]);

    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/surface-adopt-milestone.html`);

    // Never a go_back this engine dispatched -- the site closed the tab on its own.
    const goBackStep = response.steps.find((s) => s.selectedAction.type === "go_back");
    assert.equal(goBackStep, undefined, "expected no go_back to have been dispatched at all");

    const surfaceAdoption = response.diagnostics.surfaceAdoption;
    assert.ok(surfaceAdoption, "expected diagnostics.surfaceAdoption to be present");
    assert.ok(surfaceAdoption?.attempts.some((a) => a.event === "adopted"));
    assert.ok(
      surfaceAdoption?.attempts.some((a) => a.event === "closed_unexpectedly"),
      `expected a "closed_unexpectedly" event, got: ${JSON.stringify(surfaceAdoption?.attempts)}`,
    );
    assert.equal(surfaceAdoption?.returnAttempts, 0, "an unexpected closure is never counted as a return-to-parent attempt");

    const mainSteps = response.steps.filter((s) => s.observation.activeSurface?.kind === "main");
    assert.ok(mainSteps.some((s) => s.currentUrl === `${baseUrl}/surface-adopt-milestone.html`));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
