import type { Locator } from "playwright";
import { phoneValueForField, type PhoneInputConstraints } from "../forms/phoneFormat.js";
import { alternatePhoneFormatFor } from "../forms/testData.js";
import { readFieldsValidationState } from "./fieldValidationState.js";
import type { VisualEvidenceRecorder, VisualEvidenceStage } from "../diagnostics/visualEvidence.js";

/**
 * A phone number is only "filled" once the site has had the chance to judge it: many sites
 * validate on blur and reject a format they don't accept (e.g. an international number where a
 * national one is required) with an inline error that later cancels Submit. The field is blurred,
 * the site's own verdict is read, and a visible rejection gets one refill with the same test
 * number in the market's other format. No typed value is ever recorded -- only its shape.
 */

const SETTLE_MS = 400;
const SLOW_VALIDATOR_MS = 1_200;

export interface PhoneValueShape {
  format: "international" | "national";
  digitCount: number;
  separatorCount: number;
  /** The field's DOM value after the fill equals what was typed (a mask or the site's JS did not rewrite it). */
  domValueMatchesTyped: boolean;
  /** Presentation separators were stripped from the configured value before typing. */
  normalisedBeforeFill: boolean;
}

export interface PhoneVerdict {
  rejected: boolean;
  /** native_invalid, aria_invalid, and the site-validator evidence (error_class, error_icon, error_message, jquery_validator_invalid). */
  evidence: string[];
  nativeValid: boolean;
  validationMessageLength: number;
  ariaInvalid: "true" | "false" | "absent";
  siteErrorMessageLength: number;
}

export interface PhoneValidationOutcome {
  fieldId: string;
  purpose: string;
  initialShape: PhoneValueShape;
  initialVerdict: PhoneVerdict;
  retriedWithAlternateFormat: boolean;
  finalShape: PhoneValueShape;
  finalVerdict: PhoneVerdict;
  finalState: "rejected" | "no_rejection_observed";
}

interface FieldReading {
  value: string;
  nativeValid: boolean;
  validationMessageLength: number;
  ariaInvalid: "true" | "false" | "absent";
}

async function readField(field: Locator): Promise<FieldReading | null> {
  return field
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      const aria = input.getAttribute("aria-invalid");
      return {
        value: input.value ?? "",
        nativeValid: input.validity ? input.validity.valid : true,
        validationMessageLength: (input.validationMessage || "").length,
        ariaInvalid: (aria === "true" ? "true" : aria === "false" ? "false" : "absent") as "true" | "false" | "absent",
      };
    }, undefined, { timeout: 2_000 })
    .catch(() => null);
}

export async function phoneVerdict(form: Locator, field: Locator, fieldAttr: string, fieldId: string): Promise<{ verdict: PhoneVerdict; value: string | null }> {
  const reading = await readField(field);
  const site = (await readFieldsValidationState(form, fieldAttr, [fieldId])).get(fieldId);
  const evidence: string[] = [];
  if (reading && !reading.nativeValid) evidence.push("native_invalid");
  if (reading?.ariaInvalid === "true") evidence.push("aria_invalid");
  if (site?.validatorState === "invalid") for (const e of site.evidence) if (e !== "aria_invalid") evidence.push(e);
  return {
    verdict: {
      rejected: evidence.length > 0,
      evidence,
      nativeValid: reading?.nativeValid ?? true,
      validationMessageLength: reading?.validationMessageLength ?? 0,
      ariaInvalid: reading?.ariaInvalid ?? "absent",
      siteErrorMessageLength: site?.errorMessageLength ?? 0,
    },
    value: reading?.value ?? null,
  };
}

function shapeOf(configured: string, typed: string, domValue: string | null): PhoneValueShape {
  return {
    format: typed.trim().startsWith("+") ? "international" : "national",
    digitCount: (typed.match(/\d/g) ?? []).length,
    separatorCount: (typed.match(/[^\d+]/g) ?? []).length,
    domValueMatchesTyped: domValue === typed,
    normalisedBeforeFill: typed !== configured,
  };
}

async function fillAndJudge(
  form: Locator,
  field: Locator,
  fieldAttr: string,
  fieldId: string,
  configured: string,
  constraints: PhoneInputConstraints,
  visualEvidence: VisualEvidenceRecorder | undefined,
  afterFillStage: VisualEvidenceStage,
) {
  const typed = phoneValueForField(configured, constraints);
  await field.fill(typed);
  await visualEvidence?.capture(afterFillStage, null, field);
  await field.blur({ timeout: 2_000 }).catch(() => {});
  await form.page().waitForTimeout(SETTLE_MS);
  let judged = await phoneVerdict(form, field, fieldAttr, fieldId);
  if (!judged.verdict.rejected) {
    // Some validators answer asynchronously (a debounced or remote check); give them one more look.
    await form.page().waitForTimeout(SLOW_VALIDATOR_MS - SETTLE_MS);
    judged = await phoneVerdict(form, field, fieldAttr, fieldId);
  }
  await visualEvidence?.capture("phone_after_blur", null, field);
  return { shape: shapeOf(configured, typed, judged.value), verdict: judged.verdict };
}

export async function fillPhoneAndVerify(
  form: Locator,
  field: Locator,
  fieldAttr: string,
  fieldId: string,
  purpose: string,
  configured: string,
  visualEvidence?: VisualEvidenceRecorder,
): Promise<PhoneValidationOutcome> {
  const constraints = await field
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      return { pattern: input.getAttribute("pattern"), maxLength: input.maxLength, minLength: input.minLength };
    })
    .catch(() => ({}));
  const initial = await fillAndJudge(form, field, fieldAttr, fieldId, configured, constraints, visualEvidence, "phone_after_fill");
  let final = initial;
  let retried = false;
  const alternate = alternatePhoneFormatFor(configured);
  if (initial.verdict.rejected && alternate !== undefined) {
    retried = true;
    final = await fillAndJudge(form, field, fieldAttr, fieldId, alternate, constraints, visualEvidence, "phone_after_alternate_format");
  }
  return {
    fieldId,
    purpose,
    initialShape: initial.shape,
    initialVerdict: initial.verdict,
    retriedWithAlternateFormat: retried,
    finalShape: final.shape,
    finalVerdict: final.verdict,
    finalState: final.verdict.rejected ? "rejected" : "no_rejection_observed",
  };
}
