import type { ReasoningContext } from "./reasoningProvider.js";
import type { ConsentInteractionPolicy } from "../types/task-request.js";
import { CONSENT_CONTROL_INTENTS } from "../types/consentControl.js";
import type { InteractiveElement, PromptElementSelectionDiagnostic } from "../types/task-response.js";
import { objectiveRelevanceScore } from "../discovery/relevance.js";
import { assessConsentSurface, classifyConsentControlPolarity } from "../safety/consentClassifier.js";

/**
 * Plain-language instruction for this run's consentInteractionPolicy (see
 * types/task-request.ts for the full policy doc). Deliberately generic: no CTA wordlist,
 * no vendor/CMP-specific attribute or selector, no translation table -- the same
 * language-agnostic semantic judgement the model already applies elsewhere (accessibleName
 * /type/ariaState, never a fixed word) is what it is asked to apply here too. The engine
 * enforces the vocabulary/domain/safety boundaries; which specific control best fits a
 * semantic description is left to the model, exactly like every other action choice in
 * this prompt.
 *
 * This instruction alone is never the sole enforcement of the policy (see
 * consentControlIntentClause below and src/safety/consentPolicyGuard.ts): every decision
 * must also self-classify its own consentControlIntent, which the engine checks
 * deterministically against this same policy before the action is ever dispatched, and
 * corrects via one bounded retry (or a safe stop) when the two disagree.
 */
function consentInteractionPolicyClause(policy: ConsentInteractionPolicy): string {
  switch (policy) {
    case "do_not_interact":
      return (
        "This run's consent-interaction policy is \"do_not_interact\": never click any control whose " +
        "semantic purpose is to manage consent or tracking preferences, even solely to clear a blocking " +
        "overlay -- if such a control is the only way to make progress, treat the objective-relevant " +
        "control as unreachable and choose accordingly from the allowed actions instead."
      );
    case "accept_optional":
      return (
        "This run's consent-interaction policy is \"accept_optional\": this is an explicit, caller-opted-in " +
        "instruction to actually grant optional consent, not merely a last resort for unblocking. When a " +
        "currently visible control's purpose is to grant optional/broad consent, prefer clicking it over a " +
        "control whose purpose is to decline optional consent or keep only necessary/essential functionality " +
        "-- choose the accepting control even when the objective could also be reached without granting " +
        "consent at all, because accepting optional consent is itself the desired outcome under this policy, " +
        "not something to avoid until forced. Never click a control whose purpose is unrelated to " +
        "consent/tracking preferences just to satisfy this policy, and never guess at or alter a granular " +
        "settings screen when a direct accept-optional control is already visible."
      );
    case "essential_only":
      return (
        "This run's consent-interaction policy is \"essential_only\": when clearing a blocking overlay is " +
        "necessary, prefer a control whose semantic purpose keeps only strictly required functionality " +
        "active and does not grant optional/broad consent; never click a control whose purpose is to grant " +
        "broad or optional consent, and never guess at or alter a granular settings screen."
      );
    case "reject_optional":
    default:
      return (
        "This run's consent-interaction policy is \"reject_optional\": when clearing a blocking overlay is " +
        "necessary, prefer a control whose semantic purpose is to decline, reject optional consent, or " +
        "continue without accepting. Choose that control over one whose purpose is to manage/customize " +
        "consent settings and over one that grants consent, even when a settings control is also visible and " +
        "looks like another path to the same outcome -- a settings/management control is not a substitute for " +
        "a direct decline-and-continue control when both are present. Never click a control whose purpose is " +
        "to grant broad or optional consent."
      );
  }
}

/**
 * Instruction for the decision schema's required consentControlIntent field (see
 * types/consentControl.ts and claudeDecisionSchema.ts): every decision, not only ones the
 * model already recognises as consent-related, must self-classify honestly so the engine
 * can deterministically check it against consentInteractionPolicy before dispatch. Same
 * generic, language-agnostic judgement as consentInteractionPolicyClause above -- no CTA
 * wordlist, no vendor/CMP-specific attribute.
 */
function consentControlIntentClause(): string {
  return (
    "Every decision must also set \"consentControlIntent\" to exactly one of " +
    `${JSON.stringify(CONSENT_CONTROL_INTENTS)}, classifying the action you are choosing (judged the same ` +
    "way as any other control's semantic purpose -- accessibleName/type/ariaState, never a fixed wordlist, " +
    "regardless of language): \"grants_optional_consent\" when its purpose is to accept/allow optional, " +
    "non-essential, or broad consent/tracking; \"declines_optional_consent\" when its purpose is to decline " +
    "optional consent, keep only necessary/essential functionality, or continue without granting broad " +
    "consent; \"opens_consent_settings\" when its purpose is to open a granular consent/preferences screen " +
    "without itself granting or declining anything; and \"not_consent_related\" for every other action -- " +
    "the correct value for the overwhelming majority of decisions. Classify honestly: never report " +
    "\"not_consent_related\" for a control whose purpose is actually consent-related, and never report a " +
    "granting/declining intent for a control that is not actually a consent/tracking-preference control."
  );
}

