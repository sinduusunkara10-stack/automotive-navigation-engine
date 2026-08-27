import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Engine-level coverage that stop_success is only ever honoured once every *required*
 * success criterion is actually satisfied (src/core/loop.ts), independent of whatever the
 * reasoning provider itself decided to propose -- see CLAUDE.md and
 * docs/n8n-integration.md "How `required` (and `successCriteria` generally) actually gates
 * stop_success" for the contract this enforces. Every provider below is a small
 * deterministic fake (never a real model call), matching the pattern already used in
 * tests/integration/actionExecutionConsistency.test.ts.
 */

function clickByName(context: ReasoningContext, name: string): Decision | undefined {
  const clicked = new Set(
    context.recentActions.filter((a) => a.type === "click" && a.target).map((a) => a.target as string),
  );
  const candidate = context.observation.interactiveElements.find(
    (el) => el.visible !== false && !clicked.has(el.id) && new RegExp(name, "i").test(el.accessibleName),
  );
  if (!candidate || !context.allowedActions.includes("click")) {
    return undefined;
  }
  return { action: { type: "click", target: candidate.id }, rationale: `Click "${candidate.accessibleName}".` };
}

/**
 * Always proposes stop_success, every single call, regardless of what has (or hasn't) been
 * satisfied -- exercises the engine's own gate directly rather than relying on a
 * well-behaved provider to self-gate (which is all `required` did before this change; see
 * MockReasoningProvider for the "well-behaved" comparison).
 */
class AlwaysStopSuccessProvider implements ReasoningProvider {
  async decide(): Promise<Decision> {
    return { action: { type: "stop_success" }, rationale: "Always proposes stop_success." };
  }
}

/**
 * Attempts stop_success once, immediately, before ever satisfying anything -- then, once
 * that first attempt has been rejected, clicks through the fixture journey normally and
 * retries stop_success once every required criterion is actually satisfied.
 */
class PrematureThenEventualStopSuccessProvider implements ReasoningProvider {
  private attemptedPrematureStop = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.attemptedPrematureStop) {
      this.attemptedPrematureStop = true;
      return { action: { type: "stop_success" }, rationale: "Premature stop_success attempt." };
    }

    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allRequiredSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allRequiredSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Required criteria now satisfied." };
    }

    const click = clickByName(context, "continue");
    if (click) {
      return click;
    }
    return { action: { type: "stop_failure" }, rationale: "No permitted action available." };
  }
}

/** Clicks "Continue" until every required criterion is satisfied, then stops. */
class ClickThroughUntilSatisfiedProvider implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allRequiredSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allRequiredSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Required criteria satisfied." };
    }
    const click = clickByName(context, "continue");
    if (click) {
      return click;
    }
    return { action: { type: "stop_failure" }, rationale: "No permitted action available." };
  }
}

/**
 * Clicks "Continue" exactly once (reaching a page where one required criterion becomes
 * satisfied), then proposes stop_success on every subsequent call and never navigates
 * further -- so a second required criterion (gated on a *later* page) stays unsatisfied
 * for the rest of the run. Models a reasoning decision made on genuinely mixed evidence:
 * one required signal true, another required signal still false.
 */
class ClickOnceThenAlwaysStopSuccessProvider implements ReasoningProvider {
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      this.clicked = true;
      const click = clickByName(context, "continue");
      if (click) {
        return click;
      }
    }
    return { action: { type: "stop_success" }, rationale: "Proposing stop_success on partial evidence." };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.2.0",
    taskId: "required-success-criteria-enforcement",
    objective: "Reach the fixture's success page.",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors"],
    limits: { maxSteps: 6, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.2.0",
    ...overrides,
  };
}

