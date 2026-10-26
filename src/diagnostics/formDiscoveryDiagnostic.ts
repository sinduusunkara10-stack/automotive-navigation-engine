import type { Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ActionResult, ActiveSurfaceInfo } from "../types/task-response.js";
import type { FormJourneyContext, FormScoreBreakdown } from "../forms/formRelevance.js";
import { FORM_SELECTION_ADOPT_THRESHOLD, FORM_SELECTION_REJECT_THRESHOLD } from "../forms/formRelevance.js";

/**
 * Opt-in, investigation-only form-discovery evidence (see ActionResult.formDiscoveryDebug in
 * types/task-response.ts and schemas/task-response.schema.json). Gated entirely behind
 * FORM_DISCOVERY_DIAGNOSTIC=1 so a normal run's behavior and response shape are byte-for-byte
 * unchanged when the flag is unset -- never reads or writes anything that affects
 * form-selection scoring, thresholds, or fill/submit logic, all of which are computed
 * identically either way, before this module is ever consulted.
 *
 * Primary exposure channel is the API response itself (ActionResult.formDiscoveryDebug),
 * reaching whatever reads the task's actions (e.g. an n8n "Extract Navigation Result" node)
 * without needing filesystem access to the engine's container. Two concise log lines are also
 * emitted so Render's log viewer can confirm the flag was read and a payload was built, without
 * needing to inspect the response at all. The local JSON file remains as an optional backup
 * only -- never the only channel.
 */
/** Read live (never cached at import time) so a test can toggle process.env.FORM_DISCOVERY_DIAGNOSTIC within one process; production behavior is identical to a frozen const, since this is called at most a few times per fill_form action. */
export function isFormDiscoveryDiagnosticEnabled(): boolean {
  return process.env.FORM_DISCOVERY_DIAGNOSTIC === "1";
}

/** Emits once per fill_form call, only when enabled -- proves the env var was read at runtime. */
export function logFormDiscoveryDiagnosticEnabled(params: { runId: string; taskId: string }): void {
  if (!isFormDiscoveryDiagnosticEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`FORM_DISCOVERY_DIAGNOSTIC_ENABLED runId=${params.runId} taskId=${params.taskId}`);
}

/** Emits once per captured payload, only when enabled -- never prints typed field values or other submitted personal data. */
export function logFormDiscoveryDiagnosticEmitted(params: { runId: string; taskId: string; failureReason: string }): void {
  if (!isFormDiscoveryDiagnosticEnabled()) return;
  // eslint-disable-next-line no-console
  console.log(`FORM_DISCOVERY_DIAGNOSTIC_EMITTED runId=${params.runId} taskId=${params.taskId} failureReason=${params.failureReason}`);
}

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DebugField {
  tag: string;
  type: string | null;
  id: string | null;
  name: string | null;
  placeholder: string | null;
  label: string | null;
  required: boolean;
  visible: boolean;
  disabled: boolean;
  readonly: boolean;
  closestFormIndex: number | null;
  formAttr: string | null;
  boundingBox: BoundingBox;
}

interface DebugCandidate {
  index: number;
  id: string | null;
  name: string | null;
  className: string | null;
  action: string | null;
  visible: boolean;
  boundingBox: BoundingBox;
  withinOverlayLikeContainer: boolean;
  fieldsInSubtree: number;
  fieldsAssociatedViaFormAttribute: number;
  totalEffectiveFieldCount: number;
  fields: DebugField[];
}

/**
 * One rich, self-contained DOM read per candidate form (by document-order index, matching how
 * fillForm.ts's own `forms.nth(i)` addresses it) -- bounding box, visibility, an id/name/class/
 * action identity, a generic overlay/drawer/modal-container heuristic (fixed/absolute/sticky
 * positioning with a raised stacking context, or a role=dialog/aria-modal ancestor -- this
 * module has no access to the engine's own in_document surface tracking, so this is a
 * best-effort generic substitute, not a precise match against it), and full field evidence for
 * every input/select/textarea either inside the form's own DOM subtree or elsewhere on the page
 * with a `form="<this form's id>"` attribute (deduplicated by element identity). Never reads a
 * field's current value.
 */
