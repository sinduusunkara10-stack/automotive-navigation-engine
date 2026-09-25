import type { ActionType, RecordedAction, SelectedAction } from "../types/actions.js";
import type { ConsentInteractionPolicy, SuccessCriterion } from "../types/task-request.js";
import type { ConsentControlIntent } from "../types/consentControl.js";
import type { Observation, ReasoningProviderDiagnostics } from "../types/task-response.js";
import type { RouteMemoryCandidateSummary } from "../types/routeMemory.js";
import type { BranchPromptContext, MilestoneRollup } from "../types/branch.js";
import type { JourneyMemoryPromptSummary } from "../types/journeyMemory.js";

// Version of the diagnostics.reasoningProvider structure a ReasoningProvider.getUsageDiagnostics()
// implementation must return (see ReasoningProviderDiagnostics in ../types/task-response.js),
// independent of TaskResponse.schemaVersion.
// Bumped from "1.1.0" to "1.2.0" for the consent-policy-enforcement audit trail: the
// additive, optional consentInteractionPolicy (the resolved policy for this run) and
// per-decision decisions[].consentControlIntent/consentPolicyCompliant fields -- see
// src/safety/consentPolicyGuard.ts and CLAUDE.md's consent-policy fix. No existing field
// removed or renamed. Bumped from "1.0.0" to "1.1.0" earlier for the additive, optional
// decisions[].elementSelection diagnostic (see PromptElementSelectionDiagnostic in
// ../types/task-response.js) -- no existing field removed or renamed.
export const REASONING_PROVIDER_DIAGNOSTICS_VERSION = "1.2.0" as const;

export interface Decision {
  action: SelectedAction;
  rationale: string;
  /**
   * Self-reported classification of this decision's consent semantics (see
   * types/consentControl.ts), propagated from whatever provider produced it. Optional
   * because not every ReasoningProvider implementation classifies this (e.g.
   * MockReasoningProvider never does) -- absence is always treated as "not_consent_related"
   * by src/safety/consentPolicyGuard.ts, never as a silent bypass.
   */
  consentControlIntent?: ConsentControlIntent;
  /**
   * PR 1C (low-confidence recovery): present only when `action` is a provider-internal
   * safe fallback (e.g. ClaudeReasoningProvider.fallback()), naming why no valid decision
   * could be produced this attempt -- e.g. "low_confidence", "malformed_output",
   * "no_allowed_actions". Absent for an ordinary, non-fallback decision. core/loop.ts uses
   * this to recognise a fallback stop_blocked caused specifically by the reasoning layer's
   * own confidence falling below its configured threshold, distinct from every other
   * reason a provider might fall back to a safe stop -- see "Low-confidence recovery" in
   * docs/architecture.md. Never surfaced on either wire schema; purely an internal signal
   * between a ReasoningProvider and the core loop.
   */
  fallbackReason?: string;
}

export interface ReasoningContextLimits {
  maxSteps: number;
  maxBacktracks: number;
  stepsUsed: number;
  backtracksUsed: number;
}

