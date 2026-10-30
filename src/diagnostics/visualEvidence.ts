import type { Locator, Page } from "playwright";

/**
 * Opt-in (FORM_VISUAL_EVIDENCE=1), event-based screenshots around the lead-form state transitions
 * the structured diagnostics already describe -- what a person would have seen at that moment. A
 * viewport-only JPEG: no full-page capture (which resizes the viewport and can fire a site's own
 * resize handlers), no scrolling, and the caret left as it is (Playwright's default caret hiding
 * injects a style into the page). Bounded per fill_form action; nothing is written to disk.
 * A checkpoint about one control or widget is clipped to that region (when it is on screen), which
 * keeps each image small enough to survive downstream size limits on a response field.
 */
export const VISUAL_EVIDENCE_MAX_SHOTS = 20;
export const VISUAL_EVIDENCE_JPEG_QUALITY = 35;
const SCREENSHOT_TIMEOUT_MS = 3000;
const REGION_PADDING_PX = 80;

export type VisualEvidenceStage =
  | "lookup_after_input"
  | "lookup_control_became_actionable"
  | "lookup_outcome"
  | "lookup_after_late_observation"
  | "submit_before_click"
  | "submit_outcome"
  | "form_not_found"
  | "form_not_found_after_late_watch"
  | "form_discovered"
  | "required_fields_filled"
  | "phone_after_fill"
  | "phone_after_blur"
  | "phone_after_alternate_format"
  | "dealer_results_rendered"
  | "dealer_before_click"
  | "dealer_after_click"
  | "dealer_after_follow_up"
  | "before_readiness"
  | "validation_errors_visible"
  | "final_state";

export interface VisualEvidenceShot {
  stage: VisualEvidenceStage;
  /** 1-based submit attempt, or null for a dealer-lookup stage. */
  submitAttempt: number | null;
  capturedAt: string;
  mimeType: "image/jpeg";
  viewportWidth: number | null;
  viewportHeight: number | null;
  /** "region" when clipped to the control or widget the checkpoint is about. */
  area: "viewport" | "region";
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
  capture(stage: VisualEvidenceStage, submitAttempt?: number | null, region?: Locator): Promise<void>;
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
    async capture(stage, submitAttempt = null, region) {
      touched = true;
      if (shots.length >= maxShots) {
        omittedStages.push(stage);
        return;
      }
      const viewport = page.viewportSize();
      const clip = region && viewport ? await onScreenClip(region, viewport) : null;
      const buffer = await page
        .screenshot({ type: "jpeg", quality: VISUAL_EVIDENCE_JPEG_QUALITY, caret: "initial", scale: "css", timeout: SCREENSHOT_TIMEOUT_MS, ...(clip ? { clip } : {}) })
        .catch(() => null);
      if (!buffer) {
        failedCaptureCount += 1;
        return;
      }
      shots.push({
        stage,
        submitAttempt,
        capturedAt: new Date().toISOString(),
        mimeType: "image/jpeg",
        viewportWidth: viewport?.width ?? null,
        viewportHeight: viewport?.height ?? null,
        area: clip ? "region" : "viewport",
        byteLength: buffer.length,
        dataBase64: buffer.toString("base64"),
      });
    },
    result() {
      return touched ? { shots, omittedStages, failedCaptureCount } : undefined;
    },
  };
}

/** The region's padded box within the current viewport, or null when it is off screen -- never scrolled into view. */
async function onScreenClip(region: Locator, viewport: { width: number; height: number }): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const box = await region.boundingBox({ timeout: 1000 }).catch(() => null);
  if (!box) return null;
  const x = Math.max(0, box.x - REGION_PADDING_PX);
  const y = Math.max(0, box.y - REGION_PADDING_PX);
  const right = Math.min(viewport.width, box.x + box.width + REGION_PADDING_PX);
  const bottom = Math.min(viewport.height, box.y + box.height + REGION_PADDING_PX);
  return right - x >= 16 && bottom - y >= 16 ? { x, y, width: right - x, height: bottom - y } : null;
}
