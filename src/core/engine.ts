import type { Page } from "playwright";
import type { ResolvedTaskRequest, TaskRequest } from "../types/task-request.js";
import type {
  Captures,
  DomainDiscoveryDiagnostics,
  EngineAssessment,
  StepLog,
  TaskResponse,
} from "../types/task-response.js";
import type { ReasoningProvider } from "../reasoning/reasoningProvider.js";
import { MockReasoningProvider } from "../reasoning/mockReasoningProvider.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import { RunState } from "./state.js";
import { runStep, type TerminalStatus } from "./loop.js";
import { getMissingRequiredCriteriaIds } from "./successEvaluator.js";
import { checkNavigationAllowed } from "../safety/index.js";
import { attachGa4NetworkCapture } from "../capture-modules/ga4NetworkEvents.js";
import { attachErrorCapture, recordDiagnosticError } from "../capture-modules/errors.js";
import { readInitialNavigationTimeoutMs } from "../config/initialNavigationConfig.js";
import { readActionNavigationTimeoutMs } from "../config/actionNavigationConfig.js";
import { assessUrlSafety } from "../discovery/hostSafety.js";
import { runDomainDiscovery, type DomainDiscoveryResult } from "../discovery/domainDiscovery.js";

const ENGINE_VERSION = "0.1.0-poc";

function toDomainDiscoveryDiagnostics(
  discovery: DomainDiscoveryResult,
  allowedDomainsUsed: string[],
): DomainDiscoveryDiagnostics {
  return {
    version: "1.0.0",
    startHostname: discovery.startHostname,
    startRegistrableDomain: discovery.startRegistrableDomain,
    finalUrl: discovery.finalUrl,
    redirectChain: discovery.redirectChain,
    ...(discovery.canonicalUrl ? { canonicalUrl: discovery.canonicalUrl } : {}),
    trustedDomains: discovery.trustedDomains,
    ...(discovery.externalCandidates.length > 0 ? { externalCandidates: discovery.externalCandidates } : {}),
    ...(discovery.rejectedCandidates.length > 0 ? { rejectedCandidates: discovery.rejectedCandidates } : {}),
    proposedAllowedDomains: discovery.proposedAllowedDomains,
    allowedDomainsUsed,
    ...(discovery.blockedReason ? { blockedReason: discovery.blockedReason } : {}),
  };
}

