import type { Page } from "playwright";
import type { SuccessCriterion } from "../types/task-request.js";
import type { LastActionEvidence, SemanticCriterionVerifier } from "../reasoning/semanticCriterionVerifier.js";
import type { MilestoneRollup } from "../types/branch.js";
import type { MilestoneEvidenceRecord } from "../types/task-response.js";
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
 *
 * `milestoneEvidenceContext` is optional and off by default: when supplied (src/core/loop.ts
 * passes state.milestoneEvidence as the sink, alongside the current stepIndex/phase), a
 * MilestoneEvidenceRecord documenting *why* is appended for every criterion this call
 * satisfies -- see MilestoneEvidenceContext and docs/n8n-integration.md §9f. Purely additive
 * diagnostics: omitting it reproduces the exact prior return value/behaviour.
 *
 * `surfaceScoped` is optional and off by default (see docs/architecture.md §21 "Surface-
 * scoped evidence"): when true (src/core/loop.ts passes ActionResult.surfaceChangeDetected
 * from the action just dispatched -- PR 1C-a), a semantic_page_match criterion's own
 * evidence pool is scoped to elements not currently covered by another element (the same
 * generic elementFromPoint hit-test observation/observationBuilder.ts already uses) --
 * background page content sitting underneath a newly-opened drawer/panel is excluded, so a
 * milestone cannot be satisfied by leftover text from a page state the surface change just
 * covered over. Never affects any other criterion type, and never changes behaviour when
 * omitted (every pre-existing caller).
 *
 * Ordered-milestone gate (docs/n8n-integration.md §9f, the fix for the reported false-
 * success regression): every distinct criterion **group** with `required !== false` on any
 * member is one required milestone, milestones are read off `criteria` in declaration order
 * (the same order groupCriteria's Map preserves), and only the *first* required milestone
 * not yet satisfied -- per `alreadySatisfiedCriteriaIds` as it stood when this function was
 * called, a snapshot never updated as criteria are satisfied within this same call -- is
 * eligible to be evaluated at all this call. A later required milestone is not evaluated,
 * let alone satisfied, until every earlier required milestone already is; at most one
 * required milestone can newly satisfy per call, so a single, unchanged page observation can
 * never satisfy more than one required milestone in one pass, however much of its vocabulary
 * happens to overlap with later milestones' descriptions (e.g. a homepage's own nav bar
 * advertising "Offers"/"Juke"/"Request a quote" must never itself satisfy the criteria for
 * having reached those destinations). See computeEligibleCriteriaIds below. Optional
 * (`required: false`) criteria are entirely unaffected -- always eligible, exactly as before
 * this gate existed -- since they never gate `stop_success` and are purely informational
 * (see getMissingRequiredCriteriaIds and docs/n8n-integration.md §9c's
 * "configurator-entered" pattern).
 */
export async function evaluateSuccessCriteria(
  page: Page,
  criteria: SuccessCriterion[],
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
  alreadySatisfiedCriteriaIds?: ReadonlySet<string>,
  lastActionEvidence?: LastActionEvidence,
  criteriaEvidence?: SuccessCriteriaEvidence,
  milestoneEvidenceContext?: MilestoneEvidenceContext,
  surfaceScoped?: boolean,
): Promise<string[]> {
  const satisfiedAtCallStart = alreadySatisfiedCriteriaIds ?? new Set<string>();
  const eligibleCriteriaIds = computeEligibleCriteriaIds(criteria, satisfiedAtCallStart);

  const satisfied: string[] = [];
  for (const criterion of criteria) {
    if (satisfiedAtCallStart.has(criterion.id)) {
      continue;
    }
    if (!eligibleCriteriaIds.has(criterion.id)) {
      continue;
    }
    const result = await evaluateSingle(
      page,
      criterion,
      objective,
      semanticVerifier,
      lastActionEvidence,
      criteriaEvidence,
      surfaceScoped,
    );
    if (result.satisfied) {
      satisfied.push(criterion.id);
      if (milestoneEvidenceContext) {
        milestoneEvidenceContext.sink.push({
          criterionId: criterion.id,
          criterionType: criterion.type,
          description: criterion.description,
          stepIndex: milestoneEvidenceContext.stepIndex,
          phase: milestoneEvidenceContext.phase,
          pageUrl: page.url(),
          pageTitle: await page.title().catch(() => ""),
          evidenceSource: result.evidenceSource,
          evidenceTier: computeEvidenceTier(result.evidenceSource),
          score: result.score ?? 1.0,
          ...(result.matchedValue !== undefined ? { matchedValue: result.matchedValue } : {}),
          reason: result.reason,
        });
      }
    }
  }
  return satisfied;
}

