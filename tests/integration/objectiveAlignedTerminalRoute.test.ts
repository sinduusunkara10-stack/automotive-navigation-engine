import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import { ClaudeSemanticCriterionVerifier } from "../../src/reasoning/semanticCriterionVerifier.js";
import type {
  ReasoningModelClient,
  ReasoningModelRequest,
  ReasoningModelResult,
} from "../../src/reasoning/reasoningModelClient.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * REGRESSION (real production configurator run, schemaVersion 1.3.0): the run
 * blocked with status "blocked"/statusReason "repeated_action" because Navigation Claude
 * repeatedly chose "scroll" even though the page's own Resume/Continue-equivalent controls
 * were already visible -- traced to src/reasoning/promptBuilder.ts's raw positional
 * MAX_INTERACTIVE_ELEMENTS truncation silently dropping them from the model's actual
 * prompt (see tests/unit/promptBuilder.test.ts for the isolated unit-level proof). These
 * tests exercise the same defect through the full engine loop, using tests/fixtures/
 * configurator-terminal-fr.html -- 45 filler nav links (closely mirroring a real, complex
 * configurator page) placed *before* the real terminal-route controls in DOM order, so the
 * controls only reach the prompt if the fix's relevance-based selection actually works.
 *
 * Two deterministic fakes stand in for the real Claude calls (same pattern as
 * tests/integration/requiredSuccessCriteriaEnforcement.test.ts's KeywordAwareSemanticModelClient):
 * RouteAwareModelClient (navigation decisions) inspects only request.userPrompt -- exactly
 * what a real model receives, never the full untruncated observation -- so it can only
 * "see" and click a control if the engine's prompt construction actually included it.
 * RouteVerifierModelClient (terminal-criterion verification) judges by lastActionEvidence,
 * exercising PR #21's real terminal-route mechanism end to end rather than fighting the
 * deterministic lexical scorer's known accent-fragmentation/stopword noise on short French
 * headings (see the diagnosis notes in this session).
 */

const REASONING_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

const VERIFIER_CONFIG = REASONING_CONFIG;

interface PromptPageElement {
  id: string;
  accessibleName: string;
  visible?: boolean;
  disabled?: boolean;
}

/**
 * Deterministic stand-in for a well-behaved Claude decision: prefers a visible, enabled
 * control whose accessible name matches `preferredPattern` (and never one matching
 * `forbiddenPattern`, simulating the system prompt's instruction to never select a
 * payment/order/booking/lead-style control); otherwise scrolls if allowed, or stops.
 */
class RouteAwareModelClient implements ReasoningModelClient {
  readonly requests: ReasoningModelRequest<unknown>[] = [];
  constructor(
    private readonly preferredPattern: RegExp,
    private readonly forbiddenPattern: RegExp = /payer|commande|order|booking|lead/i,
  ) {}

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    this.requests.push(request as ReasoningModelRequest<unknown>);
    const payload = JSON.parse(request.userPrompt) as {
      satisfiedCriteriaIds: string[];
      successCriteria: { id: string; required: boolean }[];
      allowedActions: string[];
      currentPage: { interactiveElements: PromptPageElement[] };
      recentActions: { type: string; target?: string }[];
    };

    const requiredIds = payload.successCriteria.filter((c) => c.required).map((c) => c.id);
    const allRequiredSatisfied = requiredIds.every((id) => payload.satisfiedCriteriaIds.includes(id));
    if (allRequiredSatisfied && payload.allowedActions.includes("stop_success")) {
      return this.result({ action: "stop_success", reason: "Required criteria satisfied.", confidence: 0.95 });
    }

    const alreadyClicked = new Set(payload.recentActions.filter((a) => a.type === "click" && a.target).map((a) => a.target as string));
    const candidate = payload.currentPage.interactiveElements.find(
      (el) =>
        el.visible !== false &&
        !el.disabled &&
        !alreadyClicked.has(el.id) &&
        this.preferredPattern.test(el.accessibleName) &&
        !this.forbiddenPattern.test(el.accessibleName),
    );
    if (candidate && payload.allowedActions.includes("click")) {
      return this.result({
        action: "click",
        targetElementId: candidate.id,
        reason: `Selected "${candidate.accessibleName}" as it matches the requested route.`,
        confidence: 0.9,
      });
    }

    if (payload.allowedActions.includes("scroll")) {
      return this.result({ action: "scroll", reason: "No matching visible control yet; scrolling.", confidence: 0.6 });
    }
    return this.result({ action: "stop_failure", reason: "No permitted action available.", confidence: 0.5 });
  }

  private result<TPayload>(payload: ClaudeDecisionPayload): ReasoningModelResult<TPayload> {
    return { parsedOutput: payload as unknown as TPayload, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } };
  }
}