export async function runTask(params: {
  page: Page;
  task: TaskRequest;
  reasoning?: ReasoningProvider;
  initialNavigationTimeoutMs?: number;
  actionNavigationTimeoutMs?: number;
  /**
   * Optional, opt-in bounded model call used only as a fallback for a semantic_page_match
   * criterion the deterministic lexical evaluator could not already satisfy (most notably
   * across objective-language/page-language pairs) -- see
   * src/reasoning/semanticCriterionVerifier.ts. Entirely absent by default: every existing
   * caller that doesn't pass this gets byte-for-byte the same deterministic-only
   * evaluation as before this parameter existed.
   */
  semanticVerifier?: SemanticCriterionVerifier;
}): Promise<TaskResponse> {
  const { page, task, semanticVerifier } = params;
  const state = new RunState();
  const captures: Captures = {};
  // Resolved once per run (rather than left to loop.ts's per-step default) so the same
  // provider instance -- and therefore its decision log -- is used for every step, which
  // diagnostics.reasoningProvider aggregation below depends on.
  const reasoning = params.reasoning ?? new MockReasoningProvider();
  // Overridable per-call for tests; the real API server resolves these once at startup
  // (src/api/server.ts) from INITIAL_NAVIGATION_TIMEOUT_MS / ACTION_NAVIGATION_TIMEOUT_MS
  // so a misconfigured value fails clearly at boot rather than per-run.
  const initialNavigationTimeoutMs = params.initialNavigationTimeoutMs ?? readInitialNavigationTimeoutMs();
  const actionNavigationTimeoutMs = params.actionNavigationTimeoutMs ?? readActionNavigationTimeoutMs();

  // startUrl is always required to be http/https and parseable, defense-in-depth alongside
  // the request schema's own "format": "uri" check (this engine can be called directly, as
  // the test suite does, bypassing schema validation entirely). The caller's own explicit
  // startUrl is exempt from the localhost/loopback/link-local rejections below -- those exist
  // to stop preflight from being fooled into trusting a host it *discovers* (a redirect, a
  // canonical tag, a page link), not to forbid a deliberate local/dev target the caller
  // chose on purpose (this repo's own fixtures run on 127.0.0.1). See discovery/hostSafety.ts.
  const startUrlSafety = assessUrlSafety(task.startUrl, { allowLoopbackAndLinkLocal: true });
  if (!startUrlSafety.safe) {
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        category: "safety_guard_stop",
        severity: "critical",
        pageUrl: task.startUrl,
        message: `startUrl is unsafe (${startUrlSafety.reason}); run blocked before navigation.`,
        recoverable: false,
        stoppedRun: true,
      });
    }
    return buildTerminalResponse({
      task,
      state,
      captures,
      steps: [],
      status: "blocked",
      finishReason: "domain_blocked",
      statusReason: `startUrl is unsafe (${startUrlSafety.reason})`,
      finalUrl: task.startUrl,
      reasoning,
      semanticVerifier,
    });
  }

  // A caller who explicitly supplies allowedDomains is still held to it immediately: if
  // startUrl itself isn't covered, the run is blocked before ever opening a page, same as
  // before preflight discovery existed. When allowedDomains is omitted, there is nothing to
  // check yet -- discovery (below) determines the initial trusted set from the navigation
  // itself.
  if (task.allowedDomains && task.allowedDomains.length > 0 && !checkNavigationAllowed(task.startUrl, task.allowedDomains)) {
    if (task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        category: "safety_guard_stop",
        severity: "critical",
        pageUrl: task.startUrl,
        message: "startUrl is outside allowedDomains; run blocked before navigation.",
        recoverable: false,
        stoppedRun: true,
      });
    }
    return buildTerminalResponse({
      task,
      state,
      captures,
      steps: [],
      status: "blocked",
      finishReason: "domain_blocked",
      statusReason: "startUrl is outside allowedDomains",
      finalUrl: task.startUrl,
      reasoning,
      semanticVerifier,
    });
  }

  // GA4-style requests (and, when requested, page errors/console errors/failed network
  // requests) can fire on the very first page load, so listeners must be attached before
  // that first navigation, and only when the task actually asked for them.
  const detachGa4Capture = task.captureModules.includes("ga4_network_events")
    ? attachGa4NetworkCapture(page, captures, () => state.stepCount)
    : undefined;
  const detachErrorCapture = task.captureModules.includes("errors")
    ? attachErrorCapture(page, captures, () => state.stepCount)
    : undefined;

  try {
    // Deterministic preflight domain discovery (src/discovery) runs before the Claude-driven
    // navigation loop: it performs the engine's one-off initial navigation itself (so it can
    // inspect the actual redirect chain), then proposes a trusted allowedDomains set from the
    // exact start host, the redirect landing host, and any hostname sharing their PSL
    // registrable domain found via the canonical URL or on-page links -- never from an
    // external-domain link alone. See docs/architecture.md "Preflight domain discovery".
    const { navigation, discovery } = await runDomainDiscovery({
      page,
      startUrl: task.startUrl,
      objective: task.objective,
      journeyType: task.journeyType,
      callerAllowedDomains: task.allowedDomains,
      timeoutMs: initialNavigationTimeoutMs,
    });

    if (navigation.status === "failed") {
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          category: "navigation_failure",
          severity: "critical",
          pageUrl: task.startUrl,
          message: navigation.message ?? "Initial navigation failed.",
          recoverable: false,
          stoppedRun: true,
        });
      }
      return buildTerminalResponse({
        task,
        state,
        captures,
        steps: [],
        status: "failure",
        finishReason: "initial_navigation_error",
        statusReason: navigation.message ?? "Initial navigation failed.",
        finalUrl: navigation.url,
        reasoning,
        semanticVerifier,
      });
    }

    if (navigation.status === "recovered" && task.captureModules.includes("errors")) {
      recordDiagnosticError(captures, {
        category: "navigation_failure",
        severity: "warning",
        pageUrl: navigation.url,
        message: navigation.message ?? "Initial navigation timed out but recovered.",
        recoverable: true,
        stoppedRun: false,
      });
    }

    if (!discovery || discovery.blockedReason) {
      const reason = discovery?.blockedReason ?? "Preflight domain discovery could not be completed.";
      if (task.captureModules.includes("errors")) {
        recordDiagnosticError(captures, {
          category: "safety_guard_stop",
          severity: "critical",
          pageUrl: navigation.url,
          message: reason,
          recoverable: false,
          stoppedRun: true,
        });
      }
      return buildTerminalResponse({
        task,
        state,
        captures,
        steps: [],
        status: "blocked",
        finishReason: "domain_blocked",
        statusReason: reason,
        finalUrl: navigation.url,
        reasoning,
        semanticVerifier,
        domainDiscovery: discovery,
      });
    }

    const allowedDomainsUsed = discovery.trustedDomains.map((entry) => entry.hostname);
    const effectiveTask: ResolvedTaskRequest = { ...task, allowedDomains: allowedDomainsUsed };

    const steps: StepLog[] = [];
    let terminal: TerminalStatus | undefined;
    let finishReason = "loop_exhausted";

    while (!terminal) {
      const outcome = await runStep({
        page,
        task: effectiveTask,
        state,
        captures,
        reasoning,
        actionNavigationTimeoutMs,
        semanticVerifier,
      });
      steps.push(outcome.stepLog);
      if (outcome.terminal) {
        terminal = outcome.terminal;
        finishReason = outcome.finishReason ?? terminal;
      }
    }

    const lastStep = steps[steps.length - 1];
    return buildTerminalResponse({
      task: effectiveTask,
      state,
      captures,
      steps,
      status: terminal,
      finishReason,
      statusReason: finishReason,
      finalUrl: lastStep ? lastStep.currentUrl : task.startUrl,
      reasoning,
      semanticVerifier,
      domainDiscovery: discovery,
    });
  } finally {
    detachGa4Capture?.();
    detachErrorCapture?.();
  }
}