/** See evaluateSuccessCriteria's own doc comment on `milestoneEvidenceContext`. */
export interface MilestoneEvidenceContext {
  /** Mutated in place: one record is pushed per criterion this call newly satisfies. */
  sink: MilestoneEvidenceRecord[];
  stepIndex: number;
  phase: "pre_action" | "post_action";
}

/**
 * PR 1D (truthful milestone evaluation, see docs/architecture.md §21 and
 * MilestoneEvidenceRecord.evidenceTier's own doc comment, types/task-response.ts): a pure,
 * deterministic mapping from a SingleCriterionResult.evidenceSource string to its evidence
 * tier -- never a separate judgement call, and never a value computed by a model. Kept
 * strictly in sync with the literal evidenceSource strings evaluateSingle/its sub-evaluators
 * actually produce below: every one of "url_pattern", "element_present", "data_layer_event",
 * "network_event" is a direct mechanical DOM/URL/event read (observed); both
 * "semantic_page_match:deterministic" and "semantic_page_match:verifier" involve vocabulary-
 * overlap scoring or a model judgement over textual similarity, never a literal fact
 * (inferred). The "assumed" fallback exists only so a genuinely new, not-yet-categorised
 * evidenceSource string fails safe (never silently reported as "observed") -- no code path
 * in this file produces one today, enforced by tests/unit/milestoneEvidenceTiers.test.ts.
 */
export function computeEvidenceTier(evidenceSource: string): "observed" | "inferred" | "assumed" {
  if (
    evidenceSource === "url_pattern" ||
    evidenceSource === "element_present" ||
    evidenceSource === "data_layer_event" ||
    evidenceSource === "network_event"
  ) {
    return "observed";
  }
  if (evidenceSource === "semantic_page_match:deterministic" || evidenceSource === "semantic_page_match:verifier") {
    return "inferred";
  }
  return "assumed";
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
interface CriterionGroup {
  members: SuccessCriterion[];
  required: boolean;
}

/**
 * Buckets criteria into their groups (a shared, non-empty `group` value, or an implicit
 * singleton group per ungrouped criterion) and computes each group's required-ness -- the
 * same required-unless-false-at-group-level semantics documented on
 * getMissingRequiredCriteriaIds below. Shared by that function and by
 * computeEstimatedCompletion so both agree on exactly what "a required criterion/group" is.
 */
function groupCriteria(criteria: readonly SuccessCriterion[]): CriterionGroup[] {
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
  return [...groups.values()].map((members) => ({
    members,
    required: members.some((member) => member.required !== false),
  }));
}

/**
 * Which criteria are eligible to be evaluated (and thus newly satisfied) by one call to
 * evaluateSuccessCriteria -- see that function's own doc comment for the full rationale.
 * Every non-required group's members are always eligible (unordered, unaffected by this
 * gate). For required groups: a group that is already satisfied (per
 * `satisfiedCriteriaIdsAtCallStart`) stays eligible too, but harmlessly so -- an
 * already-satisfied criterion is never actually re-evaluated regardless (see the
 * `satisfiedAtCallStart.has(criterion.id)` short-circuit in evaluateSuccessCriteria). The
 * *first* required group not yet satisfied, in declaration order, is this call's one active
 * milestone and is eligible; every required group after it is not eligible at all this
 * call.
 */
function computeEligibleCriteriaIds(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIdsAtCallStart: ReadonlySet<string>,
): Set<string> {
  const eligible = new Set<string>();
  let activeRequiredMilestoneClaimed = false;
  for (const group of groupCriteria(criteria)) {
    if (!group.required) {
      for (const member of group.members) {
        eligible.add(member.id);
      }
      continue;
    }
    const groupAlreadySatisfied = group.members.some((member) => satisfiedCriteriaIdsAtCallStart.has(member.id));
    if (groupAlreadySatisfied) {
      for (const member of group.members) {
        eligible.add(member.id);
      }
      continue;
    }
    if (activeRequiredMilestoneClaimed) {
      // A later, still-unsatisfied required milestone -- not eligible this call.
      continue;
    }
    for (const member of group.members) {
      eligible.add(member.id);
    }
    activeRequiredMilestoneClaimed = true;
  }
  return eligible;
}

export function getMissingRequiredCriteriaIds(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIds: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const group of groupCriteria(criteria)) {
    if (!group.required) {
      continue;
    }
    const groupSatisfied = group.members.some((member) => satisfiedCriteriaIds.has(member.id));
    if (!groupSatisfied) {
      missing.push(...group.members.map((member) => member.id));
    }
  }
  return missing;
}