export type { PromptElementSelectionDiagnostic } from "../types/task-response.js";

// Bounds on what goes into the prompt — keeps it compact and caps token/cost growth on
// pages with unusually large numbers of elements or long histories.
const MAX_RECENT_ACTIONS = 5;
const MAX_NOTABLE_TEXT = 8;
const MAX_INTERACTIVE_ELEMENTS = 40;
// Route Memory (see core/routeMemory.ts): candidates are already sorted most-tried-first,
// so a truncation here always keeps whichever dead ends have been repeated the most --
// the strongest signal for "don't choose this again" -- ahead of a once-tried candidate.
const MAX_ROUTE_MEMORY_CANDIDATES = 10;
// Goal-Directed Bounded Branch Exploration: a task with a single milestone group (every
// pre-existing task, and any task with just one required success criterion) gets no
// "milestones" block in the prompt at all -- the rollup would be trivial ("1 of 1" or
// "0 of 1") and would only add tokens without adding decision-relevant information over
// what satisfiedCriteriaIds already conveys.
const MIN_MILESTONE_GROUPS_FOR_PROMPT = 2;

// At least this fraction of the cap is always reserved for structural/positional coverage
// (see selectPromptInteractiveElements below), even when lexical relevance alone could
// already fill the whole cap -- so a genuinely important control never loses its entire
// chance purely because many *other*, same-language elements happen to score higher.
const STRUCTURAL_RESERVE_FRACTION = 0.5;

// Always considered as structural candidates regardless of position/score -- see
// selectPromptInteractiveElements below for why.
const TAIL_ANCHOR_COUNT = 5;

// A zero-relevance element chosen by stratifiedSample as its stratum's sole structural
// representative can sit inside a small cluster of other zero-relevance elements that
// together form one real decision group (e.g. several sibling controls of one dismissible
// panel, possibly interleaved with a couple of purely informational links) -- picking only
// the stratum representative can silently split that group across the truncation boundary.
//
// REGRESSION (real production run, second occurrence): a fixed +/-2 index-distance
// neighbour pull (the first fix for this) still failed when the group's own primary
// decline/continue control sat 3 index positions away from the stratum-selected anchor
// (two informational links in between it and the manage/accept controls) -- outside that
// fixed radius, so it was dropped anyway. Simply enlarging that fixed radius was rejected:
// nothing in the existing, generic observation data distinguishes "a slightly wider but
// still small decision group" from "the start of a long, unrelated, repetitive list" using
// distance alone, so any single fixed radius large enough to always cover a wider group is
// also large enough to start pulling in unrelated bulk content near it.
//
// The existing Observation/InteractiveElement contract carries no explicit DOM-container/
// ancestor identifier (see schemas/task-response.schema.json's interactiveElements items,
// additionalProperties:false) -- adding one would be a wire-schema change, so true
// container-aware grouping is not available from existing observation data without one.
// The fix below is the smallest bounded alternative that stays entirely within the
// existing data: instead of a fixed radius, it walks outward from the stratum
// representative through the *natural* contiguous run of zero-relevance elements
// surrounding it (a run ends the moment a relevance-scored element, an already-selected
// index, or the array boundary is hit) -- a compact run of interactive elements with
// nothing else scored in between is model-agnostic proxy evidence that they likely all
// belong to one small, nearby structural unit (e.g. one dialog/overlay), since an
// unrelated repetitive list of any real size is exceedingly unlikely to be *entirely*
// zero-relevance AND *entirely* uninterrupted for its whole length by the time truncation
// is even being considered (MAX_INTERACTIVE_ELEMENTS elements already dominate the page).
//
// Still, a natural run alone is not proof of anything -- a long, genuinely repetitive,
// entirely zero-relevance section (e.g. 90 near-identical filler controls) produces
// exactly this same "uninterrupted run" shape. MAX_CONTAINER_SPAN is the hard cutoff that
// keeps this safe either way: the whole natural run is only ever included when its total
// length is at or below this cap; a run *longer* than the cap is indistinguishable, from
// this data alone, from ordinary bulk/repeated content, so it contributes nothing beyond
// the stratum representative itself -- this is precisely what stops an unbounded section
// of the page from ever being pulled into the prompt by this mechanism, regardless of how
// long an unrelated repetitive run happens to be.
const MAX_CONTAINER_SPAN = 8;

