import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { runTask } from "../../src/core/engine.js";
import type { FormJourneyContext } from "../../src/forms/formRelevance.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { ActionResult, FormScoringEvidence } from "../../src/types/task-response.js";
import { FakeReasoningModelClient, resultStep } from "../unit/fakes/fakeReasoningModelClient.js";
import { FIXTURE_DOM_MODE_ENV, OPEN_SHADOW_MODE } from "../helpers/openShadowFixture.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

// Form-selection scoring must see the same inputs for a form in the light DOM and the same form
// inside an open shadow root (tests/fixtures/form-scoring-parity.html renders either), and must not
// be skewed by hidden backing inputs, disabled sections or an in-form search submit control.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const DOMS = ["light", "shadow"] as const;

/** A task written as English step instructions, run directly on its start URL (no CTA was clicked). */
const ENGLISH_STEPS: FormJourneyContext = {
  objective: "1. load the above start url\n2. fill out the details of the form\n3. submit the form\n4. stop and return",
  activeMilestoneTexts: ["fill out the details of the form", "submit the form", "stop and return"],
};

interface Outcome {
  result: ActionResult;
  evidence: FormScoringEvidence | undefined;
  posts: number;
  searches: number;
}

async function withDiagnostics<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
  }
}

async function fillFixture(file: string, query: string, journeyContext?: FormJourneyContext): Promise<Outcome> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(`${baseUrl}/${file}${query ? `?${query}` : ""}`);
    const result = (await withDiagnostics(() =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], journeyContext }),
    )) as ActionResult;
    const counters = await page.evaluate(() => {
      const w = window as unknown as { __leadPosts?: unknown[]; __searches?: number };
      return { posts: w.__leadPosts?.length ?? 0, searches: w.__searches ?? 0 };
    });
    const selected = result.formDiscoveryDiagnostics?.selectedFormIndex ?? 0;
    const evidence = result.formDiscoveryDebug?.candidates.find((c) => c.index === selected)?.scoringEvidence;
    return { result, evidence, ...counters };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

async function fillParity(query: string, journeyContext: FormJourneyContext = ENGLISH_STEPS): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const dom of DOMS) outcomes.push(await fillFixture("form-scoring-parity.html", `dom=${dom}&${query}`, journeyContext));
  return outcomes;
}

function scores(outcome: Outcome) {
  const d = outcome.result.formDiscoveryDiagnostics;
  return {
    outcome: outcome.result.formFillOutcome,
    journey: d?.journeyRelevanceScore,
    visibility: d?.visibilityProminenceScore,
    actionability: d?.fieldActionabilityScore,
    total: d?.totalFormScore,
  };
}

function assertParity([light, shadow]: Outcome[]): void {
  assert.deepEqual(scores(shadow!), scores(light!));
  assert.deepEqual(shadow!.evidence, light!.evidence);
}

test("form scoring: hidden backing inputs do not dilute field actionability, in light DOM and open shadow DOM", async () => {
  const [plain] = await fillParity("");
  const withHidden = await fillParity("hidden=58");
  assertParity(withHidden);
  for (const outcome of withHidden) {
    assert.equal(outcome.evidence?.discoveredControls, (plain!.evidence?.discoveredControls ?? 0) + 58);
    assert.equal(outcome.evidence?.userActionableControls, plain!.evidence?.userActionableControls);
    assert.equal(outcome.result.formDiscoveryDiagnostics?.fieldActionabilityScore, plain!.result.formDiscoveryDiagnostics?.fieldActionabilityScore);
    assert.equal(outcome.result.formFillOutcome, "submitted");
    assert.equal(outcome.posts, 1);
  }
});

test("form scoring: disabled controls in a collapsed section are not counted as user-actionable", async () => {
  const [plain] = await fillParity("");
  const withInactive = await fillParity("inactive=6");
  assertParity(withInactive);
  for (const outcome of withInactive) {
    assert.equal(outcome.evidence?.userActionableControls, plain!.evidence?.userActionableControls);
    assert.equal(outcome.result.formDiscoveryDiagnostics?.fieldActionabilityScore, plain!.result.formDiscoveryDiagnostics?.fieldActionabilityScore);
  }
});