/**
 * Generic, criterion-type-agnostic completion estimate for Progress.estimatedCompletion:
 * the fraction of required criteria/groups (same grouping semantics as
 * getMissingRequiredCriteriaIds) that are currently satisfied. Deliberately structured so
 * estimatedCompletion can only reach 1 when every required criterion/group is satisfied --
 * i.e. exactly when engineAssessment.objectiveAchieved's own required-criteria check
 * (src/core/engine.ts) would also pass on a successful stop -- rather than saturating to 1
 * the moment *any* single criterion (including a merely optional, informational one) is
 * satisfied while the actual objective remains unmet.
 *
 * A task with no required criteria/groups at all has no required signal to measure
 * completion against, so it falls back to the fraction satisfied across every (optional)
 * group instead -- still a proportional signal, never a step function that jumps to 1 on
 * the first unrelated criterion.
 */
export function computeEstimatedCompletion(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIds: ReadonlySet<string>,
): number {
  const groups = groupCriteria(criteria);
  if (groups.length === 0) {
    return 0;
  }
  const requiredGroups = groups.filter((group) => group.required);
  const targetGroups = requiredGroups.length > 0 ? requiredGroups : groups;
  const satisfiedCount = targetGroups.filter((group) =>
    group.members.some((member) => satisfiedCriteriaIds.has(member.id)),
  ).length;
  return satisfiedCount / targetGroups.length;
}

/**
 * Goal-Directed Bounded Branch Exploration: a compact, evidence-backed rollup of objective
 * progress for the reasoning prompt (see reasoning/promptBuilder.ts), reusing existing
 * successCriteria/satisfiedCriteriaIds as the objective's milestones rather than
 * introducing a second, parallel milestone system -- per the investigation report's
 * recommendation. Milestone *order* is simply declaration order in the `criteria` array
 * (the same order groupCriteria's Map already preserves via insertion order): the smallest
 * additive approach that needs no new schema field. A task with a single criterion (the
 * common case, and every pre-existing task) produces a trivial single-group rollup;
 * whether the prompt actually includes it at all is a promptBuilder.ts decision (it omits
 * a trivial, single-milestone rollup entirely -- see MAX_MILESTONE... note there), so this
 * function's own behaviour needs no special-casing for that.
 *
 * Each milestone group is represented by its first member's id/description -- a group is
 * conceptually one milestone even when it has several alternative members (see
 * groupCriteria's own doc comment on alternatives), so a single representative label is
 * enough for the compact rollup; the full member list remains available, unchanged, via
 * the existing successCriteria/satisfiedCriteriaIds fields for anything that needs it.
 */
