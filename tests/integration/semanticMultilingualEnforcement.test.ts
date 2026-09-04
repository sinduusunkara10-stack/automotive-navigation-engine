import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { ClaudeSemanticCriterionVerifier } from "../../src/reasoning/semanticCriterionVerifier.js";
import type {
  ReasoningModelClient,
  ReasoningModelRequest,
  ReasoningModelResult,
} from "../../src/reasoning/reasoningModelClient.js";
import { startStaticServer } from "../helpers/staticServer.js";

const TEST_VERIFIER_CONFIG = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

/**
 * Deterministic, no-network stand-in for the real Claude API, content-aware rather than
 * sequence-scripted (unlike tests/unit/fakes/fakeReasoningModelClient.ts) -- a full
 * engine-loop run evaluates semantic_page_match against *every* page it visits (not just
 * the destination), so a fixed sequence of canned responses can't safely predict how many
 * calls occur or in what order. This fake instead judges each call by whether the given
 * page evidence contains `satisfiedMarker`, exactly as a real multilingual model call
 * would judge the actual page content -- correctly returning "not satisfied" for
 * irrelevant pages (e.g. the start page) and "satisfied" only for the true destination.
 */
class KeywordAwareSemanticModelClient implements ReasoningModelClient {
  readonly requests: ReasoningModelRequest<unknown>[] = [];
  constructor(private readonly satisfiedMarker: string) {}

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    this.requests.push(request as ReasoningModelRequest<unknown>);
    const satisfied = request.userPrompt.includes(this.satisfiedMarker);
    return {
      parsedOutput: {
        satisfied,
        confidence: satisfied ? 0.92 : 0.05,
        evidence: satisfied
          ? "Configurateur officiel / Configurez votre future voiture; multiple model-selection controls."
          : "No matching evidence found in the given page signals.",
      } as TPayload,
      stopReason: "end_turn",
      usage: { inputTokens: 120, outputTokens: 24 },
    };
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Regression coverage for the multilingual semantic_page_match defect: an English
 * objective correctly describes a destination page that is written in a different
 * language (fixture below uses French, matching the reported production evidence --
 * see tests/fixtures/multilingual-destination-fr.html). Deliberately no url_pattern
 * criterion and no site-specific CSS selector -- semantic_page_match is the only
 * required success criterion, exactly as in the reported task.
 */
function buildTask(overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schemaVersion: "1.6.0",
    taskId: "multilingual-semantic-regression",
    objective:
      "Navigate to the official consumer vehicle configurator and stop when vehicle selection or configuration controls are available.",
    startUrl: "PLACEHOLDER", // set per-test once baseUrl is known
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "objective-destination-reached",
        type: "semantic_page_match",
        description: "Vehicle selection or configuration controls are available on the page.",
        config: { minScore: 0.4 },
        required: true,
      },
    ],
    captureModules: ["errors"],
    // Default maxRepeatedActions (3) and a generous maxSteps ceiling so, before the fix,
    // this reproduces the exact reported shape: the run ends "blocked" with
    // finishReason "repeated_action" (the safety layer's repeated-action guard trips
    // before maxSteps is ever reached), not a max_steps timeout.
    limits: { maxSteps: 8, maxBacktracks: 0 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.5.0",
    ...overrides,
  };
}

/**
 * Reproduces "Claude correctly understood the page and proposed stop_success
 * repeatedly": clicks "Continue" once to reach the destination, then always proposes
 * stop_success on every subsequent call, regardless of what satisfiedCriteriaIds says --
 * modelling a well-behaved navigation decision that is correct about *reaching* the
 * destination, entirely independent of whatever the success-criteria evaluator decides.
 */
class ReachDestinationThenAlwaysStopSuccessProvider implements ReasoningProvider {
  private clicked = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.clicked) {
      this.clicked = true;
      const candidate = context.observation.interactiveElements.find(
        (el) => el.visible !== false && /continue/i.test(el.accessibleName),
      );
      if (candidate && context.allowedActions.includes("click")) {
        return { action: { type: "click", target: candidate.id }, rationale: 'Click "Continue".' };
      }
    }
    return { action: { type: "stop_success" }, rationale: "The destination page is reached." };
  }
}

