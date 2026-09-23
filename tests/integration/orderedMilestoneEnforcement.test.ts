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
 * End-to-end coverage for ordered required-milestone enforcement (docs/n8n-integration.md
 * §9f) through the real engine loop, using the five-milestone fixture chain
 * (tests/fixtures/milestone-*.html) that reproduces the reported false-success bug's shape:
 * a homepage whose own persistent navigation (present, identically, on every page) already
 * names every downstream destination -- an Offers section, a specific model's offer, and a
 * Request a Quote flow -- while none of those destinations has actually been reached.
 * Placeholder brand/model naming ("Example Motors" / "Voyager Crossover") is used
 * throughout per CLAUDE.md's "Secrets" policy against committing real brand/dealer content;
 * the structure is otherwise identical to the reported production run.
 */

const ORDERED_MILESTONE_CRITERIA: TaskRequest["successCriteria"] = [
  {
    id: "step-1",
    type: "semantic_page_match",
    description: "Welcome to Example Motors homepage is shown.",
    config: { minScore: 0.4 },
    required: true,
  },
  {
    id: "step-2",
    type: "semantic_page_match",
    description: "Current offers are shown.",
    config: { minScore: 0.4 },
    required: true,
  },
  {
    id: "step-3",
    type: "semantic_page_match",
    description: "Voyager Crossover offer selected.",
    config: { minScore: 0.4 },
    required: true,
  },
  {
    id: "step-4",
    type: "semantic_page_match",
    description: "Request a personalised quote action found for this offer.",
    config: { minScore: 0.4 },
    required: true,
  },
  {
    id: "step-5",
    type: "semantic_page_match",
    description: "Request a Quote form fields are displayed for completion.",
    config: { minScore: 0.4 },
    required: true,
  },
];

function baseTask(
  overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl">,
): TaskRequest {
  return {
    schemaVersion: "1.23.0",
    taskId: "ordered-milestone-enforcement",
    objective: "",
    allowedDomains: ["127.0.0.1"],
    successCriteria: ORDERED_MILESTONE_CRITERIA,
    captureModules: ["errors"],
    limits: { maxSteps: 12, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.24.0",
    ...overrides,
  };
}

/**
 * Clicks through a fixed script of accessible-name patterns, one per step, then proposes
 * stop_success once every required criterion is satisfied -- never proposes stop_success
 * prematurely (unlike AlwaysStopSuccessProvider elsewhere in this suite), so this provider is
 * only useful for the "reaches the end" tests; the premature-stop_success test below uses its
 * own dedicated provider.
 */
type ScriptedStep = { type: "click"; pattern: RegExp } | { type: "go_back" };

class ScriptedActionsProvider implements ReasoningProvider {
  private index = 0;
  constructor(private readonly script: readonly ScriptedStep[]) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allRequiredSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allRequiredSatisfied && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All required milestones satisfied, in order." };
    }
    if (this.index < this.script.length) {
      const step = this.script[this.index];
      this.index += 1;
      if (step?.type === "go_back") {
        return { action: { type: "go_back" }, rationale: "Scripted go_back." };
      }
      const pattern = step?.type === "click" ? step.pattern : undefined;
      if (pattern) {
        const candidate = context.observation.interactiveElements.find(
          (el) => el.visible !== false && pattern.test(el.accessibleName),
        );
        if (candidate) {
          return { action: { type: "click", target: candidate.id }, rationale: `Click matching ${pattern}.` };
        }
      }
    }
    return { action: { type: "stop_failure" }, rationale: "Script exhausted with no matching control." };
  }
}

/** Always proposes stop_success immediately, on whatever page it is first called on. */
class AlwaysStopSuccessProvider implements ReasoningProvider {
  async decide(): Promise<Decision> {
    return { action: { type: "stop_success" }, rationale: "Always proposes stop_success." };
  }
}

const CLICK_THROUGH_SCRIPT: ScriptedStep[] = [
  { type: "click", pattern: /^Offers$/i },
  { type: "click", pattern: /See this offer/i },
  { type: "click", pattern: /Request a personalised quote/i },
  { type: "click", pattern: /Open the quote form/i },
];

