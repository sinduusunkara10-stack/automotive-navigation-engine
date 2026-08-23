import type { ReasoningContext } from "./reasoningProvider.js";

// Bounds on what goes into the prompt — keeps it compact and caps token/cost growth on
// pages with unusually large numbers of elements or long histories.
const MAX_RECENT_ACTIONS = 5;
const MAX_NOTABLE_TEXT = 8;
const MAX_INTERACTIVE_ELEMENTS = 40;

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
    "how sure you are that this action moves toward the objective.";

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
      interactiveElements: observation.interactiveElements.slice(0, MAX_INTERACTIVE_ELEMENTS).map((el) => ({
        id: el.id,
        type: el.role,
        accessibleName: el.accessibleName,
        visible: el.visible !== false,
        ...(el.destinationUrl ? { destinationUrl: el.destinationUrl } : {}),
      })),
    },
    recentActions: recentActions.slice(-MAX_RECENT_ACTIONS).map((a) => ({ type: a.type, target: a.target })),
  };

  return { system, user: JSON.stringify(payload) };
}
