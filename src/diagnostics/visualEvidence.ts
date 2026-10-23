import type { Page } from "playwright";

/**
 * Opt-in (FORM_VISUAL_EVIDENCE=1), event-based screenshots around the lead-form state transitions
 * the structured diagnostics already describe -- what a person would have seen at that moment. A
 * viewport-only JPEG: no full-page capture (which resizes the viewport and can fire a site's own
 * resize handlers), no scrolling, and the caret left as it is (Playwright's default caret hiding
 * injects a style into the page). Bounded per fill_form action; nothing is written to disk.
 */
export const VISUAL_EVIDENCE_MAX_SHOTS = 8;
export const VISUAL_EVIDENCE_JPEG_QUALITY = 35;
const SCREENSHOT_TIMEOUT_MS = 3000;

export type VisualEvidenceStage =
  | "lookup_after_input"
  | "lookup_control_became_actionable"
  | "lookup_outcome"
  | "lookup_after_late_observation"
  | "submit_before_click"
  | "submit_outcome";

export interface VisualEvidenceShot {
  stage: VisualEvidenceStage;
  /** 1-based submit attempt, or null for a dealer-lookup stage. */
  submitAttempt: number | null;
  capturedAt: string;
  mimeType: "image/jpeg";
  viewportWidth: number | null;
  viewportHeight: number | null;
  byteLength: number;
  dataBase64: string;
}

export interface FormVisualEvidence {
  shots: VisualEvidenceShot[];
  /** Stages reached after the per-action cap was used up. */
  omittedStages: VisualEvidenceStage[];
  failedCaptureCount: number;
}

export interface VisualEvidenceRecorder {
  capture(stage: VisualEvidenceStage, submitAttempt?: number | null): Promise<void>;
  result(): FormVisualEvidence | undefined;
}

export function isFormVisualEvidenceEnabled(): boolean {
  return process.env.FORM_VISUAL_EVIDENCE === "1";
}

export function startVisualEvidenceRecorder(page: Page, maxShots: number = VISUAL_EVIDENCE_MAX_SHOTS): VisualEvidenceRecorder {
  const shots: VisualEvidenceShot[] = [];
  const omittedStages: VisualEvidenceStage[] = [];
  let failedCaptureCount = 0;
  let touched = false;
  return {
    async capture(stage, submitAttempt = null) {
      touched = true;
      if (shots.length >= maxShots) {
        omittedStages.push(stage);
        return;
      }
      const buffer = await page
        .screenshot({ type: "jpeg", quality: VISUAL_EVIDENCE_JPEG_QUALITY, caret: "initial", scale: "css", timeout: SCREENSHOT_TIMEOUT_MS })
        .catch(() => null);
      if (!buffer) {
        failedCaptureCount += 1;
        return;
      }
      const viewport = page.viewportSize();
      shots.push({
        stage,
        submitAttempt,
        capturedAt: new Date().toISOString(),
        mimeType: "image/jpeg",
        viewportWidth: viewport?.width ?? null,
        viewportHeight: viewport?.height ?? null,
        byteLength: buffer.length,
        dataBase64: buffer.toString("base64"),
      });
    },
    result() {
      return touched ? { shots, omittedStages, failedCaptureCount } : undefined;
    },
  };
}