test("REGRESSION (reproduces the reported Nissan UK homepage false-success bug's shape): a valid five-step journey reaches 5/5 milestones strictly in order", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/milestone-start.html` });
    const response = await runTask({ page, task, reasoning: new ScriptedActionsProvider(CLICK_THROUGH_SCRIPT) });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.deepEqual(
      [...(response.engineAssessment.satisfiedSuccessCriteriaIds ?? [])].sort(),
      ["step-1", "step-2", "step-3", "step-4", "step-5"],
    );

    // Ordering was actually respected throughout the run, not just at the end: a later
    // step id never appears in progress.satisfiedCriteriaIds before every earlier one does.
    const order = ["step-1", "step-2", "step-3", "step-4", "step-5"];
    for (const step of response.steps) {
      const satisfied = new Set(step.progress.satisfiedCriteriaIds);
      let sawUnsatisfied = false;
      for (const id of order) {
        if (satisfied.has(id)) {
          assert.ok(
            !sawUnsatisfied,
            `step ${step.stepIndex}: "${id}" satisfied while an earlier milestone was still outstanding`,
          );
        } else {
          sawUnsatisfied = true;
        }
      }
    }

    // diagnostics.milestoneEvidence: one record per criterion, in declaration order, each
    // explaining why it was judged satisfied.
    const evidence = response.diagnostics.milestoneEvidence ?? [];
    assert.deepEqual(evidence.map((e) => e.criterionId), ["step-1", "step-2", "step-3", "step-4", "step-5"]);
    for (const record of evidence) {
      assert.equal(record.criterionType, "semantic_page_match");
      assert.ok(["pre_action", "post_action"].includes(record.phase));
      assert.ok(record.pageUrl.length > 0);
      assert.ok(record.reason.length > 0);
      assert.ok(typeof record.score === "number");
      // PR 1D (truthful milestone evaluation): every one of these five milestones is a
      // semantic_page_match criterion, so every evidenceTier must be "inferred" -- never
      // "assumed", and never misclassified as "observed" (no mechanical DOM/URL/event read
      // was ever involved in satisfying any of them).
      assert.equal(record.evidenceTier, "inferred");
    }

    // engineAssessment.evidenceTierSummary: a real end-to-end rollup, not just the per-
    // record classification above -- confirms the five inferred milestones are correctly
    // tallied, and that assumedCount is genuinely 0 on a real, full engine run.
    assert.deepEqual(response.engineAssessment.evidenceTierSummary, {
      observedCount: 0,
      inferredCount: 5,
      assumedCount: 0,
    });
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: stop_success is rejected on the homepage alone -- the homepage's own nav (Offers/model/Request a Quote links) must not satisfy steps 2-5, and only step-1 may complete", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/milestone-start.html`,
      limits: { maxSteps: 50, maxBacktracks: 0, maxRepeatedActions: 50 },
    });
    // Proposes stop_success immediately, on the homepage, before any navigation --
    // reproduces the exact reported scenario: stepCount 1, only action stop_success, zero
    // CTA clicks.
    const response = await runTask({ page, task, reasoning: new AlwaysStopSuccessProvider() });

    assert.notEqual(response.status, "success", "stop_success must not be honoured from the homepage alone");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.deepEqual(response.engineAssessment.satisfiedSuccessCriteriaIds, ["step-1"]);
    assert.deepEqual(
      [...(response.diagnostics.missingRequiredCriteriaIds ?? [])].sort(),
      ["step-2", "step-3", "step-4", "step-5"],
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("completed milestones survive go_back: navigating back to the homepage and forward again never re-blocks or drops an already-satisfied milestone", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/milestone-start.html`,
      limits: { maxSteps: 15, maxBacktracks: 3, maxRepeatedActions: 5 },
      safety: {
        allowedActions: ["click", "go_back", "wait", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
    });
    const script: ScriptedStep[] = [
      { type: "click", pattern: /^Offers$/i }, // reach offers.html -> step-2 satisfied
      { type: "go_back" }, // back to the homepage -- step-2 must remain satisfied
      { type: "click", pattern: /^Voyager Crossover$/i }, // a different route forward this time
      { type: "click", pattern: /Request a personalised quote/i },
      { type: "click", pattern: /Open the quote form/i },
    ];
    const response = await runTask({ page, task, reasoning: new ScriptedActionsProvider(script) });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);

    const step2StepIndex = response.steps.findIndex((s) => s.progress.satisfiedCriteriaIds.includes("step-2"));
    assert.ok(step2StepIndex >= 0, "step-2 must become satisfied at some step");
    for (const step of response.steps.slice(step2StepIndex)) {
      assert.ok(
        step.progress.satisfiedCriteriaIds.includes("step-2"),
        `step-2 must remain satisfied at step ${step.stepIndex}, including after go_back and re-navigating forward`,
      );
    }
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
