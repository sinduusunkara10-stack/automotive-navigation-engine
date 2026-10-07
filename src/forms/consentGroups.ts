import type { Locator, Page } from "playwright";
import { findNegativeOptionLabel } from "./fillPlan.js";
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
  }[];
  consentGroupsCompleted: number;
  conditionalConsentGroupsRevealed: number;
  consentRescanCount: number;
  unresolvedRequiredConsentGroups: string[];
}

const MAX_RESCANS = 5;

/**
 * Resolves every currently-visible radio group deterministically (the same generic negative-
 * option/opt-out vocabulary an unmapped Yes/No select already uses), then rescans for newly
 * revealed conditional groups until none remain or the bounded loop limit is reached. Resolving
 * a group that later turns out not to be required is harmless (it is the test-consent policy's
 * own deterministic default); the readiness gate, not this function, decides what blocks submit.
 */
export async function resolveConsentGroups(
  page: Page,
  form: Locator,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
): Promise<ConsentGroupResolutionResult> {
  const seenVisibleGroupIds = new Set<string>();
  const completedGroupIds = new Set<string>();
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

    const unresolved = visibleGroups.filter((g) => g.checkedMemberFieldId === null && !completedGroupIds.has(g.groupId));
    if (unresolved.length === 0) break;

    for (const group of unresolved) {
      const negativeLabel = findNegativeOptionLabel(group.memberLabels, language);
      const targetIndex = negativeLabel ? group.memberLabels.indexOf(negativeLabel) : group.memberFieldIds.length - 1;
      const targetFieldId = group.memberFieldIds[targetIndex];
      if (targetFieldId) {
        const field = await fieldByIndex(form, targetFieldId);
        await field.check().catch(() => {});
        completedGroupIds.add(group.groupId);
      }
    }
    await page.waitForTimeout(100);
  }

  const finalGroups = await discoverConsentGroups(form);
  const finalVisibleGroups = finalGroups.filter((g) => g.visible);
  const unresolvedRequired = finalVisibleGroups.filter((g) => g.checkedMemberFieldId === null && g.requiredEvidence !== "none");

  return {
    consentGroupsDetected: finalGroups.length,
    consentGroupsInitiallyVisible,
    consentGroupDiagnostics: finalVisibleGroups.map((g) => ({
      groupId: g.groupId,
      questionText: g.questionText,
      requiredEvidence: g.requiredEvidence,
      resolved: g.checkedMemberFieldId !== null,
      selectedMemberFieldId: g.checkedMemberFieldId,
    })),
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
