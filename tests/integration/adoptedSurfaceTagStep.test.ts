import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * A CTA opens the form in a new tab, which the engine adopts. A dataLayer push the form fires
 * on a later step (its scroll listener; the scroll event can land just after the step counter
 * advances, hence step 1 or 2) must carry that later step, not the step of the click that opened the tab,
 * and its reporting row must belong to the adopted tab, not to the start page.
 */

function clickByName(context: ReasoningContext, name: string): Decision {
  const target = context.observation.interactiveElements.find((el) => el.accessibleName.trim() === name);
  return target
    ? { action: { type: "click", target: target.id }, rationale: `Click "${name}".` }
    : { action: { type: "stop_failure" }, rationale: `"${name}" not found.` };
}

class ScriptedProvider implements ReasoningProvider {
  private formCalls = 0;
  async decide(context: ReasoningContext): Promise<Decision> {
    if (context.satisfiedCriteriaIds.includes("summary")) {
      return { action: { type: "stop_success" }, rationale: "Done." };
    }
    const url = context.observation.url;
    if (url.includes("tag-step-landing")) return clickByName(context, "Request a quote");
    if (url.includes("tag-step-form")) {
      const call = this.formCalls++;
      if (call === 0) return { action: { type: "scroll", params: { deltaY: 600 } }, rationale: "Look further down." };
      if (call === 1) return { action: { type: "wait", params: { durationMs: 500 } }, rationale: "Let the page settle." };
      return clickByName(context, "Continue to summary");
    }
    return { action: { type: "stop_failure" }, rationale: "Unexpected page." };
  }
}

function task(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.52.0",
    taskId: "adopted-surface-tag-step-test",
    objective: "Quote request.",
    startUrl: `${baseUrl}/tag-step-landing.html`,
    allowedDomains: ["127.0.0.1", "localhost"],
    successCriteria: [
      {
        id: "summary",
        type: "url_pattern",
        description: "Request summary",
        config: { pattern: `${baseUrl.replace("127.0.0.1", "localhost")}/tag-step-summary.html` },
        required: true,
      },
    ],
    captureModules: ["page_visits", "cta_clicks", "data_layer_evidence", "ga4_network_events"],
    limits: { maxSteps: 8, maxBacktracks: 1 },
    safety: {
      allowedActions: ["click", "scroll", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
    },
    outputSchemaVersion: "1.54.0",
  };
}

test("new-tab CTA: a later form event carries the form step and reports under the adopted tab, not :start", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const response = await runTask({ page, task: task(baseUrl), reasoning: new ScriptedProvider() });
    assert.equal(response.status, "success", JSON.stringify(response.steps.map((s) => s.decision)));
    assert.ok(response.diagnostics.surfaceAdoption?.attempts.some((a) => a.event === "adopted"), "the form tab was adopted");
    assert.deepEqual(response.steps.map((s) => s.selectedAction.type).slice(0, 4), ["click", "scroll", "wait", "click"]);

    const isFormScrolled = (raw: unknown[]) => raw.some((entry) => (entry as { event?: string })?.event === "form_scrolled");
    const formEntries = (response.captures.data_layer_evidence ?? []).filter((entry) => isFormScrolled(entry.raw as unknown[]));
    assert.ok(formEntries.length > 0, "the form's dataLayer push was captured");
    const steps = JSON.stringify(formEntries.map((entry) => entry.stepIndex));
    assert.ok(formEntries.every((entry) => entry.stepIndex >= 1), `never the step of the click that opened the tab: ${steps}`);
    assert.ok(formEntries.some((entry) => entry.stepIndex === 1 || entry.stepIndex === 2), `stamped with a form step: ${steps}`);

    const taskId = "adopted-surface-tag-step-test";
    const formRows = response.analyticsReportingRows.filter(
      (row) => row.recordType === "ANALYTICS_EVENT" && JSON.stringify(row).includes("form_scrolled"),
    );
    assert.ok(formRows.length > 0, "the form event produced a reporting row");
    assert.ok(formRows.every((row) => row.actionId === `${taskId}:action:0`), JSON.stringify(formRows.map((r) => r.actionId)));
    assert.ok(!formRows.some((row) => row.actionId === `${taskId}:start`));

    const adoptedMarker = response.analyticsReportingRows.find(
      (row) => row.recordType === "PAGE_VISIT" && row.actionId === `${taskId}:action:0`,
    );
    assert.ok(adoptedMarker?.sourcePageUrl?.includes("localhost"), "a page marker for the adopted tab");
    assert.ok(adoptedMarker!.sourcePageUrl!.endsWith("/tag-step-form.html"));

    const openingClick = response.captures.cta_clicks?.find((click) => click.stepIndex === 0);
    assert.equal(openingClick?.resultingTitle, "Quote request form", "resultingTitle read from the adopted tab, not the opener");
  } finally {
    await browser.close();
    await close();
  }
});
