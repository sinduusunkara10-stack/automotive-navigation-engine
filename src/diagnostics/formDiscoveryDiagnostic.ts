import type { Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * TEMPORARY, investigation-only instrumentation (not part of the wire contract, not wired
 * into ActionResult/schemas). Gated entirely behind FORM_DISCOVERY_DIAGNOSTIC=1 so a normal
 * run's behavior and output are byte-for-byte unchanged when the flag is unset. Exists only
 * to capture frame/shadow-DOM/field evidence from the next real run against a page where
 * fill_form reports form_discovery_failed with fieldsDiscovered: 0, since this sandbox's
 * network policy cannot reach arbitrary external sites to capture that evidence directly.
 * Remove this file and its two call sites in actions/fillForm.ts once the real root cause is
 * confirmed from a captured report.
 */
export const FORM_DISCOVERY_DIAGNOSTIC_ENABLED = process.env.FORM_DISCOVERY_DIAGNOSTIC === "1";

interface FrameFieldSnapshot {
  url: string;
  isMainFrame: boolean;
  sameOriginAsMain: boolean;
  formCount: number;
  inputCount: number;
  selectCount: number;
  textareaCount: number;
  forms: {
    index: number;
    id: string | null;
    className: string | null;
    name: string | null;
    action: string | null;
    visible: boolean;
    fieldCountInsideSubtree: number;
  }[];
  shadowHostCount: number;
  openShadowRootControlCount: number;
}

interface FieldDetail {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  label: string | null;
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  formAttr: string | null;
  closestFormId: string | null;
  boundingBox: { x: number; y: number; w: number; h: number };
  visible: boolean;
}

async function snapshotFrame(page: Page): Promise<FrameFieldSnapshot[]> {
  const mainFrame = page.mainFrame();
  const mainOrigin = new URL(page.url()).origin;
  const out: FrameFieldSnapshot[] = [];
  for (const frame of page.frames()) {
    try {
      const data = await frame.evaluate(() => {
        function visible(el: Element): boolean {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        }
        const forms = Array.from(document.querySelectorAll("form"));
        const shadowHosts = Array.from(document.querySelectorAll<HTMLElement>("*")).filter((el) => el.shadowRoot !== null);
        let openShadowRootControlCount = 0;
        for (const host of shadowHosts) {
          openShadowRootControlCount += host.shadowRoot!.querySelectorAll("input, select, textarea").length;
        }
        return {
          url: location.href,
          formCount: forms.length,
          inputCount: document.querySelectorAll("input").length,
          selectCount: document.querySelectorAll("select").length,
          textareaCount: document.querySelectorAll("textarea").length,
          forms: forms.map((f, i) => ({
            index: i,
            id: f.id || null,
            className: f.className || null,
            name: f.getAttribute("name"),
            action: f.getAttribute("action"),
            visible: visible(f),
            fieldCountInsideSubtree: f.querySelectorAll("input, select, textarea").length,
          })),
          shadowHostCount: shadowHosts.length,
          openShadowRootControlCount,
        };
      });
      let frameOrigin: string | null = null;
      try {
        frameOrigin = new URL(frame.url()).origin;
      } catch {
        frameOrigin = null;
      }
      out.push({
        ...data,
        isMainFrame: frame === mainFrame,
        sameOriginAsMain: frameOrigin === mainOrigin,
      });
    } catch (e) {
      out.push({
        url: frame.url(),
        isMainFrame: frame === mainFrame,
        sameOriginAsMain: false,
        formCount: -1,
        inputCount: -1,
        selectCount: -1,
        textareaCount: -1,
        forms: [],
        shadowHostCount: -1,
        openShadowRootControlCount: -1,
        // @ts-expect-error -- diagnostic-only field, not part of the typed shape above
        error: String(e),
      });
    }
  }
  return out;
}

async function fieldDetail(page: Page): Promise<FieldDetail[]> {
  return page.evaluate(() => {
    function visible(el: Element): boolean {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    }
    const els = Array.from(document.querySelectorAll("input, select, textarea")) as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    return els.map((el) => {
      const label =
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim()) ||
        el.closest("label")?.textContent?.trim() ||
        null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.id || null,
        placeholder: el.getAttribute("placeholder"),
        label: label ?? null,
        required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
        disabled: (el as HTMLInputElement).disabled ?? false,
        readonly: (el as HTMLInputElement).readOnly ?? false,
        formAttr: el.getAttribute("form"),
        closestFormId: el.closest("form")?.id || (el.closest("form") ? "(form,no-id)" : null),
        boundingBox: { x: r.x, y: r.y, w: r.width, h: r.height },
        visible: visible(el),
      };
    });
  });
}

/**
 * Captures one labeled evidence snapshot (frames + field detail) and appends it to an
 * in-memory report; call captureFormDiscoveryDiagnostic multiple times across the run
 * (entry, post-settle, pre-return) then call writeFormDiscoveryDiagnosticReport once at the end.
 */
export interface FormDiscoveryDiagnosticReport {
  url: string;
  startedAt: string;
  snapshots: { label: string; at: string; frames: FrameFieldSnapshot[] }[];
  finalFieldDetail?: FieldDetail[];
  extra?: Record<string, unknown>;
}

export function createFormDiscoveryDiagnosticReport(url: string): FormDiscoveryDiagnosticReport {
  return { url, startedAt: new Date().toISOString(), snapshots: [] };
}

export async function captureFormDiscoverySnapshot(page: Page, report: FormDiscoveryDiagnosticReport, label: string): Promise<void> {
  if (!FORM_DISCOVERY_DIAGNOSTIC_ENABLED) return;
  const frames = await snapshotFrame(page);
  report.snapshots.push({ label, at: new Date().toISOString(), frames });
}

export async function finalizeFormDiscoveryDiagnostic(
  page: Page,
  report: FormDiscoveryDiagnosticReport,
  extra?: Record<string, unknown>,
): Promise<void> {
  if (!FORM_DISCOVERY_DIAGNOSTIC_ENABLED) return;
  report.finalFieldDetail = await fieldDetail(page).catch(() => []);
  report.extra = extra;
  const dir = join(process.cwd(), "diagnostics", "form-discovery");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${Date.now()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), "utf8");
}
