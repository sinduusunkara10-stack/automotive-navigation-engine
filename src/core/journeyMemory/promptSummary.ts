import type { JourneyMemoryPromptSummary, ScoredJourneyMemoryCandidate } from "../../types/journeyMemory.js";
import type { JourneyMemoryTimingConfig } from "../../config/journeyMemoryConfig.js";

/** Rough, deterministic token estimate (chars/4) -- no tokenizer dependency, same conservative-estimate convention used elsewhere in this codebase's prompt budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function candidateReasonText(candidate: ScoredJourneyMemoryCandidate): string {
  return candidate.reason.length > 140 ? `${candidate.reason.slice(0, 137)}...` : candidate.reason;
}

function actionLabelFor(candidate: ScoredJourneyMemoryCandidate): string {
  const segment = candidate.segment;
  return segment.kind === "forward" ? segment.action.semanticLabel : segment.failedCandidate.semanticLabel;
}

/**
 * Builds the compact, bounded summary injected into the *next* existing
 * buildReasoningPrompt call (binding contract §10) -- never a standing per-step field.
 * Follows promptBuilder.ts's own routeMemory field as its template for shape/truncation:
 * at most timing.maxPromptRecords records, deduplicated by (kind, actionLabel, tier), a
 * hard character cap AND an estimated-token cap, both enforced by dropping the
 * lowest-scored records first until both bounds are satisfied. Never includes raw prior-
 * run files, full pages, complete route logs, or raw query strings -- only the fixed,
 * already-sanitized fields listed on JourneyMemoryPromptSummary.
 */
export function buildJourneyMemoryPromptSummary(
  candidates: ScoredJourneyMemoryCandidate[],
  timing: Pick<JourneyMemoryTimingConfig, "maxPromptRecords" | "promptCharCap" | "promptTokenCap">,
): JourneyMemoryPromptSummary | undefined {
  const seen = new Set<string>();
  const deduped: ScoredJourneyMemoryCandidate[] = [];
  for (const candidate of candidates) {
    const dedupeKey = `${candidate.segment.kind}::${actionLabelFor(candidate)}::${candidate.tier}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(candidate);
    if (deduped.length >= timing.maxPromptRecords) break;
  }

  if (deduped.length === 0) return undefined;

  let records = deduped.map((candidate) => ({
    outcome:
      candidate.segment.kind === "forward"
        ? candidate.segment.outcome
        : candidate.segment.finalRecoveryOutcome === "recovered"
          ? ("success" as const)
          : ("failure" as const),
    confidence: Math.round(candidate.segment.confidence * 100) / 100,
    tier: candidate.tier,
    reason: candidateReasonText(candidate),
    actionLabel: actionLabelFor(candidate),
    kind: candidate.segment.kind,
  }));

  const withinBudget = (r: typeof records) => {
    const json = JSON.stringify(r);
    return json.length <= timing.promptCharCap && estimateTokens(json) <= timing.promptTokenCap;
  };

  while (records.length > 0 && !withinBudget(records)) {
    records = records.slice(0, -1);
  }

  return records.length > 0 ? { records } : undefined;
}