/** Always chooses scroll, regardless of what's visible -- simulates a model with no matching control. */
class AlwaysScrollModelClient implements ReasoningModelClient {
  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    const payload = JSON.parse(request.userPrompt) as { allowedActions: string[] };
    const action = payload.allowedActions.includes("scroll") ? "scroll" : "stop_failure";
    return {
      parsedOutput: { action, reason: "Nothing visible matches; scrolling to look for more.", confidence: 0.6 } as unknown as TPayload,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
}

/**
 * Judges the terminal criterion satisfied only when the click actually attributed to it
 * (`lastActionEvidence`, threaded by src/core/successEvaluator.ts -- PR #21) matches
 * `requiredControlPattern`. Deliberately ignores page text entirely: this is what proves
 * the *click itself* is what's being verified, not merely "a right-looking page was
 * reached" -- exactly the terminal-route requirement this whole investigation is about.
 */
class RouteVerifierModelClient implements ReasoningModelClient {
  constructor(private readonly requiredControlPattern: RegExp) {}

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    const payload = JSON.parse(request.userPrompt) as {
      lastActionEvidence?: { ctaText?: string; accessibleName?: string };
    };
    const clickedName = payload.lastActionEvidence?.accessibleName ?? payload.lastActionEvidence?.ctaText ?? "";
    const satisfied = this.requiredControlPattern.test(clickedName);
    return {
      parsedOutput: {
        satisfied,
        confidence: 0.9,
        evidence: satisfied ? `The clicked control "${clickedName}" matches the requested route.` : `The clicked control "${clickedName}" does not match the requested route.`,
      } as unknown as TPayload,
      stopReason: "end_turn",
      usage: { inputTokens: 80, outputTokens: 15 },
    };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.7.0",
    taskId: "objective-aligned-terminal-route",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events", "errors"],
    limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "scroll", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.6.0",
    ...overrides,
  };
}

// minScore above the maximum possible deterministic score (1.0) forces every evaluation of
// this criterion to escalate to the semanticVerifier -- sidesteps the deterministic lexical
// scorer's known accent-fragmentation/French-stopword noise on short headings (verified
// empirically while building these tests) and directly exercises the real terminal-route
// verification mechanism (lastActionEvidence) instead.
const FORCE_VERIFIER_CONFIG = { minScore: 1.1 };

const SUMMARY_OBJECTIVE =
  "Entrez dans le configurateur, terminez les étapes de configuration en utilisant les valeurs par défaut, " +
  "activez le contrôle dont le but sémantique est de révéler le résumé de la configuration terminée, " +
  "vérifiez que le résumé est affiché, puis arrêtez-vous avec succès.";
const CONTINUE_OBJECTIVE =
  "Entrez dans le configurateur, terminez les étapes de configuration, activez le contrôle Continuez pour " +
  "poursuivre en toute sécurité (pas le résumé), vérifiez que la poursuite est confirmée, puis arrêtez-vous " +
  "avec succès.";
const NO_PREFERENCE_OBJECTIVE =
  "Entrez dans le configurateur et terminez la configuration en utilisant n'importe quelle route de " +
  "finalisation sûre disponible (résumé ou continuer), puis arrêtez-vous avec succès.";

