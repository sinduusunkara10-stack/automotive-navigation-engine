import type { ReasoningContext } from "./reasoningProvider.js";
import type { ConsentInteractionPolicy } from "../types/task-request.js";
import type { InteractiveElement, PromptElementSelectionDiagnostic } from "../types/task-response.js";
import { objectiveRelevanceScore } from "../discovery/relevance.js";

/**
 * Plain-language instruction for this run's consentInteractionPolicy (see
 * types/task-request.ts for the full policy doc). Deliberately generic: no CTA wordlist,
 * no vendor/CMP-specific attribute or selector, no translation table -- the same
 * language-agnostic semantic judgement the model already applies elsewhere (accessibleName
 * /type/ariaState, never a fixed word) is what it is asked to apply here too. The engine
 * enforces the vocabulary/domain/safety boundaries; which specific control best fits a
 * semantic description is left to the model, exactly like every other action choice in
 * this prompt.
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
        "This run's consent-interaction policy is \"accept_optional\": you may click a control that grants " +
        "optional consent, but only when doing so is genuinely necessary to clear a blocking overlay that " +
        "prevents reaching the objective -- never when the objective is already reachable without it, and " +
        "never for a control whose purpose is unrelated to consent/tracking preferences."
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

export type { PromptElementSelectionDiagnostic } from "../types/task-response.js";

// Bounds on what goes into the prompt — keeps it compact and caps token/cost growth on
// pages with unusually large numbers of elements or long histories.
const MAX_RECENT_ACTIONS = 5;
const MAX_NOTABLE_TEXT = 8;
const MAX_INTERACTIVE_ELEMENTS = 40;

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

  const zeroScorePool = scored.filter((s) => s.score === 0 && !takenIndices.has(s.index));
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

  const selected = [...relevantTaken, ...structuralTaken, ...neighborsTaken].sort((a, b) => a.index - b.index);
  const selectedIndices = new Set(selected.map((s) => s.index));
  const excludedRelevant = relevant.filter((s) => !selectedIndices.has(s.index));

  return {
    selected: selected.map((s) => s.el),
    diagnostic: {
      candidateCount: elements.length,
      selectedCount: selected.length,
      relevantSelectedCount: relevantTaken.length,
      structuralSelectedCount: structuralTaken.length + neighborsTaken.length,
      excludedRelevantCount: excludedRelevant.length,
      selected: selected.map((s) => ({
        id: s.el.id,
        accessibleName: s.el.accessibleName,
        reason: takenIndices.has(s.index) ? "relevant" : "structural",
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
    "reason and prefer a different action. An interactiveElements entry marked " +
    "\"covered\": true currently has some other element sitting on top of it and cannot " +
    "actually be clicked -- when an uncovered control also matches the objective, prefer " +
    "that uncovered control over a covered one. Only choose a covered control when clearing " +
    "whatever is covering the page is itself a necessary step before the objective can be " +
    "reached, and remember that dismissing or clearing a covering element is never itself " +
    "the objective -- it only clears the way for a later action that is. " +
    consentInteractionPolicyClause(consentInteractionPolicy) +
    " When more than one visible control could " +
    "plausibly apply, choose the one whose semantic purpose most specifically matches the " +
    "objective/successCriteria wording (for example: prefer whichever of a " +
    "\"summary\"-purposed control or a \"continue\"-purposed control the objective actually " +
    "asks for, in whatever language or label the page itself uses) -- never a control whose " +
    "purpose looks like a purchase, payment, order, booking, lead submission, or any other " +
    "personal-data/contractual action, regardless of what the objective asks for. When two " +
    "or more entries in \"successCriteria\" share the same \"group\" value, they are " +
    "alternatives -- satisfying any one of them is enough to satisfy that whole group, so " +
    "you do not need every member of a group to hold at once.";

  const { selected: interactiveElements, diagnostic: elementSelection } = selectPromptInteractiveElements(
    observation.interactiveElements,
    [objective, ...successCriteria.map((c) => c.description)].filter(Boolean).join(" "),
    MAX_INTERACTIVE_ELEMENTS,
  );

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
      interactiveElements: interactiveElements.map((el) => ({
        id: el.id,
        type: el.role,
        accessibleName: el.accessibleName,
        visible: el.visible !== false,
        ...(el.destinationUrl ? { destinationUrl: el.destinationUrl } : {}),
        ...(el.disabled ? { disabled: el.disabled } : {}),
        ...(el.ariaState ? { ariaState: el.ariaState } : {}),
        ...(el.covered ? { covered: el.covered } : {}),
      })),
    },
    recentActions: recentActions.slice(-MAX_RECENT_ACTIONS).map((a) => ({ type: a.type, target: a.target })),
  };

  return { system, user: JSON.stringify(payload), elementSelection };
}
