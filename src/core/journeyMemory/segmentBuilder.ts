import type { StepLog } from "../../types/task-response.js";
import type {
  AlternativeCandidateAttemptDiagnostic,
  RecoveryAttemptDiagnostic,
  RouteAttemptDiagnostic,
} from "../../types/recovery.js";
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
 * Journey Memory recovery-segment-gap fix (production incident
 * run_b3743f06-1667-443e-b9fa-e804aa5caecf, decision_point_restore_failed): the normalized
 * shape every recovery diagnostic source below is reduced to before becoming a
 * RecoveryMemorySegment. `restored` is the single true/false verdict a segment's
 * restorationResult/finalRecoveryOutcome/confidence are all derived from -- never
 * independently re-decided per source.
 */
interface NormalizedRecoveryInput {
  segmentSource: "recovery_attempt" | "route_attempt" | "alternative_candidate";
  stepIndex: number;
  anchorCriterionId: string;
  restored: boolean;
  failureReason?: string;
}

function normalizeRecoveryAttempts(attempts: RecoveryAttemptDiagnostic[]): NormalizedRecoveryInput[] {
  return attempts.map((attempt) => ({
    segmentSource: "recovery_attempt",
    stepIndex: attempt.stepIndex,
    anchorCriterionId: attempt.anchorCriterionId,
    restored: attempt.restored,
    failureReason: attempt.failureReason,
  }));
}

/**
 * Only the two TERMINAL route-lifecycle transitions ever produce a recovery segment here
 * ("anchor_restored" -- a verified successful branch-return restoration; "candidate_exhausted"
 * with a failure-shaped terminationReason -- the branch-return-hop path that actually throws
 * decision_point_restore_failed in core/loop.ts, and which RecoveryAttemptDiagnostic alone
 * never captured). The other, purely in-progress RouteStatus values (candidate_selected,
 * route_active, route_progressing, route_blocked, anchor_restore_required) are never
 * themselves eligible -- they describe a route still in flight, not yet a restoration
 * outcome, and would only add noise a caller could mistake for independent evidence.
 */
function normalizeRouteAttempts(attempts: RouteAttemptDiagnostic[]): NormalizedRecoveryInput[] {
  const normalized: NormalizedRecoveryInput[] = [];
  for (const attempt of attempts) {
    if (attempt.status === "anchor_restored") {
      normalized.push({
        segmentSource: "route_attempt",
        stepIndex: attempt.stepIndex,
        anchorCriterionId: attempt.anchorCriterionId,
        restored: true,
      });
    } else if (attempt.status === "candidate_exhausted" && attempt.terminationReason) {
      normalized.push({
        segmentSource: "route_attempt",
        stepIndex: attempt.stepIndex,
        anchorCriterionId: attempt.anchorCriterionId,
        restored: false,
        failureReason: attempt.terminationReason,
      });
    }
  }
  return normalized;
}

function normalizeAlternativeCandidateAttempts(
  attempts: AlternativeCandidateAttemptDiagnostic[],
): NormalizedRecoveryInput[] {
  return attempts.map((attempt) => ({
    segmentSource: "alternative_candidate",
    stepIndex: attempt.stepIndex,
    anchorCriterionId: attempt.anchorCriterionId,
    restored: attempt.progressResult === "advanced",
    failureReason: attempt.progressResult === "advanced" ? undefined : attempt.progressResult,
  }));
}

function dedupeKey(input: NormalizedRecoveryInput): string {
  return `${input.anchorCriterionId}::${input.stepIndex}::${input.restored}`;
}

/**
 * Fine-grained recovery/failure segments (binding contract §5), built from all three
 * diagnostic sources a branch-return-hop restoration can actually write to (see
 * segmentBuilder module doc and docs/journey-memory.md): RunState.recoveryAttemptDiagnostics
 * (the pre-existing anchor-hop path), and, closing the gap that let the production
 * decision_point_restore_failed incident go unrecorded, RunState.routeAttemptDiagnostics and
 * RunState.alternativeCandidateDiagnostics (the branch-return-hop path that actually throws
 * that finish reason). Every source is normalized into the same internal shape first (see
 * NormalizedRecoveryInput above) and tagged with segmentSource so a consumer can tell which
 * source produced a given record; an equivalent segment reported by more than one source
 * (the same anchor/step/outcome) is deduped, first-source-wins. A failed/unverified segment
 * never overwrites a verified success and is never itself treated as stronger evidence --
 * see this function's confidence/finalRecoveryOutcome derivation, and retention.ts's
 * applyOutcomePrecedence (called downstream, unchanged) for the cross-run precedence rules
 * that still apply once these segments reach write-back.
 */
export function buildRecoverySegments(params: {
  attempts: RecoveryAttemptDiagnostic[];
  routeAttempts?: RouteAttemptDiagnostic[];
  alternativeCandidateAttempts?: AlternativeCandidateAttemptDiagnostic[];
  steps: StepLog[];
  runId: string;
  registrableDomain: string;
  market?: string;
  evidenceTier: import("../../types/journeyMemory.js").JourneyMemoryTier;
  schemaVersion: string;
}): RecoveryMemorySegment[] {
  const {
    attempts,
    routeAttempts,
    alternativeCandidateAttempts,
    steps,
    runId,
    registrableDomain,
    market,
    evidenceTier,
    schemaVersion,
  } = params;

  const normalized = [
    ...normalizeRecoveryAttempts(attempts),
    ...normalizeRouteAttempts(routeAttempts ?? []),
    ...normalizeAlternativeCandidateAttempts(alternativeCandidateAttempts ?? []),
  ];

  const seen = new Set<string>();
  const deduped: NormalizedRecoveryInput[] = [];
  for (const input of normalized) {
    const key = dedupeKey(input);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(input);
  }

  return deduped.map((input) => {
    const step = steps.find((s) => s.stepIndex === input.stepIndex) ?? steps[steps.length - 1];
    const restored = input.restored;
    return {
      kind: "recovery" as const,
      id: nextId(runId, "rec"),
      schemaVersion,
      segmentSource: input.segmentSource,
      failedCandidate: { actionType: "click", semanticLabel: input.anchorCriterionId },
      sourcePage: step
        ? sanitizePageIdentity(step.currentUrl, pageSemanticText(step.observation))
        : { registrableDomain, normalizedPath: "/", semanticSignature: "" },
      resultingBranchOutcome: restored ? "recovered" : "unknown",
      failureType: input.failureReason ?? "unknown",
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
