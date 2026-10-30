import type { Page } from "playwright";

import { elementLocatorSelector, resolveElementActionTarget } from "../observation/observationBuilder.js";
import type { ActionResult } from "../types/task-response.js";

/** Completion evidence the engine observed on the page itself -- never an analytics or tracking event. */
export type ObservedSubmissionSignal =
  | "url_change"
  | "confirmation_message"
  | "success_status_surface"
  | "form_replaced_after_accepted_business_response";

const OBSERVED_SIGNALS: readonly ObservedSubmissionSignal[] = [
  "url_change",
  "confirmation_message",
  "success_status_surface",
  "form_replaced_after_accepted_business_response",
];

/**
 * A run-level fact: one fill_form action filled every required field, passed its own pre-submit
 * readiness checks, submitted, and was followed by completion evidence observed on the page. Built
 * only from fill_form's own ActionResult, so it is the same for every site, language and DOM mode.
 */
export interface VerifiedFormSubmission {
  stepIndex: number;
  requiredFieldsDetected: number;
  requiredFieldsFilled: number;
  preSubmitReadinessPassed: true;
  submitAttempts: number;
  confirmationSignals: ObservedSubmissionSignal[];
  formStillPresentAfterSubmit: boolean;
  businessRequestObserved: boolean;
  analyticsCorroboration: boolean;
}

export function deriveVerifiedFormSubmission(result: ActionResult, stepIndex: number): VerifiedFormSubmission | undefined {
  const post = result.formPostSubmitDiagnostics;
  const discovery = result.formDiscoveryDiagnostics;
  const observation = post?.postSubmitObservation;
  if (result.success !== true || result.formFillOutcome !== "submitted" || !post || !discovery || !observation) return undefined;
  if (post.submissionOutcome !== "succeeded" || post.preSubmitReadinessPassed !== true || post.submitAttempted !== true) return undefined;
  if (observation.terminalState !== "succeeded") return undefined;
  if (discovery.requiredFieldsDetected < 1 || discovery.requiredFieldsFilled < discovery.requiredFieldsDetected) return undefined;
  if (discovery.unmappedRequiredFieldIds.length > 0) return undefined;
  const signals = new Set(observation.successSignals.filter((s): s is ObservedSubmissionSignal => (OBSERVED_SIGNALS as readonly string[]).includes(s)));
  if (result.formSuccessDetection === "url_change") signals.add("url_change");
  if (signals.size === 0) return undefined;
  return {
    stepIndex,
    requiredFieldsDetected: discovery.requiredFieldsDetected,
    requiredFieldsFilled: discovery.requiredFieldsFilled,
    preSubmitReadinessPassed: true,
    submitAttempts: post.submitAttemptSummary.totalSubmitAttempts,
    confirmationSignals: OBSERVED_SIGNALS.filter((s) => signals.has(s)),
    formStillPresentAfterSubmit: observation.formStillPresentAtEnd,
    businessRequestObserved: observation.businessRequestDetected,
    analyticsCorroboration: observation.successSignals.includes("virtual_page_success_event"),
  };
}

/**
 * True when the click target is a submit control or sits inside a form, light DOM or open shadow
 * root alike. After a verified submission any such click can send the form again or reopen it for a
 * second lead, so the loop refuses it; an unresolvable target is treated the same way (fail closed).
 */
export async function isFormInteractionTarget(page: Page, elementId: string): Promise<boolean> {
  const target = await resolveElementActionTarget(page, elementId).catch(() => undefined);
  if (!target) return true;
  return target
    .locator(elementLocatorSelector(elementId))
    .first()
    .evaluate(
      (el: Element) => {
        const type = (el.getAttribute("type") ?? "").toLowerCase();
        if (el.tagName === "INPUT" && (type === "submit" || type === "image")) return true;
        if (el.tagName === "BUTTON" && (el as HTMLButtonElement).type === "submit" && (el as HTMLButtonElement).form) return true;
        let node: Element | null = el;
        while (node) {
          if (node.tagName === "FORM") return true;
          if (node.parentElement) {
            node = node.parentElement;
          } else {
            const root = node.getRootNode();
            node = root instanceof ShadowRoot ? root.host : null;
          }
        }
        return false;
      },
      undefined,
      { timeout: 2_000 },
    )
    .then((value) => value === true)
    .catch(() => true);
}
