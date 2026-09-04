import type { Page } from "playwright";
import type { SuccessCriterion } from "../types/task-request.js";
import type { LastActionEvidence, SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import { readDataLayerSnapshot } from "../capture-modules/dataLayerDelta.js";
import {
  ALL_SEMANTIC_SIGNALS,
  gatherSemanticPageSignals,
  isSemanticSignalName,
  scoreSemanticPageMatch,
  type SemanticSignalName,
} from "./semanticPageMatch.js";

/**
 * Already-accumulated, generic run evidence a data_layer_event/network_event criterion can
 * be checked against, in addition to whatever live page state evaluateSingle can read
 * directly -- see evaluateDataLayerEvent/evaluateNetworkEvent below. Deliberately typed as
 * plain records, not the capture-module response types, so this file never depends on
 * *which* capture modules a task requested: the caller (src/core/loop.ts) passes whatever
 * it already has (possibly nothing, if the relevant capture module wasn't requested), and
 * an absent/empty source simply yields no matches -- never an error.
 */
export interface SuccessCriteriaEvidence {
  /** window.dataLayer entries captured so far this run (data_layer_evidence capture, if requested). */
  dataLayerEntries?: readonly Record<string, unknown>[];
  /** GA4-style network request evidence captured so far this run (ga4_network_events capture, if requested). */
  networkEvents?: readonly Record<string, unknown>[];
}

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
 *
 * `lastActionEvidence` is optional and off by default: when supplied (src/core/loop.ts
 * passes the same clicked-element details it already reads for the cta_clicks capture --
 * see readClickedElementDetails in src/capture-modules/ctaClicks.ts), it is forwarded only
 * to a semantic_page_match criterion that still needs to consult semanticVerifier, as
 * extra evidence about the specific control the engine most recently clicked. This lets a
 * criterion's own description generically require that a specific completion control was
 * activated (e.g. "the final completion control -- Summary, Continue, or an equivalent --
 * was clicked"), verified by meaning against the actual click, rather than being satisfied
 * merely by landing on a right-looking page some other way. It never affects the
 * deterministic lexical path or any non-semantic criterion type.
 *
 * `criteriaEvidence` is optional and off by default: when supplied (src/core/loop.ts
 * passes the run's accumulated data_layer_evidence/ga4_network_events captures, whichever
 * were requested), it is the evidence source data_layer_event/network_event criteria are
 * checked against -- see SuccessCriteriaEvidence and evaluateDataLayerEvent/
 * evaluateNetworkEvent below. It never affects any other criterion type.
 */
export async function evaluateSuccessCriteria(
  page: Page,
  criteria: SuccessCriterion[],
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
  alreadySatisfiedCriteriaIds?: ReadonlySet<string>,
  lastActionEvidence?: LastActionEvidence,
  criteriaEvidence?: SuccessCriteriaEvidence,
): Promise<string[]> {
  const satisfied: string[] = [];
  for (const criterion of criteria) {
    if (alreadySatisfiedCriteriaIds?.has(criterion.id)) {
      continue;
    }
    if (await evaluateSingle(page, criterion, objective, semanticVerifier, lastActionEvidence, criteriaEvidence)) {
      satisfied.push(criterion.id);
    }
  }
  return satisfied;
}

/**
 * A criterion is required unless explicitly marked `required: false` -- matches the
 * request schema's own `default: true` for successCriterion.required, which is never
 * applied by ajv (no useDefaults) so callers omitting the field must be treated as
 * required here explicitly.
 *
 * Criteria sharing the same (non-empty) `group` value are *alternatives*: the group is
 * satisfied as a whole once *any one* of its members is satisfied, and is "required"
 * exactly when at least one of its members is (the same required-unless-false default,
 * applied at group level). A criterion with no `group` is its own implicit singleton
 * group, so ungrouped criteria are entirely unaffected -- this is a strict superset of the
 * previous AND-of-all-required-criteria behaviour, added generically (no criterion type,
 * brand, or journey-specific logic) to let a task express "the objective is reached when
 * any one of N independent signals is observed" (e.g. a specific CTA was clicked, OR a
 * destination page was reached, OR a specific analytics event fired) without forcing every
 * alternative to be required simultaneously. See docs/n8n-integration.md "Alternative (OR)
 * success criteria groups".
 *
 * Returns the ids of every criterion belonging to an unsatisfied required group (all
 * members of that group, so a caller can see exactly which alternatives remain unmet);
 * empty when every required group has at least one satisfied member, and always empty for
 * a task where every criterion/group is explicitly optional.
 */
export function getMissingRequiredCriteriaIds(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIds: ReadonlySet<string>,
): string[] {
  const groups = new Map<string, SuccessCriterion[]>();
  for (const criterion of criteria) {
    const key = criterion.group && criterion.group.length > 0 ? `g:${criterion.group}` : `c:${criterion.id}`;
    const members = groups.get(key);
    if (members) {
      members.push(criterion);
    } else {
      groups.set(key, [criterion]);
    }
  }

  const missing: string[] = [];
  for (const members of groups.values()) {
    const groupRequired = members.some((member) => member.required !== false);
    if (!groupRequired) {
      continue;
    }
    const groupSatisfied = members.some((member) => satisfiedCriteriaIds.has(member.id));
    if (!groupSatisfied) {
      missing.push(...members.map((member) => member.id));
    }
  }
  return missing;
}

async function evaluateSingle(
  page: Page,
  criterion: SuccessCriterion,
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
  lastActionEvidence?: LastActionEvidence,
  criteriaEvidence?: SuccessCriteriaEvidence,
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
      return evaluateSemanticPageMatch(page, criterion, objective, semanticVerifier, lastActionEvidence);
    }
    case "data_layer_event": {
      return evaluateDataLayerEvent(page, criterion, criteriaEvidence);
    }
    case "network_event": {
      return evaluateNetworkEvent(criterion, criteriaEvidence);
    }
    // element_text_match / custom are not evaluated by this generic core evaluator; a
    // capture module or a future criterion handler owns them.
    default:
      return false;
  }
}

