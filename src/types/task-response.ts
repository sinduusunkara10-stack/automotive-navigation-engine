import type { SelectedAction } from "./actions.js";

export type RunStatus =
  | "success"
  | "blocked"
  | "failure"
  | "max_steps_reached"
  | "max_backtracks_reached"
  | "max_duration_reached";

export interface InteractiveElement {
  id: string;
  role: string;
  accessibleName: string;
  visible?: boolean;
}

export interface Observation {
  url: string;
  title: string;
  interactiveElements: InteractiveElement[];
  notableText?: string[];
}

export interface ActionResult {
  success: boolean;
  error?: string;
  resultingUrl?: string;
}

export interface Progress {
  satisfiedCriteriaIds: string[];
  estimatedCompletion: number;
}

export interface StepLog {
  stepIndex: number;
  timestamp: string;
  currentUrl: string;
  observation: Observation;
  decision: string;
  selectedAction: SelectedAction;
  actionResult: ActionResult;
  progress: Progress;
  safetyFlags?: string[];
}

export interface PageVisitCapture {
  stepIndex: number;
  url: string;
  title?: string;
  timestamp: string;
}

export interface ErrorCapture {
  stepIndex: number;
  message: string;
  stack?: string;
  timestamp: string;
}

export interface Captures {
  page_visits?: PageVisitCapture[];
  errors?: ErrorCapture[];
}

export interface EngineAssessment {
  objectiveAchieved: boolean;
  confidence: number;
  summary: string;
  satisfiedSuccessCriteriaIds?: string[];
  notes?: string;
}

export interface Diagnostics {
  stepCount: number;
  backtrackCount: number;
  totalDurationMs: number;
  finishReason: string;
  engineVersion?: string;
}

export interface TaskResponse {
  schemaVersion: "1.0.0";
  taskId: string;
  status: RunStatus;
  statusReason?: string;
  startUrl: string;
  finalUrl: string;
  steps: StepLog[];
  captures: Captures;
  engineAssessment: EngineAssessment;
  diagnostics: Diagnostics;
}
