import type { ActionType } from "./actions.js";
import type { CaptureModuleName } from "./captureModule.js";

export type SuccessCriterionType =
  | "url_pattern"
  | "element_present"
  | "element_text_match"
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
  schemaVersion: "1.0.0";
  taskId: string;
  objective: string;
  startUrl: string;
  allowedDomains: string[];
  successCriteria: SuccessCriterion[];
  captureModules: CaptureModuleName[];
  limits: Limits;
  safety: Safety;
  outputSchemaVersion: "1.1.0";
  metadata?: Record<string, string | number | boolean>;
}
