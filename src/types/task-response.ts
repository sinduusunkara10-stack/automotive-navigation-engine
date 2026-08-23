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

export interface PageMetadataCapture {
  stepIndex: number;
  url: string;
  timestamp: string;
  title?: string;
  description?: string;
  lang?: string;
}

export interface DataLayerCapture {
  stepIndex: number;
  url: string;
  timestamp: string;
  raw: Record<string, unknown>[];
}

export interface Ga4NetworkEventCapture {
  stepIndex: number;
  requestUrl: string;
  timestamp: string;
  params?: Record<string, string>;
}

export interface ScreenshotCapture {
  stepIndex: number;
  ref: string;
  reason?: string;
  timestamp: string;
}

export interface FinishPageCtaCapture {
  stepIndex: number;
  pageUrl: string;
  timestamp: string;
  text: string;
  url?: string;
  elementType: string;
  accessibleName?: string;
}

export interface CtaClickCapture {
  stepIndex: number;
  timestamp: string;
  sourcePageUrl: string;
  sourcePageTitle?: string;
  ctaText: string;
  accessibleName?: string;
  elementType: string;
  destinationUrl?: string;
  resultingUrl?: string;
  navigationSucceeded: boolean;
  actionSucceeded: boolean;
  error?: string;
}

export interface JourneyPathSelectedElement {
  id: string;
  role: string;
  accessibleName: string;
}

export interface JourneyPathEntry {
  stepIndex: number;
  timestamp: string;
  pageUrlBefore: string;
  pageTitle: string;
  selectedAction: SelectedAction;
  selectedElement?: JourneyPathSelectedElement;
  decisionReason: string;
  actionOutcome: ActionResult;
  pageUrlAfter: string;
  progress: Progress;
}

export interface Captures {
  page_visits?: PageVisitCapture[];
  errors?: ErrorCapture[];
  page_metadata?: PageMetadataCapture[];
  data_layer_evidence?: DataLayerCapture[];
  ga4_network_events?: Ga4NetworkEventCapture[];
  screenshots?: ScreenshotCapture[];
  finish_page_ctas?: FinishPageCtaCapture[];
  cta_clicks?: CtaClickCapture[];
  journey_path?: JourneyPathEntry[];
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
