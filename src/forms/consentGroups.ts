import type { Locator, Page } from "playwright";
import { findNegativeOptionLabel } from "./fillPlan.js";
import type { FormJourneyContext } from "./formRelevance.js";
import { classifyRadioGroup, resolveJourneyIntentOption, resolvePrivateCustomerOption, type RadioGroupClassification } from "./radioGroupClassifier.js";
import type { SupportedLanguage } from "./testData.js";

/** Same attribute tagAndReadFields (fillForm.ts) writes on every input/select/textarea it tags. */
const FIELD_INDEX_ATTR = "data-nav-engine-field-index";

export interface ConsentGroupDescriptor {
  /** The shared `name` attribute of the group's radio inputs (its stable identity across rescans). */
  groupId: string;
  memberFieldIds: string[];
  memberLabels: string[];
  visible: boolean;
  requiredEvidence: "attribute" | "marker" | "none";
  /** The question text found via fieldset/legend, aria-labelledby, or nearby generic text -- never the options' own "Oui"/"Non"-style labels. */
  questionText: string;
  checkedMemberFieldId: string | null;
}

/**
 * Generic, language-agnostic radio-group discovery. A consent question is very often expressed
 * as two (or more) `<input type="radio">` options whose OWN labels are only "Oui"/"Non" or
 * "Yes"/"No" -- the actual question text lives in a separate legend/paragraph/heading, never in
 * the option's own label/name/placeholder, so the field-level matchLeadFormField keyword matcher
 * (which only ever looks at a field's own text) can never identify these at all. This groups by
 * the HTML `name` attribute (the native grouping mechanism every radio button already relies on)
 * and locates the question text through fieldset/legend first, then aria-labelledby, then a
 * bounded nearest-preceding-text walk (same shape as tagAndReadFields's own label-fallback walk)
 * that explicitly excludes any text identical to one of the group's own option labels.
 */
export async function discoverConsentGroups(form: Locator): Promise<ConsentGroupDescriptor[]> {
  return form.evaluate((formEl: HTMLFormElement, attr: string) => {
    const radios = Array.from(formEl.querySelectorAll('input[type="radio"]')) as HTMLInputElement[];
    const groups = new Map<string, HTMLInputElement[]>();
    radios.forEach((radio) => {
      const name = radio.getAttribute("name");
      if (!name) return;
      const list = groups.get(name) ?? [];
      list.push(radio);
      groups.set(name, list);
    });

    const results: {
      groupId: string;
      memberFieldIds: string[];
      memberLabels: string[];
      visible: boolean;
      requiredEvidence: "attribute" | "marker" | "none";
      questionText: string;
      checkedMemberFieldId: string | null;
    }[] = [];

    groups.forEach((members, groupId) => {
      const memberFieldIds = members.map((m) => m.getAttribute(attr) ?? "");
      const memberLabels = members.map((m) => {
        const id = m.getAttribute("id");
        const byFor = id ? formEl.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const closest = m.closest("label");
        return (byFor ?? closest)?.textContent?.trim() || m.getAttribute("aria-label") || m.value || "";
      });
      const optionTexts = new Set(memberLabels.map((l) => l.trim().toLowerCase()).filter(Boolean));

      const visible = members.some((m) => {
        const rect = m.getBoundingClientRect();
        const style = window.getComputedStyle(m);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });

      const hasAttributeRequired = members.some((m) => m.hasAttribute("required") || m.getAttribute("aria-required") === "true");

      let questionText = "";
      const fieldset = members[0]?.closest("fieldset") ?? null;
      const legend = fieldset?.querySelector("legend") ?? null;
      if (legend) {
        questionText = legend.textContent?.trim() ?? "";
      }
      if (!questionText) {
        const labelledBy = members[0]?.getAttribute("aria-labelledby");
        if (labelledBy) {
          const labelled = document.getElementById(labelledBy);
          if (labelled) questionText = labelled.textContent?.trim() ?? "";
        }
      }
      if (!questionText && members[0]) {
        let node: Element | null = members[0];
        let steps = 0;
        while (node && node !== formEl && steps < 6 && !questionText) {
          let sibling: Element | null = node.previousElementSibling;
          let siblingSteps = 0;
          while (sibling && siblingSteps < 4 && !questionText) {
            const text = sibling.textContent?.trim() ?? "";
            if (text.length > 10 && !optionTexts.has(text.toLowerCase()) && sibling.querySelector('input[type="radio"]') === null) {
              questionText = text;
            }
            sibling = sibling.previousElementSibling;
            siblingSteps += 1;
          }
          node = node.parentElement;
          steps += 1;
        }
      }

      let hasRequiredMarker = /\*\s*$/.test(questionText);
      const requiredEvidence: "attribute" | "marker" | "none" = hasAttributeRequired ? "attribute" : hasRequiredMarker ? "marker" : "none";

      const checkedMember = members.find((m) => m.checked);

      results.push({
        groupId,
        memberFieldIds,
        memberLabels,
        visible,
        requiredEvidence,
        questionText,
        checkedMemberFieldId: checkedMember ? (checkedMember.getAttribute(attr) ?? null) : null,
      });
    });

    return results;
  }, FIELD_INDEX_ATTR);
}