function buildTerminalResponse(params: {
  task: TaskRequest;
  state: RunState;
  captures: Captures;
  steps: StepLog[];
  status: TerminalStatus;
  finishReason: string;
  statusReason: string;
  finalUrl: string;
  reasoning: ReasoningProvider;
  domainDiscovery?: DomainDiscoveryResult;
  semanticVerifier?: SemanticCriterionVerifier;
}): TaskResponse {
  const {
    task,
    state,
    captures,
    steps,
    status,
    finishReason,
    statusReason,
    finalUrl,
    reasoning,
    domainDiscovery,
    semanticVerifier,
  } = params;
  const lastStep = steps[steps.length - 1];
  // Independently verified, never derived from status alone: objectiveAchieved must
  // reflect that every required success criterion (schema default: required) was
  // actually satisfied, re-checked here against the run's own accumulated
  // satisfiedCriteriaIds rather than trusted from the terminal status the loop reported.
  const missingRequiredCriteriaIds = getMissingRequiredCriteriaIds(task.successCriteria, state.satisfiedCriteriaIds);
  const objectiveAchieved = status === "success" && missingRequiredCriteriaIds.length === 0;

  const engineAssessment: EngineAssessment = {
    objectiveAchieved,
    confidence: objectiveAchieved ? 1 : 0,
    summary: objectiveAchieved
      ? "The engine reached a step where all required success criteria were satisfied and selected stop_success."
      : status === "success"
        ? "The engine selected stop_success but independent verification found required success criteria still unsatisfied; the objective is not treated as achieved."
        : `The run ended with status "${status}" (${finishReason}).`,
    ...(lastStep ? { satisfiedSuccessCriteriaIds: lastStep.progress.satisfiedCriteriaIds } : {}),
  };

  const reasoningProviderDiagnostics = reasoning.getUsageDiagnostics?.();
  const semanticVerifierDiagnostics = semanticVerifier?.getUsageDiagnostics?.();
  const domainDiscoveryDiagnostics = domainDiscovery
    ? toDomainDiscoveryDiagnostics(domainDiscovery, task.allowedDomains ?? domainDiscovery.proposedAllowedDomains)
    : undefined;

  return {
    schemaVersion: "1.4.0",
    taskId: task.taskId,
    status,
    statusReason,
    startUrl: task.startUrl,
    finalUrl,
    steps,
    captures,
    engineAssessment,
    diagnostics: {
      stepCount: state.stepCount,
      backtrackCount: state.backtrackCount,
      totalDurationMs: Date.now() - state.startedAtMs,
      finishReason,
      engineVersion: ENGINE_VERSION,
      ...(missingRequiredCriteriaIds.length > 0 ? { missingRequiredCriteriaIds } : {}),
      ...(reasoningProviderDiagnostics ? { reasoningProvider: reasoningProviderDiagnostics } : {}),
      ...(domainDiscoveryDiagnostics ? { domainDiscovery: domainDiscoveryDiagnostics } : {}),
      ...(semanticVerifierDiagnostics ? { semanticVerifier: semanticVerifierDiagnostics } : {}),
    },
  };
}
