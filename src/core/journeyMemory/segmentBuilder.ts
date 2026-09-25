import type { StepLog } from "../../types/task-response.js";
import type { RecoveryAttemptDiagnostic } from "../../types/recovery.js";
import type { ForwardMemorySegment, JourneyMemorySegment, RecoveryMemorySegment } from "../../types/journeyMemory.js";
import { sanitizePageIdentity } from "./sanitizer.js";

let counter = 0;
function nextId(runId: string, prefix: string): string {
  counter += 1;
  return `${prefix}:${runId}:${counter}`;
}

function pageSemanticText(observation: StepLog["observation"]): string[] {
  return [
    observation.title,
    ...(observation.notableText ?? []),
    ...observation.interactiveElements.map((el) => el.accessibleName),
  ];
}

function actionSemanticLabel(step: StepLog): string {
  const action = step.selectedAction;
  if (action.type === "click") {
    const el = step.observation.interactiveElements.find((e) => e.id === action.target);
    return el ? `${el.role}::${el.accessibleName}` : `click::${action.target ?? "unknown"}`;
  }
  if (action.type === "navigate") {
    return `navigate::${action.target ?? "unknown"}`;
  }
  return action.type;
}

/**
 * Fine-grained forward segments (binding contract §5): one per step transition whose
 * action produced observed forward progress (the browser's own URL genuinely changed --
 * never inferred from the reasoning layer's own self-report). A partially successful run
 * still contributes every such independently-verified segment, not only ones from a fully
 * completed run.
 */
export function buildForwardSegments(params: {
  steps: StepLog[];
  runId: string;
  registrableDomain: string;
  market?: string;
  objective: string;
  evidenceTier: import("../../types/journeyMemory.js").JourneyMemoryTier;
  schemaVersion: string;
}): ForwardMemorySegment[] {
  const { steps, runId, registrableDomain, market, objective, evidenceTier, schemaVersion } = params;
  const segments: ForwardMemorySegment[] = [];

  for (let i = 0; i < steps.length - 1; i += 1) {
    const current = steps[i];
    const next = steps[i + 1];
    if (!current || !next) continue;
    if (current.selectedAction.type !== "click" && current.selectedAction.type !== "navigate") {
      continue;
    }
    if (current.currentUrl === next.currentUrl) {
      continue;
    }
    const satisfiedGrew = next.progress.satisfiedCriteriaIds.length > current.progress.satisfiedCriteriaIds.length;
    const newlySatisfied = next.progress.satisfiedCriteriaIds.filter(
      (id) => !current.progress.satisfiedCriteriaIds.includes(id),
    );

    segments.push({
      kind: "forward",
      id: nextId(runId, "fwd"),
      schemaVersion,
      sourcePage: sanitizePageIdentity(current.currentUrl, pageSemanticText(current.observation)),
      action: { actionType: current.selectedAction.type, semanticLabel: actionSemanticLabel(current) },
      destinationPage: sanitizePageIdentity(next.currentUrl, pageSemanticText(next.observation)),
      verifiedMilestoneIntent: newlySatisfied.length > 0 ? newlySatisfied.join(", ") : objective,
      outcome: satisfiedGrew ? "success" : "partial",
      confidence: satisfiedGrew ? 0.9 : 0.5,
      evidenceTier,
      routePosition: i,
      timestamp: next.timestamp,
      provenance: { runId, registrableDomain, ...(market ? { market } : {}) },
    });
  }

  return segments;
}

/**
 * Fine-grained recovery/failure segments (binding contract §5), built from
 * RunState.recoveryAttemptDiagnostics -- the same source of truth
 * diagnostics.recovery.attempts already reports on the wire, never a second, independent
 * tracking mechanism.
 */
export function buildRecoverySegments(params: {
  attempts: RecoveryAttemptDiagnostic[];
  steps: StepLog[];
  runId: string;
  registrableDomain: string;
  market?: string;
  evidenceTier: import("../../types/journeyMemory.js").JourneyMemoryTier;
  schemaVersion: string;
}): RecoveryMemorySegment[] {
  const { attempts, steps, runId, registrableDomain, market, evidenceTier, schemaVersion } = params;
  return attempts.map((attempt) => {
    const step = steps.find((s) => s.stepIndex === attempt.stepIndex) ?? steps[steps.length - 1];
    const restored = attempt.restored;
    return {
      kind: "recovery" as const,
      id: nextId(runId, "rec"),
      schemaVersion,
      failedCandidate: { actionType: "click", semanticLabel: attempt.anchorCriterionId },
      sourcePage: step
        ? sanitizePageIdentity(step.currentUrl, pageSemanticText(step.observation))
        : { registrableDomain, normalizedPath: "/", semanticSignature: "" },
      resultingBranchOutcome: restored ? "recovered" : "unknown",
      failureType: attempt.failureReason ?? "unknown",
      restorationResult: restored ? "decision_point_restored" : "go_back_failed",
      knownExhaustedCandidate: !restored,
      movedCloserToObjective: restored,
      finalRecoveryOutcome: restored ? "recovered" : "not_recovered",
      failureCount: 1,
      confidence: restored ? 0.7 : 0.3,
      evidenceTier,
      timestamp: step?.timestamp ?? new Date().toISOString(),
      provenance: { runId, registrableDomain, ...(market ? { market } : {}) },
    };
  });
}

export function combineSegments(
  forward: ForwardMemorySegment[],
  recovery: RecoveryMemorySegment[],
): JourneyMemorySegment[] {
  return [...forward, ...recovery];
}