export interface ConsentGroupResolutionResult {
  consentGroupsDetected: number;
  consentGroupsInitiallyVisible: number;
  consentGroupDiagnostics: {
    groupId: string;
    questionText: string;
    requiredEvidence: "attribute" | "marker" | "none";
    resolved: boolean;
    selectedMemberFieldId: string | null;
    /** Three-way taxonomy result (see radioGroupClassifier.ts) -- "ambiguous" is never resolved. */
    classification: RadioGroupClassification;
    classificationEvidence: string;
    /** Why this option was selected, present only when resolved. */
    selectionReason?: string;
    /** Why this group was left unresolved despite being visible, present only when not resolved. */
    unresolvedReason?: string;
  }[];
  consentGroupsCompleted: number;
  conditionalConsentGroupsRevealed: number;
  consentRescanCount: number;
  unresolvedRequiredConsentGroups: string[];
}

const MAX_RESCANS = 5;

/**
 * Resolves every currently-visible radio group according to its classification (see
 * radioGroupClassifier.ts): marketing_consent keeps the original opt-out/negative-option
 * resolution; journey_intent is matched against the task's own workflow journey context, never
 * defaulted; customer_qualification always resolves to the private-customer option, a fixed
 * policy independent of any workflow field; ambiguous groups are left unresolved rather than
 * guessed. Then rescans for newly revealed conditional groups until none remain or the bounded
 * loop limit is reached. The readiness gate (fillForm.ts), not this function, decides what
 * blocks submit -- but an unresolved required group now stays unresolved on purpose when this
 * function cannot confidently classify or resolve it, rather than silently defaulting.
 */