test("form scoring: an in-form dealer search submit before the final Submit is neither scored as the form's purpose nor clicked to submit", async () => {
  const outcomes = await fillParity("hidden=58&inactive=6&search=1");
  assertParity(outcomes);
  for (const outcome of outcomes) {
    assert.equal(outcome.evidence?.submitControlText, "VALIDEZ VOTRE DEMANDE");
    assert.equal(outcome.evidence?.submitControlSource, "final_submit");
    assert.deepEqual(outcome.evidence?.skippedSubmitControlTexts, ["Recherchez"]);
    assert.equal(outcome.evidence?.negativeVeto, false);
    assert.deepEqual(outcome.evidence?.negativeMatches, []);
    assert.equal(outcome.result.formFillOutcome, "submitted", outcome.result.error);
    assert.equal(outcome.searches, 0, "the dealer search control was never clicked as Submit");
    assert.equal(outcome.posts, 1);
  }
});

test("form scoring: a purpose heading outside the form app is found from inside an open shadow root as from the light DOM", async () => {
  const outcomes = await fillParity("");
  assertParity(outcomes);
  for (const outcome of outcomes) {
    assert.equal(outcome.evidence?.headingText, "Demandez un essai");
    assert.match(outcome.evidence?.headingSource ?? "", /^ancestor_/);
    assert.deepEqual(outcome.evidence?.positiveMatches, ["essai"]);
  }
});

test("form scoring: a form app inside page chrome is recognised as chrome from inside an open shadow root as from the light DOM", async () => {
  const outcomes = await fillParity("place=footer");
  assertParity(outcomes);
  for (const outcome of outcomes) assert.equal(outcome.evidence?.visibility.inChrome, true);
});

test("form scoring: English step instructions on a non-English form, started directly on the form, adopt it from the form's own purpose evidence", async () => {
  const outcomes = await fillParity("hidden=58&inactive=6&search=1");
  for (const outcome of outcomes) {
    assert.ok(outcome.evidence?.journeyAnchors.every((anchor) => anchor.coverage === 0), "no English anchor token appears on the page");
    assert.equal(outcome.evidence?.anchorScore, 0);
    assert.equal(outcome.evidence?.purposeBonus, 0.3);
    assert.ok((outcome.result.formDiscoveryDiagnostics?.totalFormScore ?? 0) >= 0.4);
  }
});

test("form scoring: with no purpose evidence at all, a direct-start form stays below the threshold in both DOMs", async () => {
  const outcomes = await fillParity("title=plain&heading=none");
  assertParity(outcomes);
  for (const outcome of outcomes) {
    assert.equal(outcome.result.formFillOutcome, "form_discovery_failed");
    assert.equal(outcome.posts, 0);
  }
});

test("form scoring: a lead form still wins over a newsletter form, and a newsletter form is still vetoed, in light DOM and open shadow DOM", async () => {
  const previous = process.env[FIXTURE_DOM_MODE_ENV];
  try {
    const both: Outcome[] = [];
    for (const mode of [undefined, OPEN_SHADOW_MODE]) {
      if (mode) process.env[FIXTURE_DOM_MODE_ENV] = mode;
      else delete process.env[FIXTURE_DOM_MODE_ENV];
      both.push(await fillFixture("lead-form-newsletter-vs-quote.html", ""));
      const lowConfidence = await fillFixture("lead-form-low-confidence-single.html", "");
      assert.equal(lowConfidence.result.formFillOutcome, "form_discovery_failed");
    }
    for (const outcome of both) assert.equal(outcome.result.formDiscoveryDiagnostics?.selectedFormIndex, 1);
    assert.deepEqual(scores(both[1]!), scores(both[0]!));
  } finally {
    if (previous === undefined) delete process.env[FIXTURE_DOM_MODE_ENV];
    else process.env[FIXTURE_DOM_MODE_ENV] = previous;
  }
  for (const outcome of await fillParity("kind=newsletter")) {
    assert.equal(outcome.evidence?.negativeVeto, true);
    assert.deepEqual(outcome.evidence?.negativeMatches, ["newsletter"]);
    assert.equal(outcome.result.formDiscoveryDiagnostics?.journeyRelevanceScore, 0);
  }
});

