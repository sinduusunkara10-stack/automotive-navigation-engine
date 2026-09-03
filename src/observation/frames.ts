import type { Frame, Page } from "playwright";

/**
 * Generic, vendor-agnostic same-origin-frame support (item 8 of the blocker-recovery
 * fix -- see docs/architecture.md "Frame-aware observation"). Kept deliberately shallow
 * (direct child frames of the main document only, one level) and purely mechanical: no
 * vendor/CMP-specific selector, no assumption about which frame a blocker lives in. A
 * frame this engine cannot evaluate script in (detached before/while being scanned, or
 * genuinely inaccessible for any other reason -- including a cross-origin frame a given
 * browser/embed configuration refuses script access to) is never silently skipped in a way
 * that could let the engine fall back to clicking an unrelated, possibly-hidden
 * main-document element instead: it is reported as inaccessible (origin only, no content)
 * and simply contributes no candidates.
 */

export type FrameActionTarget = Page | Frame;

export interface AccessibleChildFrame {
  frame: Frame;
  /** Position among non-main frames at scan time -- used only to build/resolve element ids. */
  frameIndex: number;
  /** Origin only (scheme+host+port) -- never a full URL with path/query. */
  origin: string;
}

export interface InaccessibleChildFrame {
  frameIndex: number;
  origin: string;
}

const FRAME_ORIGIN_UNKNOWN = "unknown";

function frameOrigin(frame: Frame): string {
  try {
    return new URL(frame.url()).origin;
  } catch {
    return FRAME_ORIGIN_UNKNOWN;
  }
}

/**
 * Enumerates the main document's direct child frames and probes each with a trivial,
 * side-effect-free evaluate() call to determine whether the engine can actually read it.
 * Ordering is positional (page.frames() order, excluding the main frame) and is only ever
 * used as a same-run element-id/re-resolution detail -- never surfaced as meaningful
 * evidence on its own.
 */
export async function listChildFrames(
  page: Page,
): Promise<{ accessible: AccessibleChildFrame[]; inaccessible: InaccessibleChildFrame[] }> {
  const mainFrame = page.mainFrame();
  const childFrames = page.frames().filter((frame) => frame !== mainFrame);

  const accessible: AccessibleChildFrame[] = [];
  const inaccessible: InaccessibleChildFrame[] = [];

  for (let frameIndex = 0; frameIndex < childFrames.length; frameIndex += 1) {
    const frame = childFrames[frameIndex];
    if (!frame) {
      continue;
    }
    const origin = frameOrigin(frame);
    try {
      await frame.evaluate(() => true);
      accessible.push({ frame, frameIndex, origin });
    } catch {
      inaccessible.push({ frameIndex, origin });
    }
  }

  return { accessible, inaccessible };
}

const FRAME_ID_PREFIX = "frame";
const FRAME_ID_SEPARATOR = ":";

/** Builds a globally-unique element id for an element found inside a child frame. */
export function frameScopedElementId(frameIndex: number, localId: string): string {
  return `${FRAME_ID_PREFIX}${frameIndex}${FRAME_ID_SEPARATOR}${localId}`;
}

export interface ParsedFrameScopedId {
  frameIndex: number;
  localId: string;
}

/** Returns undefined for a plain main-document id (the common case). */
export function parseFrameScopedElementId(elementId: string): ParsedFrameScopedId | undefined {
  if (!elementId.startsWith(FRAME_ID_PREFIX)) {
    return undefined;
  }
  const separatorIndex = elementId.indexOf(FRAME_ID_SEPARATOR);
  if (separatorIndex === -1) {
    return undefined;
  }
  const frameIndex = Number(elementId.slice(FRAME_ID_PREFIX.length, separatorIndex));
  if (!Number.isInteger(frameIndex) || frameIndex < 0) {
    return undefined;
  }
  return { frameIndex, localId: elementId.slice(separatorIndex + 1) };
}

export type FrameResolution =
  | { status: "main_frame" }
  | { status: "resolved"; frame: Frame }
  | { status: "unavailable" };

/**
 * Re-resolves a frame-scoped element id's owning frame against the *live* page -- frames
 * are dynamic (can be added, removed, or reordered between an observation and a later
 * dispatch), so this is always a fresh lookup, never a cached handle. `frame_unavailable`
 * (see actions/click.ts) covers both a frame that was removed and one that can no longer
 * be evaluated for any other reason (including genuine cross-origin denial) -- the engine
 * never distinguishes those further, since neither is safe to act on.
 */
export async function resolveElementFrame(page: Page, elementId: string): Promise<FrameResolution> {
  const parsed = parseFrameScopedElementId(elementId);
  if (!parsed) {
    return { status: "main_frame" };
  }

  const mainFrame = page.mainFrame();
  const childFrames = page.frames().filter((frame) => frame !== mainFrame);
  const frame = childFrames[parsed.frameIndex];
  if (!frame) {
    return { status: "unavailable" };
  }

  try {
    await frame.evaluate(() => true);
  } catch {
    return { status: "unavailable" };
  }

  return { status: "resolved", frame };
}

/** The element id's own frame-scoped local id, with any frame prefix stripped. */
export function localElementId(elementId: string): string {
  return parseFrameScopedElementId(elementId)?.localId ?? elementId;
}