test("stop_success is accepted once every required criterion (multiple) is satisfied", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "reached-success-url",
          type: "url_pattern",
          description: "Current page is the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
          required: true,
        },
        {
          id: "success-marker-present",
          type: "element_present",
          description: "The success marker element is present.",
          config: { selector: '[data-testid="success-marker"]' },
          required: true,
        },
      ],
    });

    const response = await runTask({ page, task, reasoning: new ClickThroughUntilSatisfiedProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.diagnostics.finishReason, "stop_success_action");
    assert.equal(response.diagnostics.missingRequiredCriteriaIds, undefined);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("reached-success-url"));
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("success-marker-present"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("stop_success is rejected while one required criterion is still missing, then accepted once it's satisfied", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "reached-success-url",
          type: "url_pattern",
          description: "Current page is the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
          required: true,
        },
      ],
    });

    const response = await runTask({ page, task, reasoning: new PrematureThenEventualStopSuccessProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.diagnostics.finishReason, "stop_success_action");
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const stopSuccessAttempts = response.steps.filter((s) => s.selectedAction.type === "stop_success");
    assert.equal(stopSuccessAttempts.length, 2, "expected one rejected attempt and one accepted attempt");

    const rejected = stopSuccessAttempts[0];
    const accepted = stopSuccessAttempts[1];
    assert.ok(rejected?.safetyFlags?.includes("required_criteria_unsatisfied"));
    assert.ok(!accepted?.safetyFlags?.includes("required_criteria_unsatisfied"));
    assert.equal(rejected?.stepIndex !== response.steps.length - 1, true, "a rejected stop_success must not be the run's final step");
    assert.equal(response.steps[response.steps.length - 1]?.selectedAction.type, "stop_success");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a missing optional criterion never blocks stop_success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "reached-success-url",
          type: "url_pattern",
          description: "Current page is the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
          required: true,
        },
        {
          id: "optional-never-present",
          type: "element_present",
          description: "An element that never appears on any fixture page.",
          config: { selector: "[data-testid=\"this-never-exists\"]" },
          required: false,
        },
      ],
    });

    const response = await runTask({ page, task, reasoning: new ClickThroughUntilSatisfiedProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.ok(!response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("optional-never-present"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a task with no required criteria accepts stop_success unconditionally, matching pre-enforcement behaviour", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "optional-only",
          type: "url_pattern",
          description: "Never actually reached -- this task has no required criteria at all.",
          config: { pattern: `${baseUrl}/never-visited.html` },
          required: false,
        },
      ],
    });

    // Proposes stop_success on the very first decision, on start.html, with nothing satisfied.
    const response = await runTask({ page, task, reasoning: new AlwaysStopSuccessProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.steps.length, 1, "expected the very first stop_success proposal to be accepted");
    assert.equal(response.diagnostics.missingRequiredCriteriaIds, undefined);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.deepEqual(response.engineAssessment.satisfiedSuccessCriteriaIds, []);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

/**
 * Never proposes stop_success at all -- always waits instead. Used specifically to
 * exercise genuine maxSteps exhaustion as distinct from the no-progress stall detector
 * below (which only ever triggers on two consecutive *stop_success* proposals with
 * identical evidence).
 */
class AlwaysWaitProvider implements ReasoningProvider {
  async decide(): Promise<Decision> {
    return { action: { type: "wait", params: { durationMs: 1 } }, rationale: "Never proposes stop_success." };
  }
}

test("the run's step limit is reached before required criteria are met, when the reasoning layer never even proposes stop_success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page this run never navigates to.",
          config: { pattern: `${baseUrl}/never-visited.html` },
          required: true,
        },
      ],
      limits: { maxSteps: 2, maxBacktracks: 0, maxRepeatedActions: 10 },
      safety: {
        allowedActions: ["wait", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
    });

    const response = await runTask({ page, task, reasoning: new AlwaysWaitProvider() });

    assert.equal(response.status, "max_steps_reached");
    assert.equal(response.diagnostics.finishReason, "max_steps");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.deepEqual(response.diagnostics.missingRequiredCriteriaIds, ["unreachable"]);
    assert.ok(
      response.steps.slice(0, -1).every((s) => s.selectedAction.type === "wait"),
      "no stop_success was ever proposed in this scenario",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// No-progress termination (generic, criterion-type-agnostic staleness guard in
// src/core/loop.ts): two consecutive rejected stop_success proposals carrying the exact
// same evidence fingerprint (page URL + satisfied + missing required criteria) end the
// run deterministically, rather than waiting for maxSteps or the generic repeated-action
// guard several steps later. See docs/n8n-integration.md "Repeated-decision and cost
// control" for the full rationale and cost comparison.
// ---------------------------------------------------------------------------------------

test("no-progress termination stops repeated identical stop_success rejections without waiting for maxSteps or the repeated-action guard", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page this run never navigates to.",
          config: { pattern: `${baseUrl}/never-visited.html` },
          required: true,
        },
      ],
      // Generous limits that a genuine maxSteps/repeated-action stop would take many more
      // calls to reach -- proving the no-progress guard is what actually ends this run.
      limits: { maxSteps: 50, maxBacktracks: 0, maxRepeatedActions: 50 },
    });

    const response = await runTask({ page, task, reasoning: new AlwaysStopSuccessProvider() });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "no_progress_required_criteria_unmet");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.deepEqual(response.diagnostics.missingRequiredCriteriaIds, ["unreachable"]);
    // Exactly two stop_success proposals total: one rejection (first time this evidence
    // was seen) and a second, identical rejection that immediately ends the run -- not
    // the 50 steps the configured limits would otherwise allow.
    assert.equal(response.steps.length, 2);
    assert.ok(response.steps.every((s) => s.selectedAction.type === "stop_success"));
    assert.ok(response.steps[0]?.safetyFlags?.includes("required_criteria_unsatisfied"));
    assert.ok(!response.steps[0]?.safetyFlags?.includes("no_progress_detected"));
    assert.ok(response.steps[1]?.safetyFlags?.includes("no_progress_detected"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

/**
 * Proposes stop_success prematurely twice, but the two rejections carry genuinely
 * different evidence (the second happens only once the run has advanced to a page where
 * one of the two required criteria has newly become satisfied) -- then clicks through to
 * a real success once both are satisfied.
 */
class TwoDifferentRejectionsThenSuccessProvider implements ReasoningProvider {
  private attemptedFirstStop = false;
  private attemptedSecondStop = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All required criteria now satisfied." };
    }
    if (!this.attemptedFirstStop) {
      this.attemptedFirstStop = true;
      return { action: { type: "stop_success" }, rationale: "Premature attempt #1: nothing satisfied yet." };
    }
    if (!this.attemptedSecondStop && context.satisfiedCriteriaIds.length > 0) {
      this.attemptedSecondStop = true;
      return { action: { type: "stop_success" }, rationale: "Premature attempt #2: different (partial) evidence." };
    }
    const click = clickByName(context, "continue");
    if (click) {
      return click;
    }
    return { action: { type: "stop_failure" }, rationale: "No permitted action available." };
  }
}

