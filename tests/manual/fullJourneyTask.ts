import type { TaskRequest } from "../../src/types/task-request.js";

/**
 * The full three-page local fictional journey (start.html -> step2.html -> success.html)
 * used by both the real, billed full-journey smoke test
 * (tests/manual/claudeFullLocalJourneyTest.ts) and its network-free, fake-client
 * counterpart (tests/integration/claudeFullLocalJourney.test.ts), so the two never drift
 * apart. maxSteps: 3 is a hard ceiling (task requirement #7/#8): it bounds the run to at
 * most three reasoning.decide() calls -- one per page -- so a journey that cannot
 * complete in three decisions is stopped safely by the existing limits guard
 * (src/core/loop.ts) without ever making a fourth call. The action vocabulary is
 * deliberately narrow (click + the three stop_* actions) so the run only ever needs one
 * decision per page.
 */
export function buildFullJourneyTask(baseUrl: string): TaskRequest {
  return {
    schemaVersion: "1.5.0",
    taskId: "claude-full-local-journey",
    objective:
      "Reach the fixture's success page by following the visible continue control on each page.",
    startUrl: `${baseUrl}/start.html`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        config: { pattern: `${baseUrl}/success.html` },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 3, maxBacktracks: 0 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.5.0",
  };
}