async function captureCandidateDebug(page: Page, index: number): Promise<DebugCandidate> {
  // Every "helper" below is deliberately inlined with no named function/const declaration of
  // its own (duplicated at each use site instead) -- a named helper called by name from inside
  // a page.evaluate callback is wrapped in a dev-time __name(...) call by this repo's tsx/
  // esbuild toolchain, which is missing at browser-serialize time and throws
  // "ReferenceError: __name is not defined" (a recurring, documented repo-wide gotcha).
  // The same locator fill_form's own discovery uses, so the index means the same form in light
  // DOM and inside open shadow roots alike.
  const forms = page.locator("form");
  if ((await forms.count().catch(() => 0)) <= index) {
    return {
      index,
      id: null,
      name: null,
      className: null,
      action: null,
      visible: false,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      withinOverlayLikeContainer: false,
      fieldsInSubtree: 0,
      fieldsAssociatedViaFormAttribute: 0,
      totalEffectiveFieldCount: 0,
      fields: [],
    };
  }
  return forms.nth(index).evaluate((form, idx) => {
    const subtreeFields = Array.from(form.querySelectorAll("input, select, textarea"));
    const formAttrFields =
      form.id && typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? Array.from((form.getRootNode() as Document | ShadowRoot).querySelectorAll(`input[form="${CSS.escape(form.id)}"], select[form="${CSS.escape(form.id)}"], textarea[form="${CSS.escape(form.id)}"]`)).filter(
            (el) => !subtreeFields.includes(el),
          )
        : [];
    const allFields = [...subtreeFields, ...formAttrFields];

    const formRect = form.getBoundingClientRect();
    const formStyle = getComputedStyle(form);
    const formVisible = formRect.width > 0 && formRect.height > 0 && formStyle.visibility !== "hidden" && formStyle.display !== "none";

    let overlayNode: Element | null = form;
    let withinOverlay = false;
    while (overlayNode && overlayNode !== document.body) {
      if (overlayNode.getAttribute("role") === "dialog" || overlayNode.getAttribute("aria-modal") === "true" || overlayNode.tagName === "DIALOG") {
        withinOverlay = true;
        break;
      }
      const ancestorStyle = getComputedStyle(overlayNode);
      const z = Number(ancestorStyle.zIndex);
      if ((ancestorStyle.position === "fixed" || ancestorStyle.position === "sticky") && ancestorStyle.zIndex !== "auto" && !Number.isNaN(z) && z > 0) {
        withinOverlay = true;
        break;
      }
      overlayNode = overlayNode.parentElement;
    }

    return {
      index: idx,
      id: form.id || null,
      name: form.getAttribute("name"),
      className: form.className || null,
      action: form.getAttribute("action"),
      visible: formVisible,
      boundingBox: { x: formRect.x, y: formRect.y, width: formRect.width, height: formRect.height },
      withinOverlayLikeContainer: withinOverlay,
      fieldsInSubtree: subtreeFields.length,
      fieldsAssociatedViaFormAttribute: formAttrFields.length,
      totalEffectiveFieldCount: allFields.length,
      fields: allFields.map((el) => {
        const inputEl = el as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
        const id = inputEl.id || null;
        const rawLabel = (id && (el.getRootNode() as Document | ShadowRoot).querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim()) || el.closest("label")?.textContent?.trim() || null;
        // A radio's label is an answer (on a dealer widget, a dealer's name or address), never returned.
        const label =
          rawLabel === null
            ? null
            : el.getAttribute("type") === "radio"
              ? "{option_label}"
              : rawLabel.replace(/[^\s@]+@[^\s@]+/g, "{email}").replace(/\+?\d[\d\s().-]{2,}\d/g, "{number}").slice(0, 300);
        const closestForm = el.closest("form");
        const fieldRect = el.getBoundingClientRect();
        const fieldStyle = getComputedStyle(el);
        const fieldVisible = fieldRect.width > 0 && fieldRect.height > 0 && fieldStyle.visibility !== "hidden" && fieldStyle.display !== "none";
        return {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type"),
          id,
          name: el.getAttribute("name"),
          placeholder: el.getAttribute("placeholder"),
          label,
          required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
          visible: fieldVisible,
          disabled: Boolean((inputEl as HTMLInputElement).disabled),
          readonly: Boolean((inputEl as HTMLInputElement).readOnly),
          closestFormIndex: closestForm ? (closestForm === form ? idx : Array.from(document.querySelectorAll("form")).indexOf(closestForm)) : null,
          formAttr: el.getAttribute("form"),
          boundingBox: { x: fieldRect.x, y: fieldRect.y, width: fieldRect.width, height: fieldRect.height },
        };
      }),
    };
  }, index);
}