test("changed evidence between two rejected stop_success proposals is never treated as no-progress", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      objective: "Reach the fixture's success page.",
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          id: "step-two-marker-present",
          type: "element_present",
          description: "The step-two 'learn more' control is present.",
          config: { selector: "#learn-more" },
          required: true,
        },
        {
          id: "reached-success-url",
          type: "url_pattern",
          description: "Current page is the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
          required: true,
        },
      ],
    });

    const response = await runTask({ page, task, reasoning: new TwoDifferentRejectionsThenSuccessProvider() });

    assert.equal(response.status, "success");
    assert.equal(response.diagnostics.finishReason, "stop_success_action");
    assert.equal(response.diagnostics.missingRequiredCriteriaIds, undefined);

    const rejectedSteps = response.steps.filter((s) => s.safetyFlags?.includes("required_criteria_unsatisfied"));
    assert.equal(rejectedSteps.length, 2, "expected exactly two distinct rejected stop_success proposals");
    assert.ok(
      rejectedSteps.every((s) => !s.safetyFlags?.includes("no_progress_detected")),
      "two rejections with genuinely different evidence must never be treated as no-progress",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("conflicting evidence: one satisfied required criterion alongside one unsatisfied required criterion does not allow stop_success", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      objective: "Reach Step Two and continue toward the success page.",
      startUrl: `${baseUrl}/start.html`,
      successCriteria: [
        {
          // Quotes step2.html's own h1/button text, so this is satisfied as soon as the
          // run reaches step2.html -- genuine positive evidence, well before the journey
          // is actually done.
          id: "reached-step-two",
          type: "semantic_page_match",
          description: "Step Two page is reached, with a button to learn more about this step.",
          config: { minScore: 0.3 },
          required: true,
        },
        {
          id: "on-success-url",
          type: "url_pattern",
          description: "Current page is the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
          required: true,
        },
      ],
      limits: { maxSteps: 4, maxBacktracks: 0, maxRepeatedActions: 10 },
    });

    const response = await runTask({ page, task, reasoning: new ClickOnceThenAlwaysStopSuccessProvider() });

    assert.equal(response.finalUrl, `${baseUrl}/step2.html`, "the provider never clicks past step2.html");
    assert.notEqual(
      response.status,
      "success",
      "one satisfied required criterion alongside one unsatisfied required criterion must not be treated as success",
    );
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.ok(response.diagnostics.missingRequiredCriteriaIds?.includes("on-success-url"));
    assert.ok(!response.diagnostics.missingRequiredCriteriaIds?.includes("reached-step-two"));
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("reached-step-two"));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