export interface ReasoningContext {
  objective: string;
  successCriteria: SuccessCriterion[];
  allowedActions: ActionType[];
  allowedDomains: string[];
  limits: ReasoningContextLimits;
  observation: Observation;
  recentActions: RecordedAction[];
  satisfiedCriteriaIds: string[];
  /** See ConsentInteractionPolicy (types/task-request.ts). Always present -- core/loop.ts resolves the task's omitted-field default ("reject_optional") before building this context, so a provider never has to know the default itself. */
  consentInteractionPolicy: ConsentInteractionPolicy;
  /**
   * Route Memory (see core/routeMemory.ts): candidate route choices (click/navigate)
   * already tried at this exact decision point -- the current page state identified by its
   * own content, not merely its URL -- in an earlier attempt, however many steps ago
   * (including after a go_back that returned here). Omitted (rather than an empty array)
   * when nothing has been tried here yet, matching this repo's existing convention for
   * optional context fields (e.g. Observation.progressIndicatorText).
   */
  routeMemory?: RouteMemoryCandidateSummary[];
  /**
   * Goal-Directed Bounded Branch Exploration (see core/successEvaluator.ts's
   * computeMilestoneRollup): a compact rollup of objective-milestone progress, reusing
   * existing successCriteria as the source of truth. Omitted (rather than a trivial single-
   * milestone rollup) when the task declares fewer than two milestone groups -- the common
   * case, and every pre-existing task -- so an ordinary run's prompt is byte-for-byte
   * unaffected by this field's existence.
   */
  milestones?: MilestoneRollup;
  /**
   * Goal-Directed Bounded Branch Exploration (see core/branchExploration.ts): present only
   * while a bounded branch is actively being explored (never while one is merely returning,
   * and never for an ordinary, non-branch decision) -- the compact context needed to keep
   * following or judging the current branch. Omitted entirely otherwise, matching this
   * repo's existing convention for optional context fields.
   */
  branch?: BranchPromptContext;
  /**
   * PR 1C (Alternative Route Exploration, see docs/architecture.md "Alternative route
   * exploration"): present only for the single decision immediately following a bounded
   * journey-replanning go_back substitution (core/loop.ts), naming the label(s) of
   * whichever candidate route choice(s) this run has already dispatched and that did not
   * lead anywhere productive -- a nudge toward a different, sibling control (e.g. a
   * different call-to-action plausibly serving the same objective) rather than
   * immediately re-proposing the same one. One-shot: cleared the instant this one decision
   * is made, whatever it turns out to be. Omitted entirely otherwise, matching this repo's
   * existing convention for optional context fields.
   */
  alternativeExploration?: { justFailedLabels: string[] };
  /**
   * Panel-attribution corrective pass (item 2 of the approved design -- see CLAUDE.md and
   * the BMW-enquire-panel investigation): present only when the current observation's own
   * activeSurface is a non-"main" surface (in_document or adopted_context) whose causing
   * action this run was able to attribute (core/state.ts's RunState.recordSurfaceCausingAction).
   * Gives the planner the same structural "this is my own action's result" identity the
   * investigation found was previously only ever advisory prose -- never require the model
   * to infer the connection from a bare opaque element id or a several-steps-old string
   * alone when this field is present. Omitted entirely otherwise, matching this repo's
   * existing convention for optional context fields.
   */
  expectedSurface?: {
    /** The surface's own stable identity (see core/panelEvidence.ts's PanelEvidence.identity for in_document; the surface id itself otherwise). */
    surfaceIdentity: string;
    /** Which step's action caused this surface to open. */
    causingActionStepIndex: number;
    /** The causing control's own accessible name/text, when known -- never an opaque element id. */
    causingControlLabel?: string;
    /** See ActionResult.verifiedSuccessType/RecordedAction.surfaceChangeType. */
    causingActionVerifiedSuccessType?: string;
    causingActionSurfaceChangeType?: string;
    /** True while this surface is still the active one (it has not since been closed/left). */
    stillOpen: boolean;
    /** True once a scoped verifier/deterministic check has already confirmed this surface satisfies the active milestone. */
    alreadyVerifiedAgainstMilestone: boolean;
  };
  /**
   * Persistent Cross-Run Journey Memory (see src/core/journeyMemory): a compact, bounded
   * summary of relevant cross-run historical records, injected only into the specific
   * decision an escalation signal (low confidence, no valid action, repeated action, a
   * known-bad branch, no milestone progress, candidate-ranking ambiguity, decision-point
   * restoration, or recovery beginning -- see core/loop.ts) fires for, never on every
   * step. Omitted entirely otherwise, matching this repo's existing optional-context-field
   * convention for routeMemory/alternativeExploration above.
   */
  journeyMemory?: JourneyMemoryPromptSummary;
}

export interface ReasoningProvider {
  decide(context: ReasoningContext): Promise<Decision>;
  /**
   * Safe, per-run aggregated usage diagnostics for this provider (call counts, accept/
   * reject/fallback outcomes, token/latency totals, retries), surfaced under
   * TaskResponse.diagnostics.reasoningProvider. Optional so a provider with nothing to
   * report (or a future provider that hasn't implemented this yet) need not supply it;
   * the engine only attaches diagnostics.reasoningProvider when this returns a value.
   */
  getUsageDiagnostics?(): ReasoningProviderDiagnostics;
}
