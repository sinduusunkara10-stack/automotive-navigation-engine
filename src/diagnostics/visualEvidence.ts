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
/** Downstream response fields (the n8n Extract node) cut a string at about 12 000 characters; a region shot that must stay readable there is kept below it. */
export const VISUAL_EVIDENCE_REGION_MAX_BASE64_CHARS = 11_500;
const SCREENSHOT_TIMEOUT_MS = 3000;
const REGION_PADDING_PX = 80;
const TIGHT_REGION_PADDING_PX = 12;
const REDUCED_JPEG_QUALITIES = [20, 10];

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
  | "consent_validation_rejected"
  | "consent_after_recovery"
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
  capture(stage: VisualEvidenceStage, submitAttempt?: number | null, region?: Locator, options?: { maxBase64Chars?: number }): Promise<void>;
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
    async capture(stage, submitAttempt = null, region, options = {}) {
      touched = true;
      if (shots.length >= maxShots) {
        omittedStages.push(stage);
        return;
      }
      const viewport = page.viewportSize();
      let clip = region && viewport ? await onScreenClip(region, viewport) : null;
      const shoot = (quality: number) =>
        page.screenshot({ type: "jpeg", quality, caret: "initial", scale: "css", timeout: SCREENSHOT_TIMEOUT_MS, ...(clip ? { clip } : {}) }).catch(() => null);
      let buffer = await shoot(VISUAL_EVIDENCE_JPEG_QUALITY);
      if (!buffer) {
        failedCaptureCount += 1;
        return;
      }
      // Only a region shot is held to the size limit: a full viewport never fits it, and dropping one
      // would lose the only picture of a page the form has left.
      const limit = clip && region && viewport ? options.maxBase64Chars : undefined;
      if (limit !== undefined) {
        const fits = (b: Buffer) => base64Length(b.length) <= limit;
        for (const quality of REDUCED_JPEG_QUALITIES) {
          if (fits(buffer)) break;
          buffer = (await shoot(quality)) ?? buffer;
        }
        if (!fits(buffer)) {
          clip = await onScreenClip(region!, viewport!, TIGHT_REGION_PADDING_PX);
          buffer = clip ? ((await shoot(REDUCED_JPEG_QUALITIES[REDUCED_JPEG_QUALITIES.length - 1]!)) ?? buffer) : buffer;
        }
        if (!clip || !fits(buffer)) {
          omittedStages.push(stage);
          return;
        }
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
async function onScreenClip(
  region: Locator,
  viewport: { width: number; height: number },
  padding: number = REGION_PADDING_PX,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const box = await region.boundingBox({ timeout: 1000 }).catch(() => null);
  if (!box) return null;
  const x = Math.max(0, box.x - padding);
  const y = Math.max(0, box.y - padding);
  const right = Math.min(viewport.width, box.x + box.width + padding);
  const bottom = Math.min(viewport.height, box.y + box.height + padding);
  return right - x >= 16 && bottom - y >= 16 ? { x, y, width: right - x, height: bottom - y } : null;
}

function base64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}
