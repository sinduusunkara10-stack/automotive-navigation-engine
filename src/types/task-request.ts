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
}

export interface Limits {
  maxSteps: number;
  maxBacktracks: number;
  maxDurationSeconds?: number;
  maxRepeatedActions?: number;
}

export interface Safety {
  allowedActions: ActionType[];
  allowFormSubmission?: boolean;
  allowPaymentOrPurchase?: false;
  allowPersonalDataEntry?: false;
  requireDomainConfirmationOnRedirect?: boolean;
}

export interface TaskRequest {
  schemaVersion: "1.4.0";
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
  outputSchemaVersion: "1.4.0";
  metadata?: Record<string, string | number | boolean>;
}

/**
 * A TaskRequest whose allowedDomains has been resolved by the engine's preflight
 * domain-discovery phase (src/discovery) into a concrete, non-empty list -- the shape the
 * core navigation loop (src/core/loop.ts) actually operates on. Never constructed directly
 * from caller input; only src/core/engine.ts produces one, after discovery runs.
 */
export type ResolvedTaskRequest = TaskRequest & { allowedDomains: string[] };
