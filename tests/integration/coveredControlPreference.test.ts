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
 * REGRESSION (real production run): the run reached a configurator step where the real
 * terminal-route controls (Résumé/Continuez-equivalents) were already visible, but a
 * full-viewport consent-style overlay sat on top of the page -- so those controls were
 * visible in the DOM yet not actually clickable, while the overlay's own dismiss control
 * was the only genuinely reachable one. Navigation Claude selected the overlay's control,
 * which then failed to dispatch because by the time the click executed the target had
 * already gone stale/not-actionable, ending the run in action_execution_error. Root cause
 * traced to src/observation/observationBuilder.ts's buildObservation never computing or
 * exposing whether a control is covered by another element (only the separate, per-id
 * readElementState -- used for pre-dispatch revalidation -- computed this), so neither the
 * reasoning layer nor the prompt-selection logic had any way to prefer a genuinely
 * reachable control over one that looked identical but was blocked. tests/fixtures/
 * configurator-terminal-fr-overlay.html reproduces the shape of that page (a full-viewport
 * overlay initially covering the real controls, with only its own dismiss control
 * reachable) using fixture-only French labels, matching the sibling terminal-fr fixture's
 * convention -- no such wording appears in production src/ code.
 *
 * CoveredAwareModelClient below inspects only request.userPrompt (exactly what a real
 * model receives) and picks a click purely by the generic `covered` field the fix now
 * forwards -- proving the fix's plumbing (buildObservation -> prompt payload ->
 * elementSelection) actually supplies a reasoning layer with what it needs to first clear
 * a genuine blocker and then correctly select the now-reachable objective control, without
 * claiming to reproduce the real Claude model's own non-deterministic judgement.
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
  covered?: boolean;
}

/**
 * Deterministic stand-in for a well-behaved Claude decision that respects the `covered`
 * field: prefers an uncovered control matching `preferredPattern`; only when none is
 * uncovered does it fall back to clicking an uncovered control matching `blockerPattern`
 * (clearing whatever is in the way), and never clicks a covered control at all.
 */
class CoveredAwareModelClient implements ReasoningModelClient {
  readonly requests: ReasoningModelRequest<unknown>[] = [];
  constructor(
    private readonly preferredPattern: RegExp,
    private readonly blockerPattern: RegExp,
  ) {}

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    this.requests.push(request as ReasoningModelRequest<unknown>);
    const payload = JSON.parse(request.userPrompt) as {
      satisfiedCriteriaIds: string[];
      successCriteria: { id: string; required: boolean }[];
      allowedActions: string[];
      currentPage: { interactiveElements: PromptPageElement[] };
    };

    const requiredIds = payload.successCriteria.filter((c) => c.required).map((c) => c.id);
    const allRequiredSatisfied = requiredIds.every((id) => payload.satisfiedCriteriaIds.includes(id));
    if (allRequiredSatisfied && payload.allowedActions.includes("stop_success")) {
      return this.result({ action: "stop_success", reason: "Required criteria satisfied.", confidence: 0.95 });
    }

    const isReachable = (el: PromptPageElement) => el.visible !== false && !el.disabled && !el.covered;

    const preferredTarget = payload.currentPage.interactiveElements.find(
      (el) => isReachable(el) && this.preferredPattern.test(el.accessibleName),
    );
    if (preferredTarget && payload.allowedActions.includes("click")) {
      return this.result({
        action: "click",
        targetElementId: preferredTarget.id,
        reason: `"${preferredTarget.accessibleName}" is uncovered and matches the objective.`,
        confidence: 0.9,
      });
    }

    const uncoveredBlocker = payload.currentPage.interactiveElements.find(
      (el) => isReachable(el) && this.blockerPattern.test(el.accessibleName),
    );
    if (uncoveredBlocker && payload.allowedActions.includes("click")) {
      return this.result({
        action: "click",
        targetElementId: uncoveredBlocker.id,
        reason: `Clearing blocking control "${uncoveredBlocker.accessibleName}" before the objective control is reachable.`,
        confidence: 0.7,
      });
    }

    return this.result({ action: "stop_failure", reason: "No reachable control available.", confidence: 0.5 });
  }

  private result<TPayload>(payload: ClaudeDecisionPayload): ReasoningModelResult<TPayload> {
    return { parsedOutput: payload as unknown as TPayload, stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } };
  }
}