export async function resolveConsentGroups(
  page: Page,
  form: Locator,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  journeyContext: FormJourneyContext = {},
): Promise<ConsentGroupResolutionResult> {
  const seenVisibleGroupIds = new Set<string>();
  const completedGroupIds = new Set<string>();
  const blockedGroupIds = new Set<string>();
  const groupMeta = new Map<string, { classification: RadioGroupClassification; classificationEvidence: string; selectionReason?: string; unresolvedReason?: string }>();
  let conditionalRevealedCount = 0;
  let consentGroupsInitiallyVisible = 0;
  let rescanCount = 0;

  for (; rescanCount <= MAX_RESCANS; rescanCount += 1) {
    const groups = await discoverConsentGroups(form);
    const visibleGroups = groups.filter((g) => g.visible);

    if (rescanCount === 0) {
      consentGroupsInitiallyVisible = visibleGroups.length;
      visibleGroups.forEach((g) => seenVisibleGroupIds.add(g.groupId));
    } else {
      const newlyRevealed = visibleGroups.filter((g) => !seenVisibleGroupIds.has(g.groupId));
      conditionalRevealedCount += newlyRevealed.length;
      newlyRevealed.forEach((g) => seenVisibleGroupIds.add(g.groupId));
    }

    const unresolved = visibleGroups.filter(
      (g) => g.checkedMemberFieldId === null && !completedGroupIds.has(g.groupId) && !blockedGroupIds.has(g.groupId),
    );
    if (unresolved.length === 0) break;

    for (const group of unresolved) {
      const classificationResult = classifyRadioGroup({ questionText: group.questionText, memberLabels: group.memberLabels }, language);

      let resolution: { index: number; reason: string } | undefined;
      switch (classificationResult.classification) {
        case "marketing_consent": {
          const negativeLabel = findNegativeOptionLabel(group.memberLabels, language);
          const targetIndex = negativeLabel ? group.memberLabels.indexOf(negativeLabel) : group.memberFieldIds.length - 1;
          resolution = { index: targetIndex, reason: negativeLabel ? `selected the negative/opt-out option ("${negativeLabel}")` : "no negative/opt-out option found; selected the last option as the deterministic opt-out default" };
          break;
        }
        case "journey_intent":
          resolution = resolveJourneyIntentOption(group.memberLabels, journeyContext, language);
          break;
        case "customer_qualification":
          resolution = resolvePrivateCustomerOption(group.memberLabels, language);
          break;
        case "ambiguous":
          resolution = undefined;
          break;
      }

      if (resolution) {
        const targetFieldId = group.memberFieldIds[resolution.index];
        if (targetFieldId) {
          const field = await fieldByIndex(form, targetFieldId);
          await field.check().catch(() => {});
          completedGroupIds.add(group.groupId);
          groupMeta.set(group.groupId, {
            classification: classificationResult.classification,
            classificationEvidence: classificationResult.evidence,
            selectionReason: resolution.reason,
          });
          continue;
        }
      }

      // Unresolvable with confidence (ambiguous classification, or a confidently-classified
      // group with no confidently-matching option) -- left unresolved on purpose, never
      // defaulted, and not retried on subsequent rescans since the same evidence would just
      // repeat the same outcome.
      blockedGroupIds.add(group.groupId);
      groupMeta.set(group.groupId, {
        classification: classificationResult.classification,
        classificationEvidence: classificationResult.evidence,
        unresolvedReason:
          classificationResult.classification === "ambiguous"
            ? "classification was ambiguous; left unresolved rather than guessed"
            : `classified as ${classificationResult.classification} but no option could be confidently resolved; left unresolved rather than guessed`,
      });
    }
    await page.waitForTimeout(100);
  }

  const finalGroups = await discoverConsentGroups(form);
  const finalVisibleGroups = finalGroups.filter((g) => g.visible);
  const unresolvedRequired = finalVisibleGroups.filter((g) => g.checkedMemberFieldId === null && g.requiredEvidence !== "none");

  return {
    consentGroupsDetected: finalGroups.length,
    consentGroupsInitiallyVisible,
    consentGroupDiagnostics: finalVisibleGroups.map((g) => {
      const resolved = g.checkedMemberFieldId !== null;
      let meta = groupMeta.get(g.groupId);
      if (!meta) {
        // Already resolved before this function ran (e.g. a default-checked radio) -- still
        // classified for diagnostics, but never acted on.
        const classificationResult = classifyRadioGroup({ questionText: g.questionText, memberLabels: g.memberLabels }, language);
        meta = {
          classification: classificationResult.classification,
          classificationEvidence: classificationResult.evidence,
          ...(resolved ? { selectionReason: "already selected on the page before resolution ran" } : { unresolvedReason: "never became visible during the resolution loop" }),
        };
      }
      return {
        groupId: g.groupId,
        questionText: g.questionText,
        requiredEvidence: g.requiredEvidence,
        resolved,
        selectedMemberFieldId: g.checkedMemberFieldId,
        classification: meta.classification,
        classificationEvidence: meta.classificationEvidence,
        ...(resolved ? { selectionReason: meta.selectionReason } : { unresolvedReason: meta.unresolvedReason }),
      };
    }),
    consentGroupsCompleted: completedGroupIds.size,
    conditionalConsentGroupsRevealed: conditionalRevealedCount,
    consentRescanCount: rescanCount,
    unresolvedRequiredConsentGroups: unresolvedRequired.map((g) => g.groupId),
  };
}

export const EMPTY_CONSENT_GROUP_RESULT: ConsentGroupResolutionResult = {
  consentGroupsDetected: 0,
  consentGroupsInitiallyVisible: 0,
  consentGroupDiagnostics: [],
  consentGroupsCompleted: 0,
  conditionalConsentGroupsRevealed: 0,
  consentRescanCount: 0,
  unresolvedRequiredConsentGroups: [],
};
