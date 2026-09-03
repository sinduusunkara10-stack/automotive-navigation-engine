import type { ReasoningContext } from "../../../src/reasoning/reasoningProvider.js";
import type { ActionType } from "../../../src/types/actions.js";

export function buildTestReasoningContext(overrides: Partial<ReasoningContext> = {}): ReasoningContext {
  const allowedActions: ActionType[] = overrides.allowedActions ?? [
    "click",
    "scroll",
    "wait",
    "navigate",
    "stop_success",
    "stop_blocked",
    "stop_failure",
  ];

  return {
    objective: "Reach the fictional success page by following the visible continue control.",
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the fictional success fixture.",
        required: true,
      },
    ],
    allowedActions,
    allowedDomains: ["example-fictional-oem.test"],
    limits: { maxSteps: 10, maxBacktracks: 2, stepsUsed: 1, backtracksUsed: 0 },
    observation: {
      url: "https://example-fictional-oem.test/start.html",
      title: "Fictional start page",
      interactiveElements: [
        {
          id: "el-0",
          role: "a",
          accessibleName: "Continue",
          visible: true,
          destinationUrl: "https://example-fictional-oem.test/step2.html",
        },
        { id: "el-1", role: "button", accessibleName: "Learn more", visible: true },
      ],
      notableText: ["Welcome to the fictional configurator"],
    },
    recentActions: [],
    satisfiedCriteriaIds: [],
    consentInteractionPolicy: "reject_optional",
    ...overrides,
  };
}