const CLICK_CTA: ClaudeDecisionPayload = {
  action: "click",
  targetElementId: "el-0",
  reason: "The page links to a test-drive request.",
  confidence: 0.9,
  consentControlIntent: "not_consent_related",
};
const FILL_FORM: ClaudeDecisionPayload = { action: "fill_form", reason: "The page shows the request form.", confidence: 0.9, consentControlIntent: "not_consent_related" };
const STOP_SUCCESS: ClaudeDecisionPayload = { action: "stop_success", reason: "The confirmation is shown.", confidence: 0.9, consentControlIntent: "not_consent_related" };

function scoringTask(baseUrl: string, startFile: string, query: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "form-scoring-parity",
    objective: ENGLISH_STEPS.objective!,
    startUrl: `${baseUrl}/${startFile}?${query}`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "confirmation_shown",
        type: "element_present",
        description: "The request confirmation is shown.",
        config: { selector: '[role="status"]:has-text("votre demande a bien été envoyée")' },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 4, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "fill_form", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    outputSchemaVersion: "1.53.0",
  };
}

async function runJourney(startFile: string, query: string, steps: ClaudeDecisionPayload[]) {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page: Page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const reasoning = new ClaudeReasoningProvider({
      config: { apiKey: "test-fake-key-never-a-real-credential", model: "test-model", maxOutputTokens: 512, timeoutMs: 5000, maxRetries: 0, minConfidence: 0.5 },
      modelClient: new FakeReasoningModelClient(steps.map((s) => resultStep(s))),
    });
    const result = await withDiagnostics(() => runTask({ page, task: scoringTask(baseUrl, startFile, query), reasoning }));
    const fillStep = result.steps.find((s) => s.selectedAction.type === "fill_form");
    return { result, fill: fillStep?.actionResult };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

test("form scoring end-to-end: a direct-start and a CTA-navigated run both fill and submit the form, in light DOM and open shadow DOM", async () => {
  for (const dom of DOMS) {
    const query = `dom=${dom}&hidden=58&inactive=6&search=1`;
    const direct = await runJourney("form-scoring-parity.html", query, [FILL_FORM, STOP_SUCCESS]);
    const navigated = await runJourney("form-scoring-landing.html", query, [CLICK_CTA, FILL_FORM, STOP_SUCCESS]);
    for (const run of [direct, navigated]) {
      assert.equal(run.fill?.formFillOutcome, "submitted", `${dom}: ${run.fill?.error}`);
      assert.equal(run.result.status, "success");
      const schemaValidation = await validateAgainstTaskResponseSchema(run.result);
      assert.ok(schemaValidation.valid, schemaValidation.errorsText);
    }
    const navigatedEvidence = navigated.fill?.formDiscoveryDebug?.candidates[0]?.scoringEvidence;
    const ctaAnchor = navigatedEvidence?.journeyAnchors.find((anchor) => anchor.text === "Demandez un essai");
    assert.ok(ctaAnchor && ctaAnchor.coverage > 0, `${dom}: the clicked CTA's label is a journey anchor`);
    assert.ok(
      (navigated.fill?.formDiscoveryDiagnostics?.journeyRelevanceScore ?? 0) > (direct.fill?.formDiscoveryDiagnostics?.journeyRelevanceScore ?? 0),
      `${dom}: the clicked CTA adds journey relevance`,
    );
  }
});