/**
 * A model that ignores `covered` entirely and always clicks the first visible control
 * matching `pattern` -- the same class of decision the real incident reported (selecting a
 * visually-present control without regard to whether it was actually reachable).
 */
class CoverageBlindModelClient implements ReasoningModelClient {
  constructor(private readonly pattern: RegExp) {}

  async createDecision<TPayload>(request: ReasoningModelRequest<TPayload>): Promise<ReasoningModelResult<TPayload>> {
    const payload = JSON.parse(request.userPrompt) as {
      allowedActions: string[];
      currentPage: { interactiveElements: PromptPageElement[] };
    };
    const target = payload.currentPage.interactiveElements.find(
      (el) => el.visible !== false && !el.disabled && this.pattern.test(el.accessibleName),
    );
    if (target && payload.allowedActions.includes("click")) {
      return {
        parsedOutput: {
          action: "click",
          targetElementId: target.id,
          reason: `Selected "${target.accessibleName}" (coverage not considered).`,
          confidence: 0.9,
        } as unknown as TPayload,
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    }
    return {
      parsedOutput: { action: "stop_failure", reason: "No matching control.", confidence: 0.5 } as unknown as TPayload,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  }
}

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
    schemaVersion: "1.4.0",
    taskId: "covered-control-preference",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["cta_clicks", "data_layer_evidence", "ga4_network_events", "errors"],
    limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "scroll", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.4.0",
    ...overrides,
  };
}

const FORCE_VERIFIER_CONFIG = { minScore: 1.1 };

const SUMMARY_OBJECTIVE =
  "Entrez dans le configurateur, acceptez ce qui doit l'être pour débloquer la page, activez le contrôle dont " +
  "le but sémantique est de révéler le résumé de la configuration terminée, vérifiez que le résumé est " +
  "affiché, puis arrêtez-vous avec succès.";

test("REGRESSION: a covering overlay's own dismiss control is preferred while it blocks the page, then the now-uncovered objective control is correctly selected", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr-overlay.html`,
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

    const modelClient = new CoveredAwareModelClient(/r.sum./i, /tout accepter/i);
    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient });
    const semanticVerifier = new ClaudeSemanticCriterionVerifier({ config: VERIFIER_CONFIG, modelClient: new RouteVerifierModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning, semanticVerifier });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 2, "expected exactly two clicks: dismiss the overlay, then the now-reachable Resume-equivalent control");
    assert.match(clicks[0]?.ctaText ?? "", /tout accepter/i);
    assert.match(clicks[1]?.ctaText ?? "", /r.sum./i);

    // Prove the model's first request actually saw both controls as reachable/unreachable
    // -- i.e. covered genuinely reached the prompt payload, not just internal engine state.
    const firstPrompt = JSON.parse(modelClient.requests[0]?.userPrompt ?? "{}") as {
      currentPage: { interactiveElements: PromptPageElement[] };
    };
    const summaryEntry = firstPrompt.currentPage.interactiveElements.find((el) => /r.sum./i.test(el.accessibleName));
    const acceptEntry = firstPrompt.currentPage.interactiveElements.find((el) => /tout accepter/i.test(el.accessibleName));
    assert.ok(summaryEntry, "the covered Resume-equivalent control must still reach the prompt (visible, just not clickable yet)");
    assert.equal(summaryEntry?.covered, true);
    assert.ok(acceptEntry);
    assert.equal(acceptEntry?.covered, undefined, "the overlay's own dismiss control must not itself be reported as covered");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION (failure mode being fixed): a model that ignores coverage and clicks the visually-present but covered control fails to advance, exactly matching the reported action_execution_error", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${baseUrl}/configurator-terminal-fr-overlay.html`,
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
      limits: { maxSteps: 3, maxBacktracks: 0, maxRepeatedActions: 3 },
    });

    const reasoning = new ClaudeReasoningProvider({ config: REASONING_CONFIG, modelClient: new CoverageBlindModelClient(/r.sum./i) });
    const response = await runTask({ page, task, reasoning });

    assert.notEqual(response.status, "success", "a coverage-blind decision must not be rescued into a success by the engine");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
