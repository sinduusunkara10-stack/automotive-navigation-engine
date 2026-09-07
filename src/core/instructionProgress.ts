import type { SuccessCriterion } from "../types/task-request.js";
import type { Observation } from "../types/task-response.js";
import type { SelectedAction } from "../types/actions.js";
import { parseOrderedInstructions } from "../reasoning/instructionParser.js";
import { objectiveTokenCoverage } from "../discovery/relevance.js";

// Conservative: an instruction is only marked complete when the post-action evidence shares
// a meaningful fraction of that specific instruction's own vocabulary -- "the action
// succeeded" or "something on the page changed" is deliberately never enough on its own (see
// advanceInternalInstructionProgress below). Tuned well above a single incidental
// shared-token collision, but low enough that a short instruction phrase (2-4 meaningful
// tokens once stopwords are removed) can still be recognised from a realistic control label
// or destination page that only echoes part of its wording.
export const INSTRUCTION_EVIDENCE_MIN_COVERAGE = 0.3;

// Only these two action types carry generic evidence of *which* control/destination the run
// actually acted on (a click's target, a navigate's destination). scroll/wait/go_back/capture
// never advance internal instruction progress, however successful they were -- there is
// nothing target-level to attribute completion to.
const PROGRESSING_ACTION_TYPES: ReadonlySet<SelectedAction["type"]> = new Set(["click", "navigate"]);

export interface LastDispatchedActionEvidence {
  type: SelectedAction["type"];
  success: boolean;
  targetAccessibleName?: string;
  resultingUrl?: string;
}

/**
 * REGRESSION source (the real n8n request shape): a caller supplies exactly one
 * semantic_page_match successCriterion whose description is the caller's complete
 * multiline ordered objective, not one criterion per instruction (see
 * src/reasoning/instructionParser.ts). satisfiedCriteriaIds (core/successEvaluator.ts) can
 * then only ever gate the *whole* criterion at once -- far too coarse to tell the reasoning
 * layer which of the caller's several instructions is still outstanding. This function is
 * the generic, evidence-based ratchet that fills that gap for exactly that shape, without
 * requiring the caller to restructure successCriteria and without any request/response
 * schema change: it mutates `internalInstructionProgress` (keyed by criterion id, value =
 * how many of that criterion's parsed instruction segments are conservatively confirmed
 * complete so far), read back by computeInstructionProgress (src/reasoning/promptBuilder.ts)
 * to compute the same completed/earliest-unfinished/pending/terminal partition the model is
 * shown every reasoning call.
 *
 * Deliberately a one-step-deferred, evidence-only check: the caller (src/core/loop.ts)
 * invokes this at the top of the *next* runStep call, once a fresh, genuinely post-action
 * Observation already exists for other reasons (buildObservation is always called there
 * anyway) -- so this never costs an extra page query of its own, and by construction only
 * ever evaluates a single already-completed action against the single earliest-unfinished
 * instruction segment that action was dispatched to advance.
 *
 * Conservative by design, matching the "monotonic ratchet" requirement:
 * - Only a successful "click"/"navigate" action is even considered (PROGRESSING_ACTION_TYPES)
 *   -- a mechanically successful scroll/wait, or any failed action, can never advance
 *   progress, satisfying "click success alone does not complete an instruction" and "failed
 *   action does not advance progress".
 * - Evidence must clear INSTRUCTION_EVIDENCE_MIN_COVERAGE against the *specific* text of the
 *   single earliest-unfinished segment for that criterion -- ambiguous evidence (the action
 *   succeeded and something changed, but it shares no real vocabulary with that instruction)
 *   never advances anything, satisfying "ambiguous post-action evidence does not advance".
 * - At most one segment, for at most one criterion, ever advances per call -- "one action
 *   must not silently complete multiple ordered instructions".
 * - The final ("stop") segment of a parsed instruction list is never advanced here at all --
 *   it is only ever completed by the real, caller-supplied successCriteria evaluation (see
 *   computeInstructionProgress), so internal instruction progress is guidance for action
 *   selection only, never a replacement public success criterion.
 * - Nothing here is ever reset: internalInstructionProgress only ever increases, so progress
 *   survives full navigation, same-page DOM/modal/drawer changes, and new tabs exactly like
 *   satisfiedCriteriaIds already does.
 */
export function advanceInternalInstructionProgress(params: {
  successCriteria: readonly SuccessCriterion[];
  satisfiedCriteriaIds: ReadonlySet<string>;
  internalInstructionProgress: Map<string, number>;
  lastAction?: LastDispatchedActionEvidence;
  postActionObservation: Observation;
}): void {
  const { successCriteria, satisfiedCriteriaIds, internalInstructionProgress, lastAction, postActionObservation } =
    params;

  if (!lastAction || !lastAction.success || !PROGRESSING_ACTION_TYPES.has(lastAction.type)) {
    return;
  }

  const evidenceText = [
    lastAction.targetAccessibleName,
    lastAction.resultingUrl,
    postActionObservation.title,
    ...(postActionObservation.notableText ?? []),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ");
  if (!evidenceText.trim()) {
    return;
  }

  for (const criterion of successCriteria) {
    if (criterion.required === false || criterion.group || satisfiedCriteriaIds.has(criterion.id)) {
      continue;
    }
    const segments = parseOrderedInstructions(criterion.description);
    if (segments.length < 2) {
      continue;
    }

    // The last segment (the "stop" instruction) is excluded from heuristic advancement --
    // see this function's doc comment above.
    const maxHeuristicIndex = segments.length - 2;
    const currentIndex = internalInstructionProgress.get(criterion.id) ?? 0;
    if (currentIndex > maxHeuristicIndex) {
      continue;
    }

    const instructionText = segments[currentIndex];
    if (!instructionText) {
      continue;
    }

    const coverage = objectiveTokenCoverage(instructionText, evidenceText);
    if (coverage >= INSTRUCTION_EVIDENCE_MIN_COVERAGE) {
      internalInstructionProgress.set(criterion.id, currentIndex + 1);
    }
  }
}
