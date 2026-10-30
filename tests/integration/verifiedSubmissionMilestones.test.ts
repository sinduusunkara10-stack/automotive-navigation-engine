import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { deriveVerifiedFormSubmission, isFormInteractionTarget } from "../../src/core/verifiedSubmission.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type {
  SemanticCriterionVerifier,
  SemanticVerificationInput,
  SemanticVerificationOutcome,
} from "../../src/reasoning/semanticCriterionVerifier.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { ActionResult, TaskResponse } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

// The live 2026-10-30 run: fill_form filled 6/6 required fields, passed readiness, pressed Submit once
// and observed an on-screen confirmation with the form removed -- yet milestones 2-4 ("fill out the
// details of the form", "submit the form", "stop and return") were never satisfied, because the
// semantic verifier saw only light-DOM page chrome and nothing of the fill_form result. The run kept
// exploring, clicked the confirmation's "modify" control, reopened the form and pressed Submit a
// second time (a second lead id). tests/fixtures/post-submit-journey.html reproduces that shape in
// light DOM and in an open shadow root; every scenario runs in both.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const DOMS = ["light", "shadow"] as const;

type Step = { action: "fill_form" } | { action: "click"; name: string } | { action: "stop_success" } | { action: "stop_blocked" };

class ScriptedReasoning implements ReasoningProvider {
  readonly contexts: ReasoningContext[] = [];
  private cursor = 0;
  constructor(private readonly script: Step[]) {}
  async decide(context: ReasoningContext): Promise<Decision> {
    this.contexts.push(context);
    const step = this.script[this.cursor] ?? { action: "stop_blocked" };
    this.cursor += 1;
    if (step.action === "click") {
      const target = context.observation.interactiveElements.find((e) => e.accessibleName === step.name);
      return target ? { action: { type: "click", target: target.id }, rationale: `click ${step.name}` } : { action: { type: "stop_blocked" }, rationale: `${step.name} not observed` };
    }
    return { action: { type: step.action }, rationale: step.action };
  }
}

// Stands in for the model with the rule the verifier prompt states: milestones 2-4 are satisfied only
// by the engine's own verified-submission record, never by the page chrome alone.
class RecordingVerifier implements SemanticCriterionVerifier {
  readonly inputs: SemanticVerificationInput[] = [];
  constructor(private readonly refuse: string[] = []) {}
  async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
    this.inputs.push(input);
    if (this.refuse.includes(input.criterionDescription)) return { satisfied: false, confidence: 0.9, evidence: "refused by the test" };
    if (input.criterionDescription === "load the above starturl") return { satisfied: true, confidence: 0.9, evidence: input.pageEvidence.title };
    const submission = input.verifiedFormSubmission;
    return submission && submission.confirmationSignals.length > 0
      ? { satisfied: true, confidence: 0.9, evidence: `verifiedFormSubmission ${submission.confirmationSignals.join(",")}` }
      : { satisfied: false, confidence: 0.9, evidence: "only page chrome is visible" };
  }
}

function task(baseUrl: string, query: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "verified-submission-milestones",
    objective: "1. load the above starturl\n2. fill out the details of the form\n3. submit the form\n4. stop and return",
    startUrl: `${baseUrl}/post-submit-journey.html?${query}`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "step-1", type: "semantic_page_match", description: "load the above starturl", config: { minScore: 2 } },
      { id: "step-2", type: "semantic_page_match", description: "fill out the details of the form", config: { minScore: 2 } },
      { id: "step-3", type: "semantic_page_match", description: "submit the form", config: { minScore: 2 } },
      { id: "step-4", type: "semantic_page_match", description: "stop and return", config: { minScore: 2 } },
    ],
    captureModules: [],
    limits: { maxSteps: 6, maxBacktracks: 2, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "fill_form", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    outputSchemaVersion: "1.53.0",
  };
}

interface Journey {
  result: TaskResponse;
  reasoning: ScriptedReasoning;
  verifier: RecordingVerifier;
  leadPosts: number;
  submitEvents: number;
  formVisible: boolean;
}

async function runJourney(query: string, script: Step[], refuse: string[] = []): Promise<Journey> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const reasoning = new ScriptedReasoning(script);
    const verifier = new RecordingVerifier(refuse);
    const result = await runTask({ page, task: task(baseUrl, query), reasoning, semanticVerifier: verifier });
    const counters = await page.evaluate(() => {
      const w = window as unknown as { __leadPosts: unknown[]; __submitEvents: number };
      const app = document.querySelector("journey-lead-app");
      const form = (app?.shadowRoot ?? app)?.querySelector("form") as HTMLFormElement | null;
      return { leadPosts: w.__leadPosts?.length ?? -1, submitEvents: w.__submitEvents ?? -1, formVisible: Boolean(form && !form.hidden) };
    });
    return { result, reasoning, verifier, ...counters };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