// MAX_GROUP_ADDITIONS: hard ceiling, across one selectPromptInteractiveElements call, on
// how many extra elements group-inclusion can add beyond the normal tier-budgeted
// selection -- a defense-in-depth backstop on top of MAX_CONTAINER_SPAN (which already
// bounds any single group): keeps the existing prompt-budget protections intact even if
// several small groups are recovered in the same call. Worst case, selectedCount is
// `limit + MAX_GROUP_ADDITIONS`, never unbounded.
const MAX_GROUP_ADDITIONS = 10;

// Candidate-selection redesign (corrective pass, see CLAUDE.md and docs/architecture.md
// "The 40-element limit"): a bounded, separate top-up pass, applied *after* the existing
// relevance/structural selection above, that guarantees inclusion of any element strongly
// matching the currently-unresolved milestone specifically (not just the whole objective +
// every criterion's text blended together, which selectPromptInteractiveElements's existing
// `relevant` tier already uses and which a single unresolved milestone's own wording can
// still lose out to under the fixed STRUCTURAL_RESERVE_FRACTION split). Reuses the same
// MIN_DOMINANT_RELEVANCE_SCORE-style threshold core/branchExploration.ts already uses for
// "is this a genuinely strong, not merely incidental, lexical match" -- an independently
// chosen value for this different scorer, not the same literal constant reused blindly.
// Bounded by MAX_GUARANTEED_INCLUSION_ADDITIONS so this can never itself become an
// unbounded expansion -- the adaptive cap the task requires stays a small, fixed ceiling,
// never "send everything".
const GUARANTEED_INCLUSION_MIN_SCORE = 0.5;
const MAX_GUARANTEED_INCLUSION_ADDITIONS = 10;

/**
 * Walks outward from `anchorIndex` through the *natural* contiguous run of zero-relevance,
 * not-yet-selected elements surrounding it (see MAX_CONTAINER_SPAN's doc comment above for
 * why this is a safe, generic, language-independent proxy for "shares one small nearby
 * structural container"). Returns the run's member indices (anchor included) in ascending
 * order, or just `[anchorIndex]` when the natural run exceeds MAX_CONTAINER_SPAN -- a run
 * that long is treated as ordinary bulk/repeated content, not a compact decision group, so
 * nothing beyond the anchor itself is ever added for it.
 */
function containerGroupIndices(anchorIndex: number, zeroScoreByIndex: ReadonlyMap<number, ScoredElement>): number[] {
  // The natural run's true extent is found unbounded (never truncated mid-walk) so a run
  // longer than MAX_CONTAINER_SPAN is rejected outright rather than silently clipped to an
  // arbitrary partial slice of what is, by construction, indistinguishable from ordinary
  // bulk/repeated content once it's that long.
  let lo = anchorIndex;
  while (zeroScoreByIndex.has(lo - 1)) {
    lo -= 1;
  }
  let hi = anchorIndex;
  while (zeroScoreByIndex.has(hi + 1)) {
    hi += 1;
  }

  if (hi - lo + 1 > MAX_CONTAINER_SPAN) {
    return [anchorIndex];
  }

  const indices: number[] = [];
  for (let i = lo; i <= hi; i += 1) {
    indices.push(i);
  }
  return indices;
}

interface ScoredElement {
  el: InteractiveElement;
  index: number;
  score: number;
}

function hasPersistedSelectionState(el: InteractiveElement): boolean {
  if (!el.ariaState) {
    return false;
  }
  return "aria-selected" in el.ariaState || "aria-checked" in el.ariaState || "aria-pressed" in el.ariaState;
}

/**
 * Spreads `k` picks across the *entire* index range of `pool` (assumed sorted ascending by
 * `index`), not just its DOM-order prefix -- a purely positional, generic signal: no text,
 * brand, or language dependency. Within each stratum, prefers an enabled element with no
 * persisted ARIA selection/toggle state (aria-selected/checked/pressed) -- a generic proxy
 * for "represents an available action" over "an already-selected product option" (an
 * option control is typically part of a selectable set and so commonly carries one of
 * these attributes; a plain action control typically does not). Falls back to the
 * stratum's first element when every candidate in it is disabled or option-like, so a
 * region with only option-like controls still contributes some coverage rather than none.
 */
function stratifiedSample(pool: readonly ScoredElement[], k: number): ScoredElement[] {
  if (k <= 0 || pool.length === 0) {
    return [];
  }
  if (pool.length <= k) {
    return [...pool];
  }

  const picks: ScoredElement[] = [];
  const usedIndices = new Set<number>();
  const step = pool.length / k;
  for (let i = 0; i < k; i += 1) {
    const start = Math.floor(i * step);
    const end = Math.max(start + 1, Math.floor((i + 1) * step));
    const stratum = pool.slice(start, end);
    const isActionable = (s: ScoredElement) => s.el.visible !== false && !s.el.disabled && !s.el.covered;
    const preferred =
      stratum.find((s) => isActionable(s) && !hasPersistedSelectionState(s.el)) ??
      stratum.find((s) => isActionable(s)) ??
      stratum[0];
    if (preferred && !usedIndices.has(preferred.index)) {
      picks.push(preferred);
      usedIndices.add(preferred.index);
    }
  }
  return picks;
}

