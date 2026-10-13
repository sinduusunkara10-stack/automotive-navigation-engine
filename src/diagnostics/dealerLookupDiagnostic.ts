import type { Locator, Page } from "playwright";
import { FIELD_INDEX_ATTR, TRIGGER_INDEX_ATTR, type DealerLookupOutcome, type RawLookupTriggerCandidate, type TriggerFieldPairDebug } from "../actions/dealerLookup.js";
import type { PlannedField } from "../forms/fillPlan.js";
import { isFormDiscoveryDiagnosticEnabled } from "./formDiscoveryDiagnostic.js";

/**
 * Opt-in, investigation-only dealer/postcode decision-trace evidence (see
 * ActionResult.dealerLookupTrace in types/task-response.ts and schemas/task-response.schema.json).
 * Reuses the same FORM_DISCOVERY_DIAGNOSTIC=1 gate as formDiscoveryDiagnostic.ts -- a second,
 * independent flag was deliberately not introduced. Never reads or writes anything that affects
 * trigger-to-field association, dealer-lookup matching, thresholds, or fill/submit behaviour, all
 * of which are computed identically whether this module runs or not: it only reads state those
 * code paths already produced (tagAndFindLookupTriggers' own candidates/pairDebug, the fill plan,
 * resolveDealerLookup's own outcome) plus a handful of additional, non-mutating DOM reads.
 * Never includes a typed/entered value, a selected suggestion's own text, or any other submitted
 * personal data -- only structural/positional/scoring evidence and counts.
 */

interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DealerLookupFieldTrace {
  /** Stable, sanitised identifier -- "field-<index>" or "trigger-<index>", never a raw DOM id (which could carry site-specific or, in principle, user-identifying text). */
  elementId: string;
  role: "field" | "trigger";
  fieldIndex: string | null;
  triggerIndex: string | null;
  label: string | null;
  name: string | null;
  tag: string;
  inputType: string | null;
  semanticRole: string | null;
  visible: boolean;
  enabled: boolean;
  required: boolean;
  /** Never the value itself -- only whether the control currently holds a non-empty value. */
  populated: boolean;
  ariaAttributes: { attribute: string; value: string }[];
  ariaRelationshipTargets: { attribute: string; targetId: string; targetExists: boolean }[];
  formId: string | null;
  sectionId: string | null;
  /** Bounded ancestor chain, nearest first, stopping at the owning <form> -- tag name and whether that ancestor carries an id/role, never its class list or text content. */
  domAncestry: { tag: string; hasId: boolean; role: string | null }[];
  boundingBox: BoundingBox;
}

export interface DealerLookupDiagnosticCompleteness {
  status: "COMPLETE" | "INCOMPLETE";
  missingEvidence: string[];
  evaluatedCandidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  finalDecision: string;
  finalDecisionReason: string;
}

export interface DealerLookupExecutionSummary {
  associatedPostcodeFieldIndex: string | null;
  associatedDealerTriggerIndex: string | null;
  eventsDispatched: string[];
  waitCondition: string | null;
  waitTimeoutMs: number | null;
  waitOutcome: "resolved" | "timed_out" | "not_attempted";
  suggestionsDetected: boolean;
  suggestionCount: number;
  selectedSuggestionIdentity: string | null;
  dealerResultsDetected: boolean;
  dealerSelectionAttempted: boolean;
  dealerSelectionOutcome: string;
  dealerIdentifierStateBefore: "not_applicable" | "absent" | "present";
  dealerIdentifierStateAfter: "not_applicable" | "absent" | "present";
  hiddenFieldChangeDetected: boolean;
  networkResponseEvidence: string;
  positiveCompletionEvidenceUsed: string;
  preSubmitReadinessResult: "passed" | "blocked" | "not_evaluated";
  exactBlockingReason: string;
}

export interface DealerLookupTrace {
  enabled: true;
  runId: string;
  taskId: string;
  capturedAt: string;
  captureStage: string;
  fields: DealerLookupFieldTrace[];
  triggerFieldPairs: TriggerFieldPairDebug[];
  execution: DealerLookupExecutionSummary;
  diagnosticCompleteness: DealerLookupDiagnosticCompleteness;
}