function satisfied(result: TaskResponse): string[] {
  return [...(result.steps.at(-1)?.progress?.satisfiedCriteriaIds ?? [])].sort();
}

function fillResult(result: TaskResponse): ActionResult {
  const step = result.steps.find((s) => s.selectedAction.type === "fill_form");
  assert.ok(step, "fill_form was dispatched");
  return step.actionResult;
}

function context(journey: Journey): string {
  return JSON.stringify({
    status: journey.result.status,
    finish: journey.result.diagnostics?.finishReason,
    steps: journey.result.steps.map((s) => ({ action: s.selectedAction.type, flags: s.safetyFlags, outcome: s.actionResult.formFillOutcome })),
    satisfied: satisfied(journey.result),
    verifier: journey.verifier.inputs.map((i) => ({ criterion: i.criterionDescription, submission: i.verifiedFormSubmission?.confirmationSignals })),
    posts: journey.leadPosts,
  });
}

const POST_CONFIRMATION_SCRIPT: Step[] = [{ action: "fill_form" }, { action: "click", name: "Modify my details" }, { action: "click", name: "Send request" }, { action: "fill_form" }];

for (const dom of DOMS) {
  test(`${dom}: a confirmed submission satisfies fill, submit and stop milestones and the engine stops at once`, async () => {
    const journey = await runJourney(`dom=${dom}`, POST_CONFIRMATION_SCRIPT);
    const { result } = journey;
    const ctx = context(journey);
    assert.equal(result.status, "success", ctx);
    assert.equal(result.diagnostics?.finishReason, "objective_complete_after_verified_submission", ctx);
    assert.deepEqual(satisfied(result), ["step-1", "step-2", "step-3", "step-4"], ctx);
    assert.equal(journey.reasoning.contexts.length, 1, `no reasoning call after the confirmed submission: ${ctx}`);
    assert.deepEqual(result.steps.map((s) => s.selectedAction.type), ["fill_form"], ctx);
    assert.equal(journey.leadPosts, 1, ctx);
    assert.equal(journey.submitEvents, 1, ctx);
    assert.equal(journey.formVisible, false, "the modify control was never clicked, so the form stays closed");

    const fill = fillResult(result);
    assert.equal(fill.formFillOutcome, "submitted");
    assert.equal(fill.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");
    assert.ok(fill.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals.some((sig) => sig !== "virtual_page_success_event"), ctx);
    assert.equal(fill.formPostSubmitDiagnostics?.postSubmitObservation?.formStillPresentAtEnd, false);

    const forwarded = journey.verifier.inputs.filter((i) => i.verifiedFormSubmission);
    assert.deepEqual(forwarded.map((i) => i.criterionDescription), ["fill out the details of the form", "submit the form", "stop and return"], ctx);
    for (const input of forwarded) {
      const s = input.verifiedFormSubmission;
      assert.ok(s);
      assert.equal(s.requiredFieldsFilled, s.requiredFieldsDetected);
      assert.equal(s.preSubmitReadinessPassed, true);
      assert.equal(s.submitAttempts, 1);
      assert.ok(s.confirmationSignals.length > 0);
      assert.equal(s.formStillPresentAfterSubmit, false);
      assert.ok(!(s.confirmationSignals as string[]).includes("virtual_page_success_event"));
    }
    const evidence = result.diagnostics?.milestoneEvidence ?? [];
    for (const id of ["step-2", "step-3", "step-4"]) {
      const record = evidence.find((r) => r.criterionId === id);
      assert.ok(record, `${id} has milestone evidence`);
      assert.equal(record.phase, "post_action");
      assert.match(record.reason, /verified form submission from step 0 was forwarded: \d+\/\d+ required fields, 1 Submit, [a-z_+]+\]/);
    }

    const schemaValidation = await validateAgainstTaskResponseSchema(result);
    assert.ok(schemaValidation.valid, schemaValidation.errorsText);
  });

  test(`${dom}: after a confirmed submission with a milestone still unmet, Submit and fill_form are refused and the lead is sent once`, async () => {
    const journey = await runJourney(`dom=${dom}`, POST_CONFIRMATION_SCRIPT, ["stop and return"]);
    const { result } = journey;
    const ctx = context(journey);
    assert.notEqual(result.status, "success", ctx);
    assert.equal(result.diagnostics?.finishReason, "duplicate_submission_prevented", ctx);
    assert.ok(result.steps.some((s) => s.safetyFlags?.includes("duplicate_submission_prevented")), ctx);
    assert.equal(result.steps.filter((s) => s.selectedAction.type === "fill_form").length, 1, ctx);
    assert.equal(journey.leadPosts, 1, ctx);
    assert.equal(journey.submitEvents, 1, ctx);
    assert.ok(!result.steps.some((s) => s.selectedAction.type === "go_back"), `no replanning after the submission: ${ctx}`);
    assert.deepEqual(result.diagnostics?.missingRequiredCriteriaIds, ["step-4"], ctx);
  });

  test(`${dom}: an explicit fill_form after a confirmed submission is refused without touching the page`, async () => {
    const journey = await runJourney(`dom=${dom}`, [{ action: "fill_form" }, { action: "fill_form" }], ["stop and return"]);
    const ctx = context(journey);
    assert.equal(journey.result.diagnostics?.finishReason, "duplicate_submission_prevented", ctx);
    assert.equal(journey.leadPosts, 1, ctx);
    assert.equal(journey.submitEvents, 1, ctx);
  });

  for (const scenario of ["reject", "unconfirmed", "analytics_only"] as const) {
    test(`${dom}: ${scenario} -- no verified submission, so fill and submit milestones stay unmet and the run is not a success`, async () => {
      const journey = await runJourney(`dom=${dom}&scenario=${scenario}`, [{ action: "fill_form" }, { action: "stop_success" }, { action: "stop_success" }]);
      const { result } = journey;
      const ctx = context(journey);
      assert.notEqual(result.status, "success", ctx);
      assert.deepEqual(satisfied(result), ["step-1"], ctx);
      assert.ok(journey.verifier.inputs.every((i) => i.verifiedFormSubmission === undefined), ctx);
      assert.notEqual(result.diagnostics?.finishReason, "objective_complete_after_verified_submission", ctx);
      const fill = fillResult(result);
      if (scenario === "reject") {
        assert.notEqual(fill.formFillOutcome, "submitted", ctx);
        assert.equal(journey.leadPosts, 0, ctx);
      }
      if (scenario === "unconfirmed") {
        assert.notEqual(fill.formPostSubmitDiagnostics?.submissionOutcome, "succeeded", ctx);
      }
      if (scenario === "analytics_only") {
        const signals = fill.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals ?? [];
        assert.ok(signals.includes("virtual_page_success_event"), `the analytics event was seen: ${JSON.stringify(signals)}`);
        assert.ok(!signals.some((s) => s !== "virtual_page_success_event"), `analytics was the only signal: ${JSON.stringify(signals)}`);
        assert.equal(deriveVerifiedFormSubmission(fill, 0), undefined);
      }
      const schemaValidation = await validateAgainstTaskResponseSchema(result);
      assert.ok(schemaValidation.valid, schemaValidation.errorsText);
    });
  }

  test(`${dom}: form-interaction targets are recognised in their own tree; the confirmation's modify control and page chrome are not`, async () => {
    const { baseUrl, close } = await startStaticServer(fixturesDir);
    const browser = await chromium.launch();
    const page: Page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/post-submit-journey.html?dom=${dom}`);
      await page.evaluate(() => {
        const app = document.querySelector("journey-lead-app");
        const root = (app?.shadowRoot ?? app) as ParentNode;
        (root.querySelector("#done") as HTMLElement).hidden = false;
        const helper = document.createElement("button");
        helper.type = "button";
        helper.textContent = "Privacy details";
        root.querySelector("form")?.appendChild(helper);
      });
      const observation = await buildObservation(page);
      const id = (name: string) => {
        const el = observation.interactiveElements.find((e) => e.accessibleName === name);
        assert.ok(el, `${name} observed`);
        return el.id;
      };
      assert.equal(await isFormInteractionTarget(page, id("Send request")), true);
      assert.equal(await isFormInteractionTarget(page, id("Privacy details")), true);
      assert.equal(await isFormInteractionTarget(page, id("Modify my details")), false);
      assert.equal(await isFormInteractionTarget(page, id("Models")), false);
    } finally {
      await page.close();
      await browser.close();
      await close();
    }
  });
}