/**
 * REGRESSION (real production configurator runs, schemaVersion 1.3.0): a page with more
 * than MAX_INTERACTIVE_ELEMENTS visible interactive elements silently dropped the
 * terminal-route controls a run needed from Navigation Claude's actual prompt. The first
 * fix for this (lexical objective-relevance ranking, `objectiveRelevanceScore`) resolved
 * the same-language case but does **not** help when the task's objective is written in a
 * different language than the page: tokenize() (src/discovery/relevance.ts) splits on any
 * non-[a-z0-9] character, so an accented or non-English label frequently shares zero
 * literal tokens with an objective written in a different language, even when they mean
 * the same thing (verified: a short accented label can score 0 relevance against an
 * objective describing the same real-world control in another language, tying it with
 * ordinary unrelated filler content) -- at that point the *previous* behaviour (a bare
 * DOM-index tie-break) determines survival again, and a control positioned late in DOM
 * order (as a real terminal control very often is, appearing after
 * every earlier configuration step's own controls) is displaced by whatever merely
 * happens to appear earlier.
 *
 * The fix below never tries to bridge languages lexically (no CTA dictionary or
 * translation table is introduced -- that would violate this repo's non-negotiable
 * genericity rule). Instead, when there are more elements than the cap, selection combines
 * three fully generic, language-independent signals:
 *
 * 1. Lexical relevance (existing mechanism, kept, still first priority) -- catches the
 *    same-language case cheaply and precisely.
 * 2. A small fixed number of elements at the very end of DOM order are always considered
 *    as structural candidates ("tail anchors") -- a plain positional fact (a page's
 *    primary continuation/completion control is conventionally among the last interactive
 *    elements of a linear step's content, after every earlier option/spec control), not a
 *    text or brand signal.
 * 3. The remaining structural budget is a stratified sample spread across the *entire*
 *    remaining element range (not just its DOM-order prefix), so a control positioned
 *    anywhere on the page -- not only at the very end -- still has a bounded chance of
 *    inclusion, and so no single contiguous run of repetitive/filler elements can consume
 *    the entire prompt allowance (every region of the page contributes at most its
 *    proportional share of slots).
 *
 * At least STRUCTURAL_RESERVE_FRACTION of the cap is always reserved for (2)+(3)
 * regardless of how many elements already score positively on relevance, so a genuinely
 * important but zero-relevance-scoring control never loses one hundred percent of its
 * chance to a pile of same-language-but-otherwise-unimportant relevant matches either.
 */

/**
 * Selects which interactive elements survive MAX_INTERACTIVE_ELEMENTS truncation, and
 * returns a small, bounded diagnostic explaining what was selected and why -- never the
 * full observation, never unselected elements beyond a capped excluded-relevant count, so
 * this stays cheap to carry even on a page with hundreds of interactive elements. See
 * TaskResponse.diagnostics.reasoningProvider.decisions[].promptElementSelection.
 */