/** One rich DOM read per field/trigger element, keyed by its own tagged index attribute. No named helper inside the evaluate callback (tsx/esbuild __name serialization gotcha -- see formDiscoveryDiagnostic.ts's own comment on this). */
async function readElementTrace(
  page: Page,
  targets: { elementId: string; role: "field" | "trigger"; index: string }[],
): Promise<DealerLookupFieldTrace[]> {
  if (targets.length === 0) return [];
  return page.evaluate(
    (args: { targets: { elementId: string; role: "field" | "trigger"; index: string }[]; fieldAttr: string; triggerAttr: string }) => {
      return args.targets.map((target) => {
        const attr = target.role === "field" ? args.fieldAttr : args.triggerAttr;
        const el = document.querySelector(`[${attr}="${target.index}"]`) as HTMLElement | null;
        if (!el) {
          return {
            elementId: target.elementId,
            role: target.role,
            fieldIndex: target.role === "field" ? target.index : null,
            triggerIndex: target.role === "trigger" ? target.index : null,
            label: null,
            name: null,
            tag: "unknown",
            inputType: null,
            semanticRole: null,
            visible: false,
            enabled: false,
            required: false,
            populated: false,
            ariaAttributes: [],
            ariaRelationshipTargets: [],
            formId: null,
            sectionId: null,
            domAncestry: [],
            boundingBox: { x: 0, y: 0, width: 0, height: 0 },
          };
        }

        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        const inputLike = el as HTMLInputElement;
        const tag = el.tagName.toLowerCase();
        const inputType = tag === "input" ? el.getAttribute("type") : null;
        const id = el.getAttribute("id");
        const byForLabel = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const label = byForLabel?.textContent?.trim() || el.closest("label")?.textContent?.trim() || el.getAttribute("aria-label")?.trim() || null;

        const ariaAttributes: { attribute: string; value: string }[] = [];
        const ariaRelationshipTargets: { attribute: string; targetId: string; targetExists: boolean }[] = [];
        const relationshipAttrs = ["aria-controls", "aria-owns", "aria-describedby", "aria-labelledby"];
        Array.from(el.attributes).forEach((a) => {
          if (a.name === "role" || a.name.startsWith("aria-")) {
            ariaAttributes.push({ attribute: a.name, value: a.value });
          }
        });
        relationshipAttrs.forEach((attrName) => {
          const value = el.getAttribute(attrName);
          if (!value) return;
          value
            .split(/\s+/)
            .filter(Boolean)
            .forEach((targetId) => {
              ariaRelationshipTargets.push({ attribute: attrName, targetId, targetExists: document.getElementById(targetId) !== null });
            });
        });

        const closestForm = el.closest("form");
        let sectionId: string | null = null;
        let sectionNode: Element | null = el.parentElement;
        let sectionSteps = 0;
        while (sectionNode && sectionNode !== closestForm && sectionSteps < 10 && !sectionId) {
          const candidateId = sectionNode.getAttribute("id") || sectionNode.getAttribute("data-section") || sectionNode.getAttribute("data-testid");
          if (candidateId) sectionId = candidateId;
          sectionNode = sectionNode.parentElement;
          sectionSteps += 1;
        }

        const domAncestry: { tag: string; hasId: boolean; role: string | null }[] = [];
        let ancestor: Element | null = el.parentElement;
        let ancestorSteps = 0;
        while (ancestor && ancestor !== closestForm?.parentElement && ancestorSteps < 8) {
          domAncestry.push({ tag: ancestor.tagName.toLowerCase(), hasId: Boolean(ancestor.getAttribute("id")), role: ancestor.getAttribute("role") });
          if (ancestor === closestForm) break;
          ancestor = ancestor.parentElement;
          ancestorSteps += 1;
        }

        let populated = false;
        if (tag === "select") {
          populated = (el as HTMLSelectElement).value.trim().length > 0;
        } else if (inputType === "checkbox" || inputType === "radio") {
          populated = inputLike.checked === true;
        } else if (tag === "input" || tag === "textarea") {
          populated = inputLike.value.trim().length > 0;
        } else {
          populated = (el.textContent?.trim().length ?? 0) > 0;
        }

        return {
          elementId: target.elementId,
          role: target.role,
          fieldIndex: target.role === "field" ? target.index : null,
          triggerIndex: target.role === "trigger" ? target.index : null,
          label,
          name: el.getAttribute("name"),
          tag,
          inputType,
          semanticRole: el.getAttribute("role") ?? (tag === "button" || inputType === "button" ? "button" : tag === "input" ? "textbox" : null),
          visible,
          enabled: !inputLike.disabled,
          required: el.hasAttribute("required") || el.getAttribute("aria-required") === "true",
          populated,
          ariaAttributes,
          ariaRelationshipTargets,
          formId: closestForm?.id || null,
          sectionId,
          domAncestry,
          boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      });
    },
    { targets, fieldAttr: FIELD_INDEX_ATTR, triggerAttr: TRIGGER_INDEX_ATTR },
  );
}

export interface BuildDealerLookupTraceParams {
  page: Page;
  form: Locator;
  taskId: string;
  captureStage: string;
  plan: PlannedField[];
  triggerCandidates: RawLookupTriggerCandidate[];
  pairDebug: TriggerFieldPairDebug[];
  dealerLookupOutcome: DealerLookupOutcome | undefined;
  preSubmitReadinessPassed: boolean | null;
  preSubmitReadinessFailures: string[];
}

function computeCompleteness(params: {
  triggerCandidates: RawLookupTriggerCandidate[];
  pairDebug: TriggerFieldPairDebug[];
  postcodeOrDealerFieldIds: string[];
  dealerLookupOutcome: DealerLookupOutcome | undefined;
  preSubmitReadinessPassed: boolean | null;
}): DealerLookupDiagnosticCompleteness {
  const { triggerCandidates, pairDebug, postcodeOrDealerFieldIds, dealerLookupOutcome, preSubmitReadinessPassed } = params;
  const missingEvidence: string[] = [];

  const triggerFound = triggerCandidates.length > 0;
  if (!triggerFound) missingEvidence.push("no lookup-trigger candidate was found on the form at all");

  const anyAssociated = triggerCandidates.some((t) => t.adjacentFieldId !== null);
  if (triggerFound && !anyAssociated) missingEvidence.push("a trigger was found but never associated with any field");

  if (postcodeOrDealerFieldIds.length > 0 && pairDebug.length === 0) {
    missingEvidence.push("no per-candidate acceptance/rejection evidence was captured for the postcode/dealer field(s) found");
  }

  const suggestionsEvidencePresent = dealerLookupOutcome !== undefined;
  if (!suggestionsEvidencePresent) missingEvidence.push("the dealer-lookup flow never ran, so no postcode-suggestion evidence exists");

  const selectionEvidencePresent = dealerLookupOutcome !== undefined;
  if (!selectionEvidencePresent) missingEvidence.push("no location/dealer selection evidence exists (the dealer-lookup flow never ran)");

  const positiveCompletionEvidencePresent = dealerLookupOutcome?.dealerValueVerified !== undefined;
  if (!positiveCompletionEvidencePresent) missingEvidence.push("no positive-completion evidence exists (dealerValueVerified was never computed)");

  if (preSubmitReadinessPassed === null) missingEvidence.push("the pre-submit readiness gate had not run yet at this capture point");

  const acceptedCandidateCount = pairDebug.filter((p) => p.accepted).length;
  const rejectedCandidateCount = pairDebug.filter((p) => !p.accepted).length;

  const finalDecision = preSubmitReadinessPassed === true ? "submit_allowed" : preSubmitReadinessPassed === false ? "submit_blocked" : "not_yet_decided";
  const finalDecisionReason =
    preSubmitReadinessPassed === null
      ? "pre-submit readiness gate has not run yet at this capture point"
      : preSubmitReadinessPassed
        ? "every readiness condition (required fields, dealer dependency, consent groups) passed"
        : "at least one readiness condition failed -- see execution.exactBlockingReason";

  return {
    status: missingEvidence.length === 0 ? "COMPLETE" : "INCOMPLETE",
    missingEvidence,
    evaluatedCandidateCount: pairDebug.length,
    acceptedCandidateCount,
    rejectedCandidateCount,
    finalDecision,
    finalDecisionReason,
  };
}

/** Builds the full ActionResult.dealerLookupTrace payload -- a pure read, no production-behavior side effects. */
export async function buildDealerLookupTrace(params: BuildDealerLookupTraceParams): Promise<DealerLookupTrace | undefined> {
  if (!isFormDiscoveryDiagnosticEnabled()) return undefined;
  const { page, taskId, captureStage, plan, triggerCandidates, pairDebug, dealerLookupOutcome, preSubmitReadinessPassed, preSubmitReadinessFailures } = params;

  const postcodeOrDealerFields = plan.filter((p) => p.matchedField === "postcode" || p.matchedField === "dealerSearch");
  const fieldTargets = postcodeOrDealerFields.map((p) => ({ elementId: `field-${p.descriptor.id}`, role: "field" as const, index: p.descriptor.id }));
  const triggerTargets = triggerCandidates.map((t) => ({ elementId: `trigger-${t.triggerIndex}`, role: "trigger" as const, index: t.triggerIndex }));

  let fields: DealerLookupFieldTrace[] = [];
  try {
    fields = await readElementTrace(page, [...fieldTargets, ...triggerTargets]);
  } catch {
    fields = [];
  }

  const dealerFieldPlanned = postcodeOrDealerFields.find((p) => p.decision.kind === "dealer_search");
  const associatedPostcodeFieldIndex = dealerFieldPlanned?.descriptor.id ?? null;
  const associatedDealerTriggerIndex = dealerFieldPlanned?.decision.kind === "dealer_search" ? (dealerFieldPlanned.decision.triggerIndex ?? null) : null;

  const trace = dealerLookupOutcome?.executionTrace;
  const execution: DealerLookupExecutionSummary = {
    associatedPostcodeFieldIndex,
    associatedDealerTriggerIndex,
    eventsDispatched: trace?.eventsDispatched ?? [],
    waitCondition: trace?.waitCondition ?? null,
    waitTimeoutMs: trace?.waitTimeoutMs ?? null,
    waitOutcome: trace?.waitOutcome ?? "not_attempted",
    suggestionsDetected: trace?.suggestionsDetected ?? false,
    suggestionCount: trace?.suggestionCount ?? 0,
    selectedSuggestionIdentity: trace?.selectedSuggestionIdentity ?? null,
    dealerResultsDetected: dealerLookupOutcome?.dealerResultsDetected ?? false,
    dealerSelectionAttempted: dealerLookupOutcome?.dealerSelected ?? false,
    dealerSelectionOutcome: dealerLookupOutcome?.dealerLookupOutcome ?? "not_applicable",
    dealerIdentifierStateBefore: dealerLookupOutcome === undefined ? "not_applicable" : "absent",
    dealerIdentifierStateAfter: dealerLookupOutcome === undefined ? "not_applicable" : dealerLookupOutcome.dealerValueVerified ? "present" : "absent",
    hiddenFieldChangeDetected: dealerLookupOutcome?.dealerAutoPopulated ?? false,
    networkResponseEvidence: "no network-response capture is wired into the dealer-lookup flow -- this evidence source does not exist yet",
    positiveCompletionEvidenceUsed: dealerLookupOutcome?.dealerVerificationEvidence || "none: the dealer-lookup flow never ran for this form",
    preSubmitReadinessResult: preSubmitReadinessPassed === null ? "not_evaluated" : preSubmitReadinessPassed ? "passed" : "blocked",
    exactBlockingReason: preSubmitReadinessPassed === false ? preSubmitReadinessFailures.join("; ") : preSubmitReadinessPassed === true ? "not blocked" : "readiness gate has not run yet",
  };

  const diagnosticCompleteness = computeCompleteness({
    triggerCandidates,
    pairDebug,
    postcodeOrDealerFieldIds: postcodeOrDealerFields.map((p) => p.descriptor.id),
    dealerLookupOutcome,
    preSubmitReadinessPassed,
  });

  return {
    enabled: true,
    runId: taskId,
    taskId,
    capturedAt: new Date().toISOString(),
    captureStage,
    fields,
    triggerFieldPairs: pairDebug,
    execution,
    diagnosticCompleteness,
  };
}
