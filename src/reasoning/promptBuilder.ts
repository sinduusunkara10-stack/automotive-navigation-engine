import type { ReasoningContext } from "./reasoningProvider.js";
import type { InteractiveElement } from "../types/task-response.js";
import { objectiveRelevanceScore } from "../discovery/relevance.js";

// Bounds on what goes into the prompt — keeps it compact and caps token/cost growth on
// pages with unusually large numbers of elements or long histories.
const MAX_RECENT_ACTIONS = 5;
const MAX_NOTABLE_TEXT = 8;
const MAX_INTERACTIVE_ELEMENTS = 40;

/**
 * REGRESSION (real production configurator run, schemaVersion 1.3.0): a page with more
 * than MAX_INTERACTIVE_ELEMENTS visible interactive elements (nav, footer, filter chips,
 * cookie banner, language switcher, ...) silently dropped the terminal-route controls the
 * run needed from Navigation Claude's prompt, because the previous cutoff was a raw
 * positional `.slice(0, N)` in DOM-scan
 * order -- it had no relevance to the objective at all. Navigation Claude never saw the
 * controls it needed and repeatedly chose scroll instead, until the (correctly-firing,
 * unmodified) repeated-action guard blocked the run.
 *
 * The diagnostic `StepLog.observation` the caller sees in Get Task Result is never
 * truncated (see src/core/loop.ts/observationBuilder.ts) -- only this function's own
 * prompt payload is. That mismatch is exactly what made the earlier bug invisible: the
 * controls were genuinely present in the (untruncated) observation the caller inspected,
 * but not in what the model actually received.
 *
 * The fix: when there are more elements than the cap, rank them by the same generic,
 * brand/language-agnostic token-overlap relevance score src/discovery/relevance.ts already
 * uses for preflight domain-discovery candidates (`objectiveRelevanceScore`, scored against
 * this task's own objective + successCriteria description text -- never a hardcoded CTA
 * word, translation, or brand name), keep the top-scoring elements up to the cap, and then
 * restore their original DOM order in what's actually sent (keeps the page's logical
 * structure legible to the model; ranking only decides *which* elements survive, not the
 * order they're presented in). Elements with zero relevance still fill any remaining slots
 * in their original order, so an early exploratory step (where nothing yet overlaps the
 * objective's vocabulary) degrades to today's original behaviour rather than sending an
 * empty list.
 */
function selectPromptInteractiveElements(
  elements: readonly InteractiveElement[],
  relevanceText: string,
  limit: number,
): readonly InteractiveElement[] {
  if (elements.length <= limit) {
    return elements;
  }
  return elements
    .map((el, index) => ({ el, index, score: objectiveRelevanceScore(relevanceText, el.accessibleName) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.el);
}

export interface ReasoningPrompt {
  system: string;
  user: string;
}

/**
 * Builds the compact prompt sent to the reasoning model. Only reads fields already
 * present on the engine's Observation/ReasoningContext types — never raw HTML, cookies,
 * storage, headers, or auth values, since none of those are reachable from this
 * function's input in the first place.
 */
export function buildReasoningPrompt(context: ReasoningContext): ReasoningPrompt {
  const { objective, successCriteria, allowedActions, allowedDomains, limits, observation, recentActions, satisfiedCriteriaIds } =
    context;

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
    "wordlist) that matches what the objective and successCriteria ask for next -- if one " +
    "does, prefer selecting it over scrolling. Only choose \"scroll\" when no visible control " +
    "yet matches, or when \"recentActions\" shows scrolling has genuinely been revealing new " +
    "elements; if you've recently scrolled without \"currentPage\" changing in a way that " +
    "helps, say so in your reason and prefer a different action. When more than one visible " +
    "control could plausibly apply, choose the one whose semantic purpose most specifically " +
    "matches the objective/successCriteria wording (for example: prefer whichever of a " +
    "\"summary\"-purposed control or a \"continue\"-purposed control the objective actually " +
    "asks for, in whatever language or label the page itself uses) -- never a control whose " +
    "purpose looks like a purchase, payment, order, booking, lead submission, or any other " +
    "personal-data/contractual action, regardless of what the objective asks for.";

  const interactiveElements = selectPromptInteractiveElements(
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
      })),
    },
    recentActions: recentActions.slice(-MAX_RECENT_ACTIONS).map((a) => ({ type: a.type, target: a.target })),
  };

  return { system, user: JSON.stringify(payload) };
}