test("PERMANENT FALLBACK DOCUMENTATION: without a semantic verifier configured, deterministic-only lexical overlap still cannot bridge an English objective to a French destination page", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = buildTask({ startUrl: `${baseUrl}/multilingual-start.html` });

    const response = await runTask({
      page,
      task,
      reasoning: new ReachDestinationThenAlwaysStopSuccessProvider(),
    });

    // This assertion documents the honest, permanent fallback behaviour: with no
    // semantic verifier wired in, the engine navigates to the correct destination page,
    // but semantic_page_match's deterministic (lexical token-overlap) evaluation alone
    // cannot recognise the French page evidence as satisfying the English objective, so
    // the required criterion is never satisfied. This must remain true both before and
    // after the multilingual fix below -- the fix is opt-in via semanticVerifier, never
    // a change to the deterministic-only default.
    assert.equal(response.finalUrl, `${baseUrl}/multilingual-destination-fr.html`);
    assert.notEqual(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.ok(response.diagnostics.missingRequiredCriteriaIds?.includes("objective-destination-reached"));
    assert.ok(
      !response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("objective-destination-reached"),
      "the required criterion must remain unsatisfied when no semantic verifier is configured",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// FAILING-BEFORE-FIX REGRESSION PROOF (task requirements #10-13).
//
// This test currently calls runTask() with no way to supply multilingual semantic
// verification -- that capability does not exist yet on this branch. Run as-is, it
// reproduces the production defect and its assertion of `status === "success"` FAILS.
// See the implementation summary for the captured failing-run output. Once the
// semanticVerifier capability is implemented below, this exact test is updated in place
// (same fixture pages, same objective, same required criterion -- only the runTask call
// gains the new, opt-in `semanticVerifier` argument) and must then pass.
// ---------------------------------------------------------------------------------------

test("FAILING-BEFORE-FIX regression proof: the English objective must succeed against the French destination page once multilingual semantic verification is available", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = buildTask({ startUrl: `${baseUrl}/multilingual-start.html` });

    // Judges evidence containing the destination page's own <title> text as satisfied --
    // exactly as a real multilingual model call would correctly recognise the true
    // destination and correctly reject the (English) start page's unrelated evidence.
    const modelClient = new KeywordAwareSemanticModelClient("Configurateur officiel de véhicules");
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: TEST_VERIFIER_CONFIG, modelClient });

    const response = await runTask({
      page,
      task,
      reasoning: new ReachDestinationThenAlwaysStopSuccessProvider(),
      semanticVerifier,
    });

    assert.equal(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.ok(response.engineAssessment.satisfiedSuccessCriteriaIds?.includes("objective-destination-reached"));
    // Exactly two real model calls for the whole run: one correctly-negative call for the
    // start page (evaluated once, before the click, since its deterministic score also
    // falls short of minScore) and one positive call for the destination page. Once the
    // criterion is satisfied, src/core/loop.ts's already-satisfied short-circuit
    // (evaluateSuccessCriteria's alreadySatisfiedCriteriaIds parameter) skips it entirely
    // on every later evaluation -- including the accepted stop_success proposal itself --
    // so those never even reach the verifier's own content cache. cacheHitCount stays 0:
    // it counts calls that reached verify() and were served from cache, not evaluations
    // skipped before ever calling verify() at all (see "Repeated-decision and cost
    // control" in docs/n8n-integration.md for the distinction between the two mechanisms).
    assert.equal(modelClient.requests.length, 2);
    assert.equal(response.diagnostics.semanticVerifier?.callCount, 2);
    assert.equal(response.diagnostics.semanticVerifier?.cacheHitCount, 0);
    assert.equal(response.diagnostics.semanticVerifier?.satisfiedCount, 1);
    assert.equal(response.diagnostics.semanticVerifier?.rejectedCount, 1);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// Safety precedence (task requirement: multilingual similarity must never override
// allowedDomains/host-safety/other safety rules) and fail-closed behaviour (a verifier
// failure must never silently become success).
// ---------------------------------------------------------------------------------------

test("a semantic verifier that would say 'satisfied' can never rescue a run blocked by allowedDomains -- the criterion is never even evaluated", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = buildTask({
      startUrl: `${baseUrl}/multilingual-start.html`,
      allowedDomains: ["example-not-this-host.invalid"],
    });
    // Always satisfied, unconditionally -- if this verifier were ever consulted, the run
    // would trivially succeed. Proves the safety layer runs first and the run never
    // reaches a page (so never reaches criterion evaluation) at all.
    const alwaysSatisfiedClient: ReasoningModelClient = {
      async createDecision<TPayload>(): Promise<ReasoningModelResult<TPayload>> {
        return {
          parsedOutput: { satisfied: true, confidence: 1, evidence: "unconditionally satisfied" } as TPayload,
          stopReason: "end_turn",
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      },
    };
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({
      config: TEST_VERIFIER_CONFIG,
      modelClient: alwaysSatisfiedClient,
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ReachDestinationThenAlwaysStopSuccessProvider(),
      semanticVerifier,
    });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 0, "blocked before any step -- and so before any criterion is evaluated");
    assert.equal(response.diagnostics.finishReason, "domain_blocked");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a semantic verifier that fails closed on every call must never silently satisfy the required criterion", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = buildTask({
      startUrl: `${baseUrl}/multilingual-start.html`,
      limits: { maxSteps: 50, maxBacktracks: 0, maxRepeatedActions: 50 },
    });
    // Every call errors -- models a persistent provider outage/misconfiguration.
    const alwaysErroringClient: ReasoningModelClient = {
      async createDecision() {
        throw new Error("simulated provider outage");
      },
    };
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({
      config: TEST_VERIFIER_CONFIG,
      modelClient: alwaysErroringClient,
    });

    const response = await runTask({
      page,
      task,
      reasoning: new ReachDestinationThenAlwaysStopSuccessProvider(),
      semanticVerifier,
    });

    assert.notEqual(response.status, "success");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.ok(response.diagnostics.missingRequiredCriteriaIds?.includes("objective-destination-reached"));
    assert.equal(response.diagnostics.semanticVerifier?.satisfiedCount, 0);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