function selectPromptInteractiveElements(
  elements: readonly InteractiveElement[],
  relevanceText: string,
  limit: number,
  hasActiveDialog: boolean,
  activeMilestoneText?: string,
): { selected: readonly InteractiveElement[]; diagnostic: PromptElementSelectionDiagnostic } {
  if (elements.length <= limit) {
    return {
      selected: elements,
      diagnostic: {
        candidateCount: elements.length,
        selectedCount: elements.length,
        relevantSelectedCount: 0,
        structuralSelectedCount: elements.length,
        excludedRelevantCount: 0,
        guaranteedInclusionCount: 0,
        truncationStrategy: "none",
        selected: elements.map((el) => ({ id: el.id, accessibleName: el.accessibleName, reason: "structural" })),
      },
    };
  }

  const scored: ScoredElement[] = elements.map((el, index) => ({
    el,
    index,
    score: objectiveRelevanceScore(relevanceText, el.accessibleName),
  }));
  const relevant = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const structuralBudget = Math.max(Math.ceil(limit * STRUCTURAL_RESERVE_FRACTION), limit - relevant.length);
  const relevantTaken = relevant.slice(0, Math.max(0, limit - structuralBudget));
  const takenIndices = new Set(relevantTaken.map((s) => s.index));

  // Modal-aware prompt-selection fix (see CLAUDE.md and docs/architecture.md "Modal-aware
  // observation"): while a dialog/modal is active, a zero-relevance *covered* element is
  // background page chrome the user cannot currently interact with at all -- excluded from
  // the structural (non-lexical) pools entirely so it can never consume the fixed
  // STRUCTURAL_RESERVE_FRACTION budget a genuinely reachable control (inside the dialog, or
  // simply not covered) needs. A covered element that still scores positively on lexical
  // relevance is unaffected -- it remains reachable via relevantTaken above, matching the
  // existing "prefer an uncovered control, but a covered one can still matter" prompt
  // guidance below.
  const zeroScorePool = scored.filter(
    (s) => s.score === 0 && !takenIndices.has(s.index) && !(hasActiveDialog && s.el.covered),
  );
  const remainingBudget = limit - relevantTaken.length;
  const tailAnchors = zeroScorePool.slice(-TAIL_ANCHOR_COUNT).slice(0, remainingBudget);
  const anchoredIndices = new Set(tailAnchors.map((s) => s.index));
  const strataPool = zeroScorePool.filter((s) => !anchoredIndices.has(s.index));
  const stratified = stratifiedSample(strataPool, remainingBudget - tailAnchors.length);

  const structuralTaken = [...tailAnchors, ...stratified];
  const preNeighborIndices = new Set([...relevantTaken, ...structuralTaken].map((s) => s.index));

  // See MAX_NEIGHBOR_DISTANCE/MAX_NEIGHBOR_ADDITIONS above: pull in a bounded number of each
  // stratifiedSample pick's immediate DOM-order neighbours so a tight cluster of
  // zero-relevance elements that together form one decision group isn't split across the
  // stratum boundary that happened to select only one of them.
  const zeroScoreByIndex = new Map<number, ScoredElement>(zeroScorePool.map((s) => [s.index, s]));
  const neighborsTaken: ScoredElement[] = [];
  for (const anchor of [...stratified].sort((a, b) => a.index - b.index)) {
    if (neighborsTaken.length >= MAX_GROUP_ADDITIONS) {
      break;
    }
    for (const memberIndex of containerGroupIndices(anchor.index, zeroScoreByIndex)) {
      if (neighborsTaken.length >= MAX_GROUP_ADDITIONS) {
        break;
      }
      if (memberIndex === anchor.index) {
        continue;
      }
      const member = zeroScoreByIndex.get(memberIndex);
      if (member && !preNeighborIndices.has(member.index)) {
        neighborsTaken.push(member);
        preNeighborIndices.add(member.index);
      }
    }
  }

  const preGuaranteedSelected = [...relevantTaken, ...structuralTaken, ...neighborsTaken].sort((a, b) => a.index - b.index);
  const preGuaranteedIndices = new Set(preGuaranteedSelected.map((s) => s.index));
  const excludedRelevant = relevant.filter((s) => !preGuaranteedIndices.has(s.index));

  // Guaranteed-inclusion top-up (see MAX_GUARANTEED_INCLUSION_ADDITIONS above): elements
  // strongly matching the specific, currently-unresolved milestone that the ordinary
  // relevance/structural budgets above still dropped. Applied on top of, never instead of,
  // everything already selected -- this can only add elements, never remove one already
  // chosen for another reason.
  const guaranteedTaken: ScoredElement[] = [];
  if (activeMilestoneText) {
    for (const s of scored) {
      if (guaranteedTaken.length >= MAX_GUARANTEED_INCLUSION_ADDITIONS) {
        break;
      }
      if (preGuaranteedIndices.has(s.index)) {
        continue;
      }
      if (objectiveRelevanceScore(activeMilestoneText, s.el.accessibleName) >= GUARANTEED_INCLUSION_MIN_SCORE) {
        guaranteedTaken.push(s);
      }
    }
  }
  const guaranteedIndices = new Set(guaranteedTaken.map((s) => s.index));

  const selected = [...preGuaranteedSelected, ...guaranteedTaken].sort((a, b) => a.index - b.index);
  const selectedIndices = new Set(selected.map((s) => s.index));
  const stillOmittedRelevant = excludedRelevant.filter((s) => !selectedIndices.has(s.index));

  return {
    selected: selected.map((s) => s.el),
    diagnostic: {
      candidateCount: elements.length,
      selectedCount: selected.length,
      relevantSelectedCount: relevantTaken.length,
      structuralSelectedCount: structuralTaken.length + neighborsTaken.length,
      excludedRelevantCount: stillOmittedRelevant.length,
      guaranteedInclusionCount: guaranteedTaken.length,
      truncationStrategy: "relevance+structural-reserve+container-groups+guaranteed-milestone-match",
      ...(stillOmittedRelevant.length > 0
        ? {
            omissionReason:
              "relevant candidate ranked below the reserved structural budget and did not clear the " +
              "guaranteed-inclusion threshold against the active milestone",
          }
        : {}),
      selected: selected.map((s) => ({
        id: s.el.id,
        accessibleName: s.el.accessibleName,
        reason: takenIndices.has(s.index) ? "relevant" : guaranteedIndices.has(s.index) ? "relevant" : "structural",
      })),
    },
  };
}