test("REGRESSION: Summary-requested objective selects the Resume-equivalent control, not Continue, not scroll, not a decoy", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: SUMMARY_OBJECTIVE,
      successCriteria: [
        {
          id: "configuration-finished",
          type: "semantic_page_match",
          description: "Le résumé de la configuration terminée a été révélé en cliquant sur le contrôle Résumé.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new RouteAwareModelClient(/r.sum./i) });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 1, "expected exactly one click: the Resume-equivalent control, no scrolling needed once it's visible");
    assert.match(clicks[0]?.ctaText ?? "", /r.sum./i);
    assert.doesNotMatch(clicks[0]?.ctaText ?? "", /continuez/i);
    assert.doesNotMatch(clicks[0]?.ctaText ?? "", /payer|commande|offres/i);

    const analytics = clicks[0]?.actionAnalytics;
    assert.ok(analytics, "expected action-attributed analytics on the terminal click");
    assert.deepEqual(analytics?.newlySatisfiedCriteriaIds, ["configuration-finished"]);
    assert.equal(analytics?.dataLayerDelta?.available, true);
    assert.ok(analytics?.ga4RequestsObservedDuringActionWindow?.some((r) => r.requestUrl.includes("/g/collect")));
    assert.ok(analytics?.verifierDecisions && analytics.verifierDecisions.length > 0, "expected the verifier decision attributed to this click");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: Continue-requested objective selects the Continue-equivalent control, never Summary, never a transactional decoy", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: CONTINUE_OBJECTIVE,
      successCriteria: [
        {
          id: "configuration-finished",
          type: "semantic_page_match",
          description: "La configuration a continué en toute sécurité en cliquant sur le contrôle Continuez.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new RouteAwareModelClient(/^continuez$/i) });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/^continuez$/i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 1);
    assert.match(clicks[0]?.ctaText ?? "", /continuez/i);
    assert.doesNotMatch(clicks[0]?.ctaText ?? "", /r.sum./i);
    assert.doesNotMatch(clicks[0]?.ctaText ?? "", /payer|commande|offres/i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: no-route-preference objective accepts either safe completion route and records which one was actually followed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // Uses the small companion fixture (no large filler list): this scenario tests
    // whether the success-criteria/terminal-verifier layer accepts either route, a
    // separate concern from the prompt-truncation/relevance-ranking mechanism proven by
    // the Summary/Continue-requested tests above -- a genuinely route-agnostic objective
    // shares no literal vocabulary with either button label, so relevance-based ranking
    // alone cannot be relied on to rescue it under adversarial truncation (see this
        // session's diagnosis notes / final report "known limitations").
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-no-preference.html`,
      objective: NO_PREFERENCE_OBJECTIVE,
      successCriteria: [
        {
          id: "configuration-finished",
          type: "semantic_page_match",
          description: "La configuration est terminée via le résumé ou en continuant en toute sécurité.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new RouteAwareModelClient(/continuez|r.sum./i) });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/continuez|r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 1);
    assert.match(clicks[0]?.ctaText ?? "", /continuez|r.sum./i, "either safe route qualifies");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a visible-but-wrong control clicked in error never satisfies the terminal criterion merely because a control was actionable -- the run only succeeds once the actually-requested route is clicked", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: SUMMARY_OBJECTIVE,
      successCriteria: [
        {
          id: "configuration-finished",
          type: "semantic_page_match",
          description: "Le résumé de la configuration terminée a été révélé en cliquant sur le contrôle Résumé.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 5 },
    });

    // Deliberately broad, imperfect pattern that matches the "Voir les offres" decoy
    // *first* (it precedes Résumé in DOM order) as well as the real target -- models a
    // reasoning layer that makes an imperfect first guess. Production code never performs
    // this discrimination itself (per CLAUDE.md and this task's explicit constraints);
    // what the engine *is* responsible for is that a wrong click never falsely satisfies
    // the terminal criterion, so the run cannot succeed via it.
    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new RouteAwareModelClient(/r.sum.|offres/i) });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(clicks.length >= 2, "expected the decoy click, then the corrective click on the real target");

    const decoyClick = clicks.find((c) => /offres/i.test(c.ctaText));
    assert.ok(decoyClick, "expected the decoy to actually have been clicked in this scenario, proving the assertions below are meaningful");
    assert.equal(
      decoyClick?.actionAnalytics?.newlySatisfiedCriteriaIds,
      undefined,
      "the decoy click must never be recorded as having satisfied the terminal criterion",
    );

    assert.equal(response.status, "success", `expected the run to recover and succeed via the real target, got ${response.status}/${response.statusReason}`);
    const finalClick = clicks[clicks.length - 1];
    assert.match(finalClick?.ctaText ?? "", /r.sum./i);
    assert.deepEqual(finalClick?.actionAnalytics?.newlySatisfiedCriteriaIds, ["configuration-finished"]);
    assert.ok(!clicks.some((c) => /payer|commande/i.test(c.ctaText)), "the payment decoy must never be clicked");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: scrolling remains available and the repeated-action guard is unweakened when no visible control aligns with the objective", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      // Nothing on this fixture relates to booking a test drive -- every visible control
      // is either a filler link or one of the configurator/decoy controls.
      objective: "Réservez un essai routier et arrêtez-vous une fois la réservation confirmée.",
      successCriteria: [
        { id: "test-drive-booked", type: "semantic_page_match", description: "La réservation d'essai routier est confirmée.", required: true },
      ],
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new AlwaysScrollModelClient() });
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "blocked");
    assert.equal(response.diagnostics.finishReason, "repeated_action");
    assert.ok(response.steps.every((s) => s.selectedAction.type === "scroll" || s.selectedAction.type === "stop_blocked"));
    assert.ok(
      response.steps.filter((s) => s.selectedAction.type === "scroll").length >= 3,
      "the repeated-action guard must still require multiple consecutive identical scrolls before stopping the run, unweakened by this fix",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// REGRESSION (real production run, second occurrence, schemaVersion 1.3.0): the tests
// above (SUMMARY_OBJECTIVE etc.) are written in French -- the *same* language as the
// fixture's own labels -- so, while they validate the terminal-route/verifier mechanism
// end to end, they do not by themselves prove the actual reported failure is fixed: the
// live run used an *English* objective against the fixture's French "Résumé"/"Continuez"
// labels, which the deterministic lexical-relevance mechanism (objectiveRelevanceScore)
// cannot bridge at all (verified: it scores 0, tying the real controls with ordinary
// filler). These tests use a genuinely cross-language objective -- zero literal vocabulary
// overlap with either label -- to demonstrate the actual reported case is fixed, not just
// the same-language case PR #22 already covered.
// ---------------------------------------------------------------------------------------

const ENGLISH_SUMMARY_OBJECTIVE =
  "Navigate to the official consumer vehicle configurator, proceed through the configuration steps using " +
  "existing defaults where necessary, activate the control whose semantic purpose is to reveal the completed " +
  "configuration summary, verify that the resulting summary state is observable, and then stop successfully.";

test("REGRESSION (cross-language, zero token overlap): an English objective selects the French Résumé-equivalent control directly, without scrolling first", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: ENGLISH_SUMMARY_OBJECTIVE,
      successCriteria: [
        {
          id: "objective-destination-reached",
          type: "semantic_page_match",
          description: "The completed configuration summary has been revealed by clicking the summary control.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new RouteAwareModelClient(/r.sum./i) });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.notEqual(response.statusReason, "repeated_action", "must not reproduce the reported repeated_action block");
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(!response.steps.some((s) => s.selectedAction.type === "scroll"), "the terminal control must be visible immediately -- no scrolling should be needed to find it");
    assert.equal(clicks.length, 1);
    assert.match(clicks[0]?.ctaText ?? "", /r.sum./i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION (cross-language, zero token overlap): success is not accepted merely because the control is visible -- it is accepted only once clicked and the resulting state is verified", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: ENGLISH_SUMMARY_OBJECTIVE,
      successCriteria: [
        {
          id: "objective-destination-reached",
          type: "semantic_page_match",
          description: "The completed configuration summary has been revealed by clicking the summary control.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 5 },
    });

    // Never selects anything (simulates a reasoning layer that, for whatever reason,
    // never acts) -- proves the run does not spuriously succeed just because a matching
    // control is present in the observation/prompt.
    class NeverActsModelClient implements ReasoningModelClient {
      async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
        const payload = JSON.parse(request.userPrompt) as { allowedActions: string[] };
        const action = payload.allowedActions.includes("wait") ? "wait" : "stop_failure";
        return {
          parsedOutput: { action, reason: "Deliberately not acting yet.", confidence: 0.6 } as unknown as TPayload,
          stopReason: "end_turn",
          usage: { inputTokens: 50, outputTokens: 10 },
        };
      }
    }

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new NeverActsModelClient() });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.notEqual(response.status, "success", "the run must never succeed without the terminal control ever having been clicked");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.deepEqual(response.captures.cta_clicks ?? [], []);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("SAFETY REGRESSION (cross-language): a transactional/payment-style decoy is never clicked even though it is now reliably visible in the prompt alongside the real terminal control", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr.html`,
      objective: ENGLISH_SUMMARY_OBJECTIVE,
      successCriteria: [
        {
          id: "objective-destination-reached",
          type: "semantic_page_match",
          description: "The completed configuration summary has been revealed by clicking the summary control.",
          config: FORCE_VERIFIER_CONFIG,
          required: true,
        },
      ],
    });

    const modelClient = new RouteAwareModelClient(/r.sum./i);
    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    // Sanity check: the payment decoy is actually present in the model's prompt in this
    // scenario, so the safety property below is meaningful and not vacuous merely because
    // the decoy happened to be truncated out.
    const firstRequest = modelClient.requests[0];
    assert.ok(firstRequest, "expected at least one decision request");
    const firstPayload = JSON.parse(firstRequest.userPrompt) as { currentPage: { interactiveElements: { accessibleName: string }[] } };
    assert.ok(
      firstPayload.currentPage.interactiveElements.some((el) => /payer|commande/i.test(el.accessibleName)),
      "sanity check failed: the payment decoy was not even present in the prompt for this test to be meaningful",
    );

    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(!clicks.some((c) => /payer|commande/i.test(c.ctaText)), "the payment/transactional decoy must never be clicked");
    assert.equal(response.status, "success");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