export interface BuildFormDiscoveryDebugParams {
  page: Page;
  taskId: string;
  journeyContext: FormJourneyContext | undefined;
  currentLastClickLabel: string | undefined;
  activeSurfaceInfo: ActiveSurfaceInfo | undefined;
  captureStage: string;
  candidateIndexes: number[];
  /** Per-candidate score, keyed by the same index as candidateIndexes, from the already-computed candidateEvidence in fillForm.ts (never recomputed here). */
  scoresByIndex: Map<number, FormScoreBreakdown>;
  selection: {
    selectedFormIndex: number | null;
    runnerUpIndex: number | null;
    runnerUpScore: number | null;
    belowConfidenceThreshold: boolean;
    ambiguous: boolean;
    rejectionReason: string;
  };
}

/** Builds the full ActionResult.formDiscoveryDebug payload -- a pure read, no production-behavior side effects. */
export async function buildFormDiscoveryDebug(params: BuildFormDiscoveryDebugParams): Promise<NonNullable<ActionResult["formDiscoveryDebug"]>> {
  const { page, taskId, journeyContext, currentLastClickLabel, activeSurfaceInfo, captureStage, candidateIndexes, scoresByIndex, selection } = params;

  const candidates = await Promise.all(
    candidateIndexes.map(async (index) => {
      const debug = await captureCandidateDebug(page, index);
      const score = scoresByIndex.get(index);
      return {
        ...debug,
        journeyRelevanceScore: score?.journeyRelevanceScore ?? 0,
        visibilityProminenceScore: score?.visibilityProminenceScore ?? 0,
        fieldActionabilityScore: score?.fieldActionabilityScore ?? 0,
        totalFormScore: score?.totalFormScore ?? 0,
      };
    }),
  );

  const anchorLabel = journeyContext?.previousActionLabel ?? null;
  const anchorCta = journeyContext?.journeyAnchorCtaLabel ?? null;
  const ctaPreservedPart =
    anchorCta !== null
      ? anchorLabel === anchorCta
        ? { ctaPreserved: true as const }
        : { ctaPreserved: false as const, replacementLabel: anchorLabel }
      : {};

  return {
    enabled: true,
    runId: taskId,
    taskId,
    capturedAt: new Date().toISOString(),
    pageUrl: page.url(),
    pageTitle: await page.title().catch(() => ""),
    captureStage,
    activeSurfaceKind: activeSurfaceInfo?.kind ?? "main",
    activeSurfaceId: activeSurfaceInfo?.identity ?? null,
    journeyContext: {
      objective: journeyContext?.objective ?? null,
      activeMilestoneTexts: journeyContext?.activeMilestoneTexts ?? [],
      previousActionLabel: anchorLabel,
      lastClickLabelAtCapture: currentLastClickLabel ?? null,
      journeyAnchorCtaLabel: anchorCta,
      ...ctaPreservedPart,
    },
    candidates,
    selection: {
      selectedFormIndex: selection.selectedFormIndex,
      runnerUpIndex: selection.runnerUpIndex,
      runnerUpScore: selection.runnerUpScore,
      adoptThreshold: FORM_SELECTION_ADOPT_THRESHOLD,
      rejectThreshold: FORM_SELECTION_REJECT_THRESHOLD,
      ambiguityMargin: 0.1,
      belowConfidenceThreshold: selection.belowConfidenceThreshold,
      ambiguous: selection.ambiguous,
      rejectionReason: selection.rejectionReason,
    },
  };
}

/** Optional local-file backup only -- never the primary exposure channel (see ActionResult.formDiscoveryDebug above). Failures here are swallowed; they must never affect the action's own result. */
export async function writeFormDiscoveryDebugBackup(debug: NonNullable<ActionResult["formDiscoveryDebug"]>): Promise<void> {
  if (!isFormDiscoveryDiagnosticEnabled()) return;
  try {
    const dir = join(process.cwd(), "diagnostics", "form-discovery");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${Date.now()}.json`), JSON.stringify(debug, null, 2), "utf8");
  } catch {
    // Optional backup only -- never fail or affect the action's own result.
  }
}
