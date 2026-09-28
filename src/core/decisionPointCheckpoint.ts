import type { Observation } from "../types/task-response.js";
import { computeDecisionPointFingerprint } from "./routeMemory.js";
import { sanitizePageIdentity, buildSemanticSignature } from "./journeyMemory/sanitizer.js";

/**
 * Lightweight in-run decision-point checkpoint (production incident
 * run_b3743f06-1667-443e-b9fa-e804aa5caecf, Fix 3 -- see CLAUDE.md and docs/architecture.md).
 * Deliberately NOT a general webpage/HTML/DOM cache and NOT a second memory system: this is
 * a small, bounded, in-process-RAM-only addition inside the existing single-run RunState,
 * alongside RouteMemory/branchHistory (see RunState.checkpoints below) -- discarded at
 * branch completion or run end, never persisted to Redis, never surfaced on the
 * task-response wire schema. It reuses computeDecisionPointFingerprint (routeMemory.ts) and
 * sanitizePageIdentity/buildSemanticSignature (journeyMemory/sanitizer.ts) rather than
 * inventing new sanitization/fingerprinting.
 *
 * Guidance/recognition only: this object never independently verifies a milestone and never
 * forces an action on its own -- it is consulted only as one input into the existing
 * recovery order (browser-history restoration first, then live-evidence comparison, then
 * Fix 2's readiness polling, then, as a last resort, reconstruction via a fresh navigation
 * to this checkpoint's own already-sanitized/allowed URL -- see docs/journey-memory.md).
 */
export interface DecisionPointCheckpoint {
  branchId: string;
  capturedAtStepIndex: number;
  timestamp: string;
  /** computeDecisionPointFingerprint(observation) -- routeMemory.ts. Never itself a URL/query/fragment. */
  fingerprint: string;
  sanitizedUrl: { registrableDomain: string; normalizedPath: string; semanticSignature: string; extractedFields?: Record<string, string> };
  market?: string;
  /** Bounded, sanitized title-vocabulary tokens (never raw title text beyond this signature). */
  titleConcepts: string;
  activeMilestoneIds: string[];
  remainingMilestoneConcepts: string[];
  /** RunState.activeSurface at capture time -- "main"/adopted surface id/in-document surface id. */
  activeSurfaceIdentity: string;
  stableHeadingConcepts: string[];
  /** Semantic candidate meanings visible at this decision point -- role/accessibleName pairs only, never raw element ids/handles. */
  candidateMeanings: { role: string; accessibleName: string }[];
  scrollY?: number;
  candidatesAlreadyAttempted: string[];
  routeDepth: number;
  evidenceSource: "observed";
  confidence: number;
}

/** Bounded: never more than this many live checkpoints tracked at once (per-run, RAM-only). */
export const MAX_DECISION_POINT_CHECKPOINTS = 20;

export function captureDecisionPointCheckpoint(params: {
  branchId: string;
  stepIndex: number;
  observation: Observation;
  activeSurfaceIdentity: string;
  activeMilestoneIds: string[];
  remainingMilestoneConcepts: string[];
  candidatesAlreadyAttempted: string[];
  routeDepth: number;
  scrollY?: number;
  /** Caller-supplied (e.g. task.metadata.market, the same source engine.ts already reads for Journey Memory) -- this module never infers a market on its own. */
  market?: string;
}): DecisionPointCheckpoint {
  const {
    branchId,
    stepIndex,
    observation,
    activeSurfaceIdentity,
    activeMilestoneIds,
    remainingMilestoneConcepts,
    candidatesAlreadyAttempted,
    routeDepth,
    scrollY,
    market,
  } = params;

  const semanticText = [observation.title, ...(observation.notableText ?? [])];
  const sanitizedUrl = sanitizePageIdentity(observation.url, semanticText);
  const headingConcepts = buildSemanticSignature(observation.notableText ?? []);

  return {
    branchId,
    capturedAtStepIndex: stepIndex,
    timestamp: new Date().toISOString(),
    fingerprint: computeDecisionPointFingerprint(observation),
    sanitizedUrl,
    ...(market ? { market } : {}),
    titleConcepts: buildSemanticSignature([observation.title]),
    activeMilestoneIds: [...activeMilestoneIds],
    remainingMilestoneConcepts: [...remainingMilestoneConcepts],
    activeSurfaceIdentity,
    stableHeadingConcepts: headingConcepts ? headingConcepts.split(" ") : [],
    candidateMeanings: observation.interactiveElements
      .filter((el) => el.visible !== false)
      .map((el) => ({ role: el.role, accessibleName: el.accessibleName })),
    ...(scrollY !== undefined ? { scrollY } : {}),
    candidatesAlreadyAttempted: [...candidatesAlreadyAttempted],
    routeDepth,
    evidenceSource: "observed",
    confidence: 1,
  };
}

/** True when two checkpoints describe the same decision point (same fingerprint, same branch) -- used to dedupe rather than accumulate redundant entries. */
export function isEquivalentCheckpoint(a: DecisionPointCheckpoint, b: DecisionPointCheckpoint): boolean {
  return a.branchId === b.branchId && a.fingerprint === b.fingerprint;
}