export function computeMilestoneRollup(
  criteria: readonly SuccessCriterion[],
  satisfiedCriteriaIds: ReadonlySet<string>,
): MilestoneRollup {
  const groups = groupCriteria(criteria);
  const completed: MilestoneRollup["completed"] = [];
  const remaining: MilestoneRollup["remaining"] = [];

  for (const group of groups) {
    const representative = group.members[0];
    if (!representative) {
      continue;
    }
    const summary = { id: representative.id, description: representative.description };
    const groupSatisfied = group.members.some((member) => satisfiedCriteriaIds.has(member.id));
    if (groupSatisfied) {
      completed.push(summary);
    } else {
      remaining.push(summary);
    }
  }

  return {
    totalMilestones: groups.length,
    completedMilestones: completed.length,
    completed,
    remaining,
    ...(remaining.length > 0 ? { activeSubGoal: remaining[0] } : {}),
  };
}

/**
 * Result of evaluating one criterion, carrying enough evidence detail for a
 * MilestoneEvidenceRecord (see evaluateSuccessCriteria) without changing
 * evaluateSuccessCriteria's own public string[]-of-satisfied-ids return shape. Purely
 * internal -- never exported, never constructed or inspected by a test directly.
 */
interface SingleCriterionResult {
  satisfied: boolean;
  /** Which mechanism produced this verdict, e.g. "url_pattern", "semantic_page_match:deterministic". */
  evidenceSource: string;
  /** The literal pattern/selector/match object involved, when applicable. */
  matchedValue?: string;
  /** Deterministic score or verifier confidence, when applicable (semantic_page_match only). */
  score?: number;
  reason: string;
}

