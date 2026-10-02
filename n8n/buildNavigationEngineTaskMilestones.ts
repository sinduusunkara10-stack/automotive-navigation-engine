// n8n "Build Navigation Engine Task" node -- milestone-extraction fragment.
//
// Ported from the project's build-navigation-engine-task.js (see project files), whose
// `extractMilestoneDescriptions` splits a multi-line Objective into one `semantic_page_match`
// successCriterion per line, every one `required: true`, with no grouping at all. That is
// correct for a plain ordered sequence, but wrong whenever the Objective expresses an
// *alternative* ("do X under either: A, or B") -- splitting naively makes A and B two
// independently required criteria instead of one group satisfied by either, which the engine
// can then never satisfy simultaneously (confirmed production cause: run_9f535d17, Peugeot
// "E-208 (preferred), or" / "E-2008 (fallback...)" objective lines).
//
// The engine itself already supports this correctly via successCriterion.group (see
// src/core/successEvaluator.ts's groupCriteria/getMissingRequiredCriteriaIds and
// docs/n8n-integration.md "Alternative (OR) success criteria groups") -- this fix only teaches
// the n8n task-builder to use that existing mechanism. No engine change, no brand/journey-
// specific logic: the detection is a plain, language-agnostic textual pattern (a line whose
// last word is "or"), not tied to any CTA name, vehicle, or brand.

export interface MilestoneDescriptor {
  description: string;
  /** Present only when this description was grouped as an alternative with its neighbour(s). */
  group?: string;
}

function cleanMilestoneText(value: string): string {
  return value
    .replace(/^[-*•]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitNumberedSequence(value: string): string[] {
  const text = String(value ?? "")
    .replace(/\r/g, "")
    .trim();

  if (!text) {
    return [];
  }

  const normalised = text.replace(/(?:^|\s)(?:step\s*)?(\d+)\s*[.)]\s+/gi, (match, number, offset) => {
    const prefix = offset === 0 ? "" : "\n";
    return `${prefix}${number}. `;
  });

  return normalised
    .split(/\n+/)
    .map(cleanMilestoneText)
    .filter(Boolean);
}

export function splitLineBasedSequence(value: string): string[] {
  return String(value ?? "")
    .replace(/\r/g, "")
    .split(/\n+/)
    .map(cleanMilestoneText)
    .filter(Boolean);
}

export function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output;
}

// A line whose last word is "or" (optionally followed by trailing punctuation) signals that the
// *next* line is its alternative, not its sequel -- "E-208 (preferred), or" / "E-2008 (fallback
// ...)." Deliberately narrow: only the trailing-"or" shape, in English, matching this repo's
// existing objective-text convention (see docs/n8n-integration.md) -- a different phrasing
// ("either A or B" on one line, a non-English objective) is not detected and falls through to
// the previous, unchanged ungrouped behaviour rather than guessing.
const TRAILING_OR_RE = /\bor\b[.,:;]?\s*$/i;

/**
 * Groups consecutive alternative lines (chained by a trailing "or") under a shared `group` id,
 * leaving every other line exactly as extractMilestoneDescriptions always produced it
 * (ungrouped, in order) -- a strict superset of the previous behaviour, same as
 * successCriterion.group's own doc comment describes at the engine level.
 */
export function groupAlternativeMilestones(descriptions: readonly string[]): MilestoneDescriptor[] {
  const result: MilestoneDescriptor[] = [];
  let groupCounter = 0;
  let i = 0;
  while (i < descriptions.length) {
    const current = descriptions[i] as string;
    if (TRAILING_OR_RE.test(current) && i + 1 < descriptions.length) {
      const groupId = `alt-${++groupCounter}`;
      let j = i;
      result.push({ description: current, group: groupId });
      while (j + 1 < descriptions.length) {
        j += 1;
        const next = descriptions[j] as string;
        result.push({ description: next, group: groupId });
        if (!TRAILING_OR_RE.test(next)) {
          break;
        }
      }
      i = j + 1;
    } else {
      result.push({ description: current });
      i += 1;
    }
  }
  return result;
}

/**
 * Drop-in replacement for the original node's extractMilestoneDescriptions: same
 * numbered-sequence / line-based-sequence / Success-Criteria-fallback precedence, but returns
 * grouped descriptors instead of bare strings.
 */
export function extractMilestoneCriteria(objectiveText: string, fallbackCriteriaText: string): MilestoneDescriptor[] {
  const objectiveNumberedSteps = splitNumberedSequence(objectiveText);
  if (objectiveNumberedSteps.length > 1) {
    return groupAlternativeMilestones(uniqueInOrder(objectiveNumberedSteps));
  }

  const objectiveLineSteps = splitLineBasedSequence(objectiveText);
  if (objectiveLineSteps.length > 1) {
    return groupAlternativeMilestones(uniqueInOrder(objectiveLineSteps));
  }

  const criteriaNumberedSteps = splitNumberedSequence(fallbackCriteriaText);
  if (criteriaNumberedSteps.length > 1) {
    return groupAlternativeMilestones(uniqueInOrder(criteriaNumberedSteps));
  }

  const criteriaLineSteps = splitLineBasedSequence(fallbackCriteriaText);
  if (criteriaLineSteps.length > 1) {
    return groupAlternativeMilestones(uniqueInOrder(criteriaLineSteps));
  }

  const singleDescription = cleanMilestoneText(fallbackCriteriaText || objectiveText || "");
  return singleDescription ? [{ description: singleDescription }] : [];
}

export interface GeneratedSuccessCriterion {
  id: string;
  type: "semantic_page_match";
  description: string;
  config: { minScore: number };
  required: true;
  group?: string;
}

/** Maps extractMilestoneCriteria's output onto the wire-contract successCriteria shape. */
export function buildSuccessCriteriaFromObjective(
  objectiveText: string,
  fallbackCriteriaText: string,
): GeneratedSuccessCriterion[] {
  return extractMilestoneCriteria(objectiveText, fallbackCriteriaText).map((milestone, index) => ({
    id: `step-${index + 1}`,
    type: "semantic_page_match",
    description: milestone.description,
    config: { minScore: 0.4 },
    required: true,
    ...(milestone.group ? { group: milestone.group } : {}),
  }));
}