export interface ReasoningPrompt {
  system: string;
  user: string;
  elementSelection: PromptElementSelectionDiagnostic;
}

/**
 * Builds the compact prompt sent to the reasoning model. Only reads fields already
 * present on the engine's Observation/ReasoningContext types — never raw HTML, cookies,
 * storage, headers, or auth values, since none of those are reachable from this
 * function's input in the first place.
 */
export function buildReasoningPrompt(context: ReasoningContext): ReasoningPrompt {
  const {
    objective,
    successCriteria,
    allowedActions,
    allowedDomains,
    limits,
    observation,
    recentActions,
    satisfiedCriteriaIds,
    consentInteractionPolicy,
    routeMemory,
    milestones,
    branch,
    alternativeExploration,
  } = context;

  const system =
    "You are the decision component of an automated browser-navigation engine. " +
    "On each turn you choose exactly one next action for the current page, from a fixed, " +
    "closed vocabulary given to you as \"allowedActions\". You must never invent an action " +
    "outside that list, and never produce JavaScript, Playwright code, CSS/XPath selectors, " +
    "shell commands, or a URL whose host is not listed in \"allowedDomains\". You only see a " +
    "compact structured summary of the page, never raw HTML. Base your decision only on the " +
    "information given here, be concise in your reason, and give an honest confidence for " +
    "how sure you are that this action moves toward the objective. Before choosing \"scroll\", " +
    "check whether a currently visible and enabled control in \"interactiveElements\" already " +
    "has a semantic purpose (judged from its accessibleName/type/ariaState, not from a fixed " +
    "wordlist, and regardless of what language its label is written in) that matches what " +
    "the objective and successCriteria ask for next -- if one does, prefer selecting it over " +
    "scrolling. Only choose \"scroll\" when no visible control yet matches, or when " +
    "\"recentActions\" shows scrolling has genuinely been revealing new elements; if you've " +
    "recently scrolled without \"currentPage\" changing in a way that helps, say so in your " +
    "reason and prefer a different action. An entry in \"recentActions\" marked " +
    "\"observedProgress\": false means that when that exact action last ran, the page's URL " +
    "and title were unchanged the next time it was observed -- treat that as evidence the " +
    "same action is unlikely to help if chosen again, and prefer a different action instead " +
    "of repeating it verbatim. An entry in \"recentActions\" marked \"surfaceChangeType\" " +
    "(e.g. \"dialog_appeared\", \"layer_panel_appeared\") means that action opened a new " +
    "panel, drawer, or overlay -- the current \"currentPage\" observation reflects that new " +
    "surface, so prioritise its newly-introduced controls over whatever was on the page " +
    "immediately beforehand, even when \"currentPage\" has no \"activeDialog\" value (many " +
    "drawers/side panels are not marked up as a standards-based dialog at all). " +
    "When present, \"routeMemory\" lists candidate actions " +
    "(click/navigate) already tried earlier at this exact decision point -- the same page " +
    "location and set of available controls, however many steps ago, including after going " +
    "back and returning here -- with how many times each was tried and its most recent " +
    "outcome: \"advanced\" (the page moved forward), \"no_change\" (nothing observably " +
    "changed), \"failed\" (the action could not be executed), or \"blocked\" (a safety rule " +
    "rejected it). A routeMemory entry may also show \"branchResult\" (with " +
    "\"branchDepthReached\") -- the accumulated result of following that candidate several " +
    "steps deep in an earlier bounded branch: \"dead_end\", \"blocked\", or \"unsafe\" means " +
    "that whole direction was already explored and did not work out, not just that one " +
    "click failed. Prefer a control not listed in \"routeMemory\" at all, or one whose " +
    "lastOutcome is \"advanced\", over repeating one whose lastOutcome is \"no_change\", " +
    "\"failed\", or \"blocked\", or whose branchResult is \"dead_end\", \"blocked\", or " +
    "\"unsafe\" -- unless every other option has already been exhausted too. " +
    "An interactiveElements entry marked " +
    "\"covered\": true currently has some other element sitting on top of it and cannot " +
    "actually be clicked -- when an uncovered control also matches the objective, prefer " +
    "that uncovered control over a covered one. Only choose a covered control when clearing " +
    "whatever is covering the page is itself a necessary step before the objective can be " +
    "reached, and remember that dismissing or clearing a covering element is never itself " +
    "the objective -- it only clears the way for a later action that is. When \"currentPage\" " +
    "includes \"activeDialog\", a dialog/modal surface is currently open on top of the page " +
    "-- prefer its own controls (they appear in \"interactiveElements\" like any other " +
    "control) over background page controls, which are frequently covered and unreachable " +
    "while it stays open; close or dismiss it only when doing so is itself necessary to " +
    "reach the objective. " +
    consentInteractionPolicyClause(consentInteractionPolicy) +
    " " +
    consentControlIntentClause() +
    " When \"currentPage\" includes \"consentControls\", those entries are the engine's own " +
    "independent, deterministic classification (from visible text/role, never a selector) of " +
    "which currently-visible controls are accept-all/decline/settings-purposed consent " +
    "controls -- consult it as corroborating evidence for consentControlIntent above, and " +
    "note that the engine verifies your choice against this same classification " +
    "independently of what you report. " +
    " When more than one visible control could " +
    "plausibly apply, choose the one whose semantic purpose most specifically matches the " +
    "objective/successCriteria wording (for example: prefer whichever of a " +
    "\"summary\"-purposed control or a \"continue\"-purposed control the objective actually " +
    "asks for, in whatever language or label the page itself uses) -- never a control whose " +
    "purpose looks like a purchase, payment, order, booking, lead submission, or any other " +
    "personal-data/contractual action, regardless of what the objective asks for. When two " +
    "or more entries in \"successCriteria\" share the same \"group\" value, they are " +
    "alternatives -- satisfying any one of them is enough to satisfy that whole group, so " +
    "you do not need every member of a group to hold at once. An intermediate action's " +
    "accessible name does not need to share any words with the objective or " +
    "\"successCriteria\" to be worth choosing -- a detail, continuation, or exploration " +
    "action can be a legitimate step toward the objective even when its own label looks " +
    "unrelated; judge its plausibility from where it is likely to lead (its role, its " +
    "\"destinationUrl\" when present, and what \"activeSubGoal\" in \"milestones\" still " +
    "needs), not from label similarity alone. When \"branch\" is present, you are currently " +
    "following such a candidate: keep choosing the next reasonable action within it while " +
    "it keeps producing new, relevant evidence, but abandon it -- by choosing \"go_back\", " +
    "or a \"stop_*\" action if that is not currently allowed -- once evidence clearly stops " +
    "supporting the active sub-goal, required context looks lost, or nothing safe and " +
    "plausible remains; the engine independently enforces a bounded depth regardless of " +
    "what you choose. When \"milestones\" is present, treat its \"completed\" entries as " +
    "permanently established regardless of what a later branch does -- a branch that fails " +
    "never undoes an already-completed milestone -- and focus on \"activeSubGoal\". Never " +
    "assert that a milestone or the objective itself is complete yourself; only the " +
    "engine's own evaluation of \"successCriteria\" decides that. When \"alternativeExploration\" " +
    "is present, its \"justFailedLabels\" name one or more controls this run already tried " +
    "that did not lead to progress -- do not re-select any of them; instead choose a " +
    "different visible control that could plausibly serve the same objective (for example a " +
    "sibling call-to-action offering a related path -- a finance/valuation/test-drive/" +
    "brochure-style control when a quote-style control did not work out, or vice versa), " +
    "before concluding the objective is unreachable from this page.";

  const { selected: interactiveElements, diagnostic: elementSelection } = selectPromptInteractiveElements(
    observation.interactiveElements,
    [objective, ...successCriteria.map((c) => c.description)].filter(Boolean).join(" "),
    MAX_INTERACTIVE_ELEMENTS,
    Boolean(observation.activeDialog),
    milestones?.activeSubGoal?.description,
  );

  // Candidate-selection redesign (see CLAUDE.md and docs/architecture.md "The 40-element
  // limit", requirement 5): consent controls are surfaced as their own clearly-labelled
  // category, using the same deterministic, generic DOM-pattern classification the engine
  // itself now independently verifies a consent action against (src/safety/
  // consentClassifier.ts) -- never a second, model-facing wordlist. Computed over every
  // candidate element (not just the ones selectPromptInteractiveElements happened to keep),
  // so a consent control can never be crowded out of this category by an unrelated page's
  // worth of other controls; bounded implicitly (a real consent surface offers a handful of
  // controls, never hundreds). Purely additive labelling -- every consent control listed
  // here is still also a normal, selectable entry in interactiveElements when it survived
  // that selection; this category exists so the model (and a diagnostics reader) can find
  // it without having to re-derive polarity from label text itself.
  // Gated on assessConsentSurface's own genuine-surface check (consent-context evidence
  // *and* a real accept/decline-or-settings choice shape) -- never a bare per-element label
  // match. Without this gate, an unrelated control whose label happens to contain a short
  // polarity word (e.g. "Allow location access") would be mislabelled as a consent control
  // with no corroborating page context at all -- exactly the false-positive risk this
  // module's own doc comment on classifyConsentControlPolarity warns against trusting on
  // its own.
  const consentSurfaceAssessment = assessConsentSurface(observation);
  const consentControls = consentSurfaceAssessment.surfaceDetected
    ? observation.interactiveElements
        .filter((el) => el.visible !== false && !el.disabled)
        .map((el) => {
          const classified = classifyConsentControlPolarity(el.accessibleName);
          return classified ? { id: el.id, label: el.accessibleName, polarity: classified.polarity } : undefined;
        })
        .filter((c): c is { id: string; label: string; polarity: "accept_all" | "decline" | "settings" } => Boolean(c))
    : [];

  const payload = {
    objective,
    successCriteria: successCriteria.map((c) => ({
      id: c.id,
      description: c.description,
      required: c.required !== false,
      ...(c.group ? { group: c.group } : {}),
    })),
    satisfiedCriteriaIds,
    allowedActions,
    allowedDomains,
    limits: {
      stepsRemaining: Math.max(0, limits.maxSteps - limits.stepsUsed),
      backtracksRemaining: Math.max(0, limits.maxBacktracks - limits.backtracksUsed),
    },
    currentPage: {
      url: observation.url,
      title: observation.title,
      notableText: (observation.notableText ?? []).slice(0, MAX_NOTABLE_TEXT),
      ...(observation.progressIndicatorText ? { progressIndicatorText: observation.progressIndicatorText } : {}),
      ...(observation.activeDialog ? { activeDialog: observation.activeDialog } : {}),
      ...(consentControls.length > 0 ? { consentControls } : {}),
      interactiveElements: interactiveElements.map((el) => ({
        id: el.id,
        type: el.role,
        accessibleName: el.accessibleName,
        visible: el.visible !== false,
        ...(el.destinationUrl ? { destinationUrl: el.destinationUrl } : {}),
        ...(el.disabled ? { disabled: el.disabled } : {}),
        ...(el.ariaState ? { ariaState: el.ariaState } : {}),
        ...(el.covered ? { covered: el.covered } : {}),
        // Nested/repeated-control disambiguation (Phase 3 PR 3, see CLAUDE.md and
        // docs/architecture.md "Surface adoption"): the nearest enclosing heading's text
        // (observation/observationBuilder.ts) already disambiguates route-memory candidate
        // identity (see core/routeMemory.ts's buildClickIdentityKey) for a control repeated
        // across several cards/list-items with no destinationUrl of its own -- but that
        // identity is never itself shown to the reasoning layer, so two visually identical
        // "Select"-labelled buttons under different cards previously looked completely
        // indistinguishable in this very payload. Surfacing it here (verbatim, the same
        // bounded <=80-char text, never a selector or brand-specific marker) lets the model
        // actually tell them apart when choosing between them, not just lets route memory
        // track them apart after the fact.
        ...(el.nearestHeadingText ? { nearestHeadingText: el.nearestHeadingText } : {}),
      })),
    },
    recentActions: recentActions.slice(-MAX_RECENT_ACTIONS).map((a) => ({
      type: a.type,
      target: a.target,
      observedProgress: a.observedProgress,
      ...(a.surfaceChangeType ? { surfaceChangeType: a.surfaceChangeType } : {}),
    })),
    ...(routeMemory && routeMemory.length > 0
      ? {
          routeMemory: routeMemory.slice(0, MAX_ROUTE_MEMORY_CANDIDATES).map((c) => ({
            type: c.actionType,
            label: c.label,
            attempts: c.attempts,
            lastOutcome: c.lastOutcome,
            ...(c.branchResult
              ? { branchResult: c.branchResult, branchDepthReached: c.branchDepthReached }
              : {}),
          })),
        }
      : {}),
    // Goal-Directed Bounded Branch Exploration: omitted entirely (never a trivial
    // single-milestone rollup) when the task declares fewer than two milestone groups --
    // the common case, and every pre-existing task -- so an ordinary run's prompt payload
    // is byte-for-byte unaffected by this field's existence. See MIN_MILESTONE_GROUPS_FOR_PROMPT.
    ...(milestones && milestones.totalMilestones >= MIN_MILESTONE_GROUPS_FOR_PROMPT
      ? {
          milestones: {
            completedMilestones: milestones.completedMilestones,
            totalMilestones: milestones.totalMilestones,
            ...(milestones.activeSubGoal ? { activeSubGoal: milestones.activeSubGoal } : {}),
          },
        }
      : {}),
    ...(branch ? { branch } : {}),
    ...(alternativeExploration ? { alternativeExploration } : {}),
  };

  return { system, user: JSON.stringify(payload), elementSelection };
}