async function evaluateSingle(
  page: Page,
  criterion: SuccessCriterion,
  objective: string,
  semanticVerifier?: SemanticCriterionVerifier,
  lastActionEvidence?: LastActionEvidence,
  criteriaEvidence?: SuccessCriteriaEvidence,
  surfaceScoped?: boolean,
): Promise<SingleCriterionResult> {
  switch (criterion.type) {
    case "url_pattern": {
      const pattern = typeof criterion.config?.pattern === "string" ? criterion.config.pattern : undefined;
      if (pattern === undefined) {
        return { satisfied: false, evidenceSource: "url_pattern", reason: "No config.pattern configured." };
      }
      const url = page.url();
      const satisfied = matchesUrlPattern(url, pattern);
      return {
        satisfied,
        evidenceSource: "url_pattern",
        matchedValue: pattern,
        reason: satisfied
          ? `Current URL matched pattern "${pattern}".`
          : `Current URL did not match pattern "${pattern}".`,
      };
    }
    case "element_present": {
      const selector = typeof criterion.config?.selector === "string" ? criterion.config.selector : undefined;
      if (!selector) {
        return { satisfied: false, evidenceSource: "element_present", reason: "No config.selector configured." };
      }
      const count = await page.locator(selector).count();
      return {
        satisfied: count > 0,
        evidenceSource: "element_present",
        matchedValue: selector,
        reason:
          count > 0
            ? `Selector "${selector}" matched ${count} element(s).`
            : `Selector "${selector}" matched no elements.`,
      };
    }
    case "semantic_page_match": {
      return evaluateSemanticPageMatch(page, criterion, objective, semanticVerifier, lastActionEvidence, surfaceScoped);
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
      return {
        satisfied: false,
        evidenceSource: criterion.type,
        reason: `Criterion type "${criterion.type}" is not evaluated by the core engine.`,
      };
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
): Promise<SingleCriterionResult> {
  const match = parseMatchConfig(criterion.config);
  if (!match) {
    return { satisfied: false, evidenceSource: "data_layer_event", reason: "No config.match configured." };
  }
  const live = await readDataLayerSnapshot(page).catch(() => ({ available: false, raw: [] as Record<string, unknown>[] }));
  const candidates: readonly Record<string, unknown>[] = [
    ...(live.available ? live.raw : []),
    ...(criteriaEvidence?.dataLayerEntries ?? []),
  ];
  const matched = candidates.some((entry) => matchesEventFields(entry, match));
  const matchText = JSON.stringify(match);
  return {
    satisfied: matched,
    evidenceSource: "data_layer_event",
    matchedValue: matchText,
    reason: matched
      ? `A dataLayer entry matched config.match ${matchText}.`
      : `No dataLayer entry matched config.match ${matchText}.`,
  };
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
function evaluateNetworkEvent(criterion: SuccessCriterion, criteriaEvidence?: SuccessCriteriaEvidence): SingleCriterionResult {
  const match = parseMatchConfig(criterion.config);
  if (!match) {
    return { satisfied: false, evidenceSource: "network_event", reason: "No config.match configured." };
  }
  const candidates = criteriaEvidence?.networkEvents ?? [];
  const matched = candidates.some((entry) => {
    const params = entry.params;
    const flattened: Record<string, unknown> =
      typeof params === "object" && params !== null && !Array.isArray(params) ? { ...entry, ...params } : entry;
    return matchesEventFields(flattened, match);
  });
  const matchText = JSON.stringify(match);
  return {
    satisfied: matched,
    evidenceSource: "network_event",
    matchedValue: matchText,
    reason: matched
      ? `A network-event record matched config.match ${matchText}.`
      : `No network-event record matched config.match ${matchText}.`,
  };
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
  surfaceScoped?: boolean,
): Promise<SingleCriterionResult> {
  const anchorText = [objective, criterion.description].filter(Boolean).join(" ");
  if (!anchorText.trim()) {
    return {
      satisfied: false,
      evidenceSource: "semantic_page_match",
      reason: "Objective and criterion description were both empty; nothing to match against.",
    };
  }

  const minScore =
    typeof criterion.config?.minScore === "number" ? criterion.config.minScore : DEFAULT_SEMANTIC_MIN_SCORE;

  const configuredSignals = Array.isArray(criterion.config?.signals)
    ? criterion.config.signals.filter(isSemanticSignalName)
    : undefined;
  const signals: readonly SemanticSignalName[] =
    configuredSignals && configuredSignals.length > 0 ? configuredSignals : ALL_SEMANTIC_SIGNALS;

  const pageSignals = await gatherSemanticPageSignals(page, { scopeToUncoveredOnly: surfaceScoped === true });
  const score = scoreSemanticPageMatch(anchorText, pageSignals, signals);
  if (score.overall >= minScore) {
    return {
      satisfied: true,
      evidenceSource: "semantic_page_match:deterministic",
      score: score.overall,
      reason: `Deterministic vocabulary-overlap score ${score.overall.toFixed(2)} met minScore ${minScore}.`,
    };
  }

  if (!semanticVerifier) {
    return {
      satisfied: false,
      evidenceSource: "semantic_page_match:deterministic",
      score: score.overall,
      reason: `Deterministic vocabulary-overlap score ${score.overall.toFixed(2)} fell short of minScore ${minScore}; no semanticVerifier was configured.`,
    };
  }

  const verification = await semanticVerifier.verify({
    objective,
    criterionDescription: criterion.description,
    pageEvidence: pageSignals,
    ...(lastActionEvidence ? { lastActionEvidence } : {}),
  });
  return {
    satisfied: verification.satisfied,
    evidenceSource: "semantic_page_match:verifier",
    score: verification.confidence,
    reason: verification.satisfied
      ? `semanticVerifier confirmed a match (confidence ${verification.confidence.toFixed(2)}): ${verification.evidence}`
      : `semanticVerifier did not confirm a match (confidence ${verification.confidence.toFixed(2)}): ${verification.evidence}`,
  };
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
