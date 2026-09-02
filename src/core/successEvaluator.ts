import type { Page } from "playwright";
import type { SuccessCriterion } from "../types/task-request.js";
import type { SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
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

/**
 * `semanticVerifier` is optional and off by default: when omitted, semantic_page_match
 * stays exactly the deterministic lexical token-overlap check it always was (see
 * evaluateSemanticPageMatch below) -- same-language behaviour and every non-semantic
 * criterion type are completely unaffected either way. When supplied, it is only ever
 * consulted as a fallback for a semantic_page_match criterion the deterministic score
 * could not already satisfy -- see docs/n8n-integration.md "Generic multilingual
 * semantic_page_match verification" for why deterministic token overlap alone cannot
 * safely support arbitrary objective-language/page-language pairs.
 *
 * `alreadySatisfiedCriteriaIds` is optional and off by default too: when supplied (the
 * engine passes its running satisfiedCriteriaIds Set -- see src/core/loop.ts), a
 * criterion whose id is already a member is never re-evaluated at all, of any type --
 * not just semantic_page_match, and not gated on the page or URL having "not changed".
 * This is a pure redundant-work elimination, not a change to what "satisfied" means: the
 * engine's satisfiedCriteriaIds is a one-way ratchet (nothing ever removes a member --
 * see src/core/state.ts), so a criterion's truth value can never revert from true to
 * false, and re-deriving an answer that can no longer affect the run's outcome is wasted
 * work -- most visibly, a wasted semantic-verifier model call on a page whose incidental
 * content (a selected option, a live price, a step counter) keeps changing after the
 * criterion was already satisfied. See docs/n8n-integration.md "Repeated-decision and
 * cost control" for the caching/no-progress guard this complements, and the design
 * discussion in this session for why URL- or content-based caching was rejected in favour
 * of this narrower, zero-new-false-positive/false-negative optimisation.
 */
export async function evaluateSuccessCriteria(
  page: Page,
  criteria: SuccessCriterion[],
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
  alreadySatisfiedCriteriaIds?: ReadonlySet<string>,
): Promise<string[]> {
  const satisfied: string[] = [];
  for (const criterion of criteria) {
    if (alreadySatisfiedCriteriaIds?.has(criterion.id)) {
      continue;
    }
    if (await evaluateSingle(page, criterion, objective, semanticVerifier)) {
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

async function evaluateSingle(
  page: Page,
  criterion: SuccessCriterion,
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
): Promise<boolean> {
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
      return evaluateSemanticPageMatch(page, criterion, objective, semanticVerifier);
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
 *
 * Deterministic lexical token overlap is tried first, always, and stays the source of
 * truth whenever it already clears minScore -- it is cheap, fully repeatable, and correct
 * for same-language objective/page pairs. It is not a reliable signal across languages
 * (see docs/n8n-integration.md "Generic multilingual semantic_page_match verification"),
 * so when it falls short and a semanticVerifier was supplied, that bounded, cached model
 * call is consulted as a fallback before concluding the criterion is unsatisfied.
 */
async function evaluateSemanticPageMatch(
  page: Page,
  criterion: SuccessCriterion,
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
): Promise<boolean> {
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
  if (score.overall >= minScore) {
    return true;
  }

  if (!semanticVerifier) {
    return false;
  }

  const verification = await semanticVerifier.verify({
    objective,
    criterionDescription: criterion.description,
    pageEvidence: pageSignals,
  });
  return verification.satisfied;
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
