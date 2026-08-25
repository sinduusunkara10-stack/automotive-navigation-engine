import type { Page } from "playwright";
import type { SuccessCriterion } from "../types/task-request.js";
import {
  ALL_SEMANTIC_SIGNALS,
  gatherSemanticPageSignals,
  isSemanticSignalName,
  scoreSemanticPageMatch,
  type SemanticSignalName,
} from "./semanticPageMatch.js";

// Default threshold for semantic_page_match: chosen conservatively so a page sharing only
// one or two incidental words with the objective doesn't false-positive, while a page whose
// title/headings/controls genuinely describe the objective's target state clears it. Callers
// can tune per-criterion via config.minScore -- see docs/n8n-integration.md.
const DEFAULT_SEMANTIC_MIN_SCORE = 0.4;

export async function evaluateSuccessCriteria(
  page: Page,
  criteria: SuccessCriterion[],
  objective: string,
): Promise<string[]> {
  const satisfied: string[] = [];
  for (const criterion of criteria) {
    if (await evaluateSingle(page, criterion, objective)) {
      satisfied.push(criterion.id);
    }
  }
  return satisfied;
}

/**
 * A criterion is required unless explicitly marked `required: false` -- matches the
 * request schema's own `default: true` for successCriterion.required, which is never
 * applied by ajv (no useDefaults) so callers omitting the field must be treated as
 * required here explicitly. Returns the ids of every required criterion not present in
 * satisfiedCriteriaIds; empty when every required criterion is satisfied, and always
 * empty for a task where every criterion is explicitly optional.
 */
export function getMissingRequiredCriteriaIds(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIds: ReadonlySet<string>,
): string[] {
  return criteria.filter((criterion) => criterion.required !== false && !satisfiedCriteriaIds.has(criterion.id)).map(
    (criterion) => criterion.id,
  );
}

async function evaluateSingle(page: Page, criterion: SuccessCriterion, objective: string): Promise<boolean> {
  switch (criterion.type) {
    case "url_pattern": {
      const pattern = typeof criterion.config?.pattern === "string" ? criterion.config.pattern : undefined;
      return pattern !== undefined && matchesUrlPattern(page.url(), pattern);
    }
    case "element_present": {
      const selector = typeof criterion.config?.selector === "string" ? criterion.config.selector : undefined;
      if (!selector) {
        return false;
      }
      return (await page.locator(selector).count()) > 0;
    }
    case "semantic_page_match": {
      return evaluateSemanticPageMatch(page, criterion, objective);
    }
    // data_layer_event / network_event / custom are not evaluated by this generic
    // core evaluator; a capture module or a future criterion handler owns them.
    default:
      return false;
  }
}

/**
 * Generic, brand/language-agnostic success signal: does the live page's own title, headings,
 * and visible interactive-element text share enough vocabulary with this task's objective
 * (plus the criterion's own description) to consider the target state reached? Uses only page
 * observations already safe to read (no raw HTML, cookies, storage, or headers) and the
 * caller-supplied objective -- never a hardcoded selector, URL pattern, CTA label, or
 * hostname. See src/core/semanticPageMatch.ts for the scoring itself and
 * docs/n8n-integration.md "Generic success criteria" for guidance and known limitations.
 */
async function evaluateSemanticPageMatch(page: Page, criterion: SuccessCriterion, objective: string): Promise<boolean> {
  const anchorText = [objective, criterion.description].filter(Boolean).join(" ");
  if (!anchorText.trim()) {
    return false;
  }

  const minScore =
    typeof criterion.config?.minScore === "number" ? criterion.config.minScore : DEFAULT_SEMANTIC_MIN_SCORE;

  const configuredSignals = Array.isArray(criterion.config?.signals)
    ? criterion.config.signals.filter(isSemanticSignalName)
    : undefined;
  const signals: readonly SemanticSignalName[] =
    configuredSignals && configuredSignals.length > 0 ? configuredSignals : ALL_SEMANTIC_SIGNALS;

  const pageSignals = await gatherSemanticPageSignals(page);
  const score = scoreSemanticPageMatch(anchorText, pageSignals, signals);
  return score.overall >= minScore;
}

// A NUL character can never legitimately appear in a caller-supplied URL pattern, so it's
// safe as a delimiter that pattern text itself could never collide with (unlike, say, a
// literal space, which a URL pattern could contain). Written as the \0 escape rather than an
// embedded raw NUL byte so the source file itself stays plain text.
const WILDCARD_PLACEHOLDER = "\0";

function matchesUrlPattern(url: string, pattern: string): boolean {
  const escaped = pattern
    .split("**")
    .join(WILDCARD_PLACEHOLDER)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .split(WILDCARD_PLACEHOLDER)
    .join(".*");
  return new RegExp(`^${escaped}$`).test(url);
}
