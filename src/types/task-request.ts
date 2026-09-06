import type { ActionType } from "./actions.js";
import type { CaptureModuleName } from "./captureModule.js";

export type SuccessCriterionType =
  | "url_pattern"
  | "element_present"
  | "element_text_match"
  | "semantic_page_match"
  | "data_layer_event"
  | "network_event"
  | "custom";

export interface SuccessCriterion {
  id: string;
  type: SuccessCriterionType;
  description: string;
  config?: Record<string, unknown>;
  required?: boolean;
  /**
   * Optional. Criteria sharing the same group value are alternatives -- the group is
   * satisfied once any one member is satisfied, and is required exactly when at least one
   * member is (see getMissingRequiredCriteriaIds, src/core/successEvaluator.ts). A
   * criterion with no group is its own implicit singleton group, so omitting this field
   * everywhere reproduces the previous AND-of-all-required-criteria behaviour exactly.
   */
  group?: string;
}

export interface Limits {
  maxSteps: number;
  maxBacktracks: number;
  maxDurationSeconds?: number;
  maxRepeatedActions?: number;
}

/**
 * How the reasoning layer may interact with a blocking consent/preference control when
 * one is genuinely in the way of an objective-relevant control (see docs/architecture.md
 * "Blocker recovery"). Never a license to alter granular consent settings by guesswork,
 * and never enforced by hardcoded CTA wording or a vendor-specific selector -- the engine
 * gives the model this policy as plain instruction and trusts it to apply the same
 * generic, language-agnostic semantic judgement already used elsewhere (e.g. preferring an
 * objective-matching control by accessible name/type/ariaState, not a fixed wordlist).
 *
 * - "reject_optional" (the default when this field is omitted): may click a control whose
 *   semantic purpose is to decline or continue without granting optional/non-essential
 *   data collection; must never click one whose purpose is to grant broad/optional
 *   consent.
 * - "essential_only": same practical latitude as "reject_optional" -- the engine has no
 *   generic, non-vendor-specific way to distinguish a granular "essential only" toggle
 *   screen from a plain reject control -- offered as a distinct, explicit value for a
 *   caller whose own policy language specifically calls for it.
 * - "accept_optional": an explicit, caller-opted-in allowance to grant optional consent
 *   solely to clear a blocking control that prevents reaching the objective -- never the
 *   default, and never applied when the objective is reachable without it.
 * - "do_not_interact": the model must never click any control whose purpose is to manage
 *   consent/tracking preferences, even to dismiss a blocker; a control that stays blocked
 *   stays blocked.
 */
export type ConsentInteractionPolicy = "reject_optional" | "accept_optional" | "essential_only" | "do_not_interact";

export interface Safety {
  allowedActions: ActionType[];
  allowFormSubmission?: boolean;
  allowPaymentOrPurchase?: false;
  allowPersonalDataEntry?: false;
  requireDomainConfirmationOnRedirect?: boolean;
  /** See ConsentInteractionPolicy above. Omitted means "reject_optional". */
  consentInteractionPolicy?: ConsentInteractionPolicy;
}

export interface TaskRequest {
  schemaVersion: "1.10.0";
  taskId: string;
  objective: string;
  startUrl: string;
  /**
   * Optional. When omitted, the engine's preflight domain-discovery phase (src/discovery)
   * determines an initial trusted set on its own -- the caller is never required to
   * enumerate every domain/subdomain a journey might use. When present, every listed
   * hostname is trusted unconditionally, on top of that discovery. See
   * docs/architecture.md "Preflight domain discovery".
   */
  allowedDomains?: string[];
  /**
   * Optional free-text hint about the kind of journey this task represents. Purely
   * advisory -- blended into preflight discovery's generic objective-relevance text
   * matching, never parsed for domain-specific control flow.
   */
  journeyType?: string;
  successCriteria: SuccessCriterion[];
  captureModules: CaptureModuleName[];
  limits: Limits;
  safety: Safety;
  outputSchemaVersion: "1.9.0";
  metadata?: Record<string, string | number | boolean>;
}

/**
 * A TaskRequest whose allowedDomains has been resolved by the engine's preflight
 * domain-discovery phase (src/discovery) into a concrete, non-empty list -- the shape the
 * core navigation loop (src/core/loop.ts) actually operates on. Never constructed directly
 * from caller input; only src/core/engine.ts produces one, after discovery runs.
 */
export type ResolvedTaskRequest = TaskRequest & { allowedDomains: string[] };