/**
 * Generic key/value evidence matcher shared by data_layer_event and network_event: every
 * key in `match` must be present on `entry` with an equal (string-coerced) value. Never a
 * fixed vocabulary of field/event names -- `match` is entirely caller-supplied, so this
 * works identically for any analytics vendor's event shape (a dataLayer push, a GA4/GTM
 * measurement-protocol param set, or any other flat key/value evidence record).
 */
function matchesEventFields(entry: Record<string, unknown>, match: Record<string, string>): boolean {
  return Object.entries(match).every(([key, value]) => entry[key] !== undefined && String(entry[key]) === value);
}

function parseMatchConfig(config: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const match = config?.match;
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    return undefined;
  }
  const entries = Object.entries(match as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([, value]) => typeof value === "string")) {
    return undefined;
  }
  return match as Record<string, string>;
}

/**
 * Satisfied once any window.dataLayer entry -- read live from the current page, unioned
 * with whatever data_layer_evidence this run has already accumulated (if that capture
 * module was requested) -- matches every key/value pair in `config.match`. The live read
 * catches an event pushed just before this exact evaluation (e.g. immediately after the
 * click that triggered it, before any later navigation on this same site resets
 * window.dataLayer); the accumulated evidence catches one from an earlier step whose page
 * has since navigated away, since a full-document navigation always starts a fresh
 * window.dataLayer (see capture-modules/dataLayerDelta.ts). config.match with no entries,
 * a non-object value, or no window.dataLayer array on the page at all yields no match --
 * never an error, and never satisfied by an unconfigured criterion.
 */
async function evaluateDataLayerEvent(
  page: Page,
  criterion: SuccessCriterion,
  criteriaEvidence?: SuccessCriteriaEvidence,
): Promise<boolean> {
  const match = parseMatchConfig(criterion.config);
  if (!match) {
    return false;
  }
  const live = await readDataLayerSnapshot(page).catch(() => ({ available: false, raw: [] as Record<string, unknown>[] }));
  const candidates: readonly Record<string, unknown>[] = [
    ...(live.available ? live.raw : []),
    ...(criteriaEvidence?.dataLayerEntries ?? []),
  ];
  return candidates.some((entry) => matchesEventFields(entry, match));
}

/**
 * Satisfied once any accumulated network-event evidence (captures.ga4_network_events, if
 * the ga4_network_events capture module was requested -- see
 * capture-modules/ga4NetworkEvents.ts) matches every key/value pair in `config.match`.
 * Matched against a flattened merge of the event's own top-level fields (e.g. requestUrl)
 * and its request params (e.g. a GA4 collect request's `en`/event-name param), so either
 * can be targeted generically without this evaluator knowing any vendor's specific field
 * names. Unlike data_layer_event, there is no live-page equivalent to fall back on --
 * network requests are only ever observed via the request listener a capture module
 * attaches -- so a task that wants this criterion type evaluated must request
 * ga4_network_events; without it, criteriaEvidence.networkEvents is empty and this
 * criterion can never be satisfied, exactly like element_present with no matching
 * selector.
 */
function evaluateNetworkEvent(criterion: SuccessCriterion, criteriaEvidence?: SuccessCriteriaEvidence): boolean {
  const match = parseMatchConfig(criterion.config);
  if (!match) {
    return false;
  }
  const candidates = criteriaEvidence?.networkEvents ?? [];
  return candidates.some((entry) => {
    const params = entry.params;
    const flattened: Record<string, unknown> =
      typeof params === "object" && params !== null && !Array.isArray(params) ? { ...entry, ...params } : entry;
    return matchesEventFields(flattened, match);
  });
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
  lastActionEvidence?: LastActionEvidence,
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
    ...(lastActionEvidence ? { lastActionEvidence } : {}),
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
