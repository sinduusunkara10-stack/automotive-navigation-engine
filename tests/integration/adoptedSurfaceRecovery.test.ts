import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { TaskResponse } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * A CTA that opens a new tab, which the engine adopts, followed by recovery on that tab:
 * - post-action milestones and the recovery anchor come from the adopted tab, not the opener;
 * - a low-confidence fallback on an adopted tab that already satisfied the latest milestone
 *   re-asks the reasoning layer on that tab instead of hopping back to the opener;
 * - a go_back from an adopted tab that satisfied nothing still returns to the opener, and
 *   the step's post-action work no longer touches the closed tab.
 */

type PageKind = "landing" | "brochure" | "form" | "summary" | "other";

function pageKind(url: string): PageKind {
  if (url.includes("adopted-recovery-landing")) return "landing";
  if (url.includes("adopted-recovery-brochure")) return "brochure";
  if (url.includes("adopted-recovery-form")) return "form";
  if (url.includes("adopted-recovery-summary")) return "summary";
  return "other";
}

class PageScriptedProvider implements ReasoningProvider {
  readonly calls: { kind: PageKind; action: string }[] = [];
  constructor(private readonly script: (kind: PageKind, callsOnKind: number, context: ReasoningContext) => Decision) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const kind = pageKind(context.observation.url);
    const callsOnKind = this.calls.filter((c) => c.kind === kind).length;
    const required = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const decision = required.every((id) => context.satisfiedCriteriaIds.includes(id))
      ? { action: { type: "stop_success" as const }, rationale: "All milestones satisfied." }
      : this.script(kind, callsOnKind, context);
    this.calls.push({ kind, action: decision.action.type });
    return decision;
  }
}

function clickByName(context: ReasoningContext, name: string): Decision {
  const target = context.observation.interactiveElements.find((el) => el.accessibleName.trim() === name);
  return target
    ? { action: { type: "click", target: target.id }, rationale: `Click "${name}".` }
    : { action: { type: "stop_failure" }, rationale: `"${name}" not found.` };
}

const LOW_CONFIDENCE: Decision = {
  action: { type: "stop_blocked" },
  rationale: "Confidence 0.4 below threshold.",
  fallbackReason: "low_confidence",
};

function task(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "adopted-surface-recovery-test",
    objective: "Campaign offer quote request.",
    startUrl: `${baseUrl}/adopted-recovery-landing.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "step-1",
        type: "semantic_page_match",
        description: "Quote request form",
        config: { minScore: 0.6 },
        required: true,
      },
      {
        id: "step-2",
        type: "url_pattern",
        description: "Request summary",
        config: { pattern: `${baseUrl}/adopted-recovery-summary.html` },
        required: true,
      },
    ],
    captureModules: ["page_visits"],
    limits: { maxSteps: 12, maxBacktracks: 3 },
    safety: {
      allowedActions: ["click", "scroll", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
    },
    outputSchemaVersion: "1.53.0",
  };
}

async function withRun(
  provider: PageScriptedProvider,
  assertions: (response: TaskResponse, baseUrl: string) => void,
): Promise<void> {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const response = await runTask({ page, task: task(baseUrl), reasoning: provider });
    assertions(response, baseUrl);
  } finally {
    await browser.close();
    await close();
  }
}

test("adopted tab that satisfied the latest milestone: a low-confidence fallback stays on it and the run continues there", async () => {
  const provider = new PageScriptedProvider((kind, callsOnKind, context) => {
    if (kind === "landing") return clickByName(context, "See offer details");
    if (kind === "form") {
      if (callsOnKind === 0) return { action: { type: "scroll", params: { deltaY: 600 } }, rationale: "Look further down." };
      if (callsOnKind === 1) return LOW_CONFIDENCE;
      return clickByName(context, "Continue to summary");
    }
    return { action: { type: "stop_failure" }, rationale: "Unexpected page." };
  });

  await withRun(provider, (response, baseUrl) => {
    assert.equal(response.status, "success", JSON.stringify(response.steps.map((s) => s.decision)));
    assert.equal(response.finalUrl, `${baseUrl}/adopted-recovery-summary.html`);

    const adoption = response.diagnostics.surfaceAdoption;
    assert.ok(adoption?.attempts.some((a) => a.event === "adopted"), "the form tab was adopted");
    assert.equal(adoption?.returnAttempts ?? 0, 0, "the run never left the adopted tab");
    assert.ok(!response.steps.some((s) => s.decision.includes("go_back")), "no go_back was dispatched");
    assert.equal(provider.calls.filter((c) => c.kind === "landing").length, 1, "never returned to the landing page");

    const formMilestone = response.diagnostics.milestoneEvidence?.find((m) => m.criterionId === "step-1");
    assert.equal(formMilestone?.stepIndex, 0, "satisfied by the click that opened the tab");
    assert.equal(formMilestone?.phase, "post_action");
    assert.equal(formMilestone?.pageUrl, `${baseUrl}/adopted-recovery-form.html`, "evaluated on the adopted tab, not the opener");

    const retry = response.diagnostics.recovery?.attempts.find((a) => a.anchorCriterionId === "step-1");
    assert.ok(retry, "milestone-anchored recovery handled the low-confidence fallback");
    assert.equal(retry.hopsAttempted, 0, "zero-hop: re-asked on the current tab");
    assert.equal(retry.restored, true);
    assert.ok(retry.targetFingerprint.includes("adopted-recovery-form.html"), "the anchor was recorded on the adopted tab");
  });
});

test("go_back from an adopted tab that satisfied no milestone returns to the opener without a closed-page crash", async () => {
  const provider = new PageScriptedProvider((kind, callsOnKind, context) => {
    if (kind === "landing") return clickByName(context, callsOnKind === 0 ? "Browse brochure" : "See offer details");
    if (kind === "brochure") return { action: { type: "go_back" }, rationale: "Not the quote form." };
    if (kind === "form") return clickByName(context, "Continue to summary");
    return { action: { type: "stop_failure" }, rationale: "Unexpected page." };
  });

  await withRun(provider, (response, baseUrl) => {
    assert.equal(response.status, "success", JSON.stringify(response.steps.map((s) => s.decision)));
    assert.equal(response.finalUrl, `${baseUrl}/adopted-recovery-summary.html`);

    const events = response.diagnostics.surfaceAdoption?.attempts.map((a) => a.event) ?? [];
    assert.ok(events.includes("returned"), "the brochure tab was left via surface return");
    assert.equal(events.filter((e) => e === "adopted").length, 2, "brochure, then the form, were adopted");

    const goBackStep = response.steps.find((s) => s.actionResult.resultingUrl === `${baseUrl}/adopted-recovery-landing.html`);
    assert.ok(goBackStep?.actionResult.success, "the go_back returned to the opener");

    const formMilestone = response.diagnostics.milestoneEvidence?.find((m) => m.criterionId === "step-1");
    assert.equal(formMilestone?.pageUrl, `${baseUrl}/adopted-recovery-form.html`);
  });
});
