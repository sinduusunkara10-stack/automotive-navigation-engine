import type { Locator, Page } from "playwright";
import type { FormJourneyContext } from "./formRelevance.js";
import {
  classifyRadioGroup,
  resolveJourneyIntentOption,
  resolvePrivateCustomerOption,
  type ConsentPurpose,
  type RadioGroupClassification,
} from "./radioGroupClassifier.js";
import type { SupportedLanguage } from "./testData.js";
import { callInPageFunction } from "./inPageFunction.js";

/** Same attribute tagAndReadFields (fillForm.ts) writes on every input/select/textarea it tags. */
const FIELD_INDEX_ATTR = "data-nav-engine-field-index";
const CONSENT_LABEL_ATTR = "data-nav-engine-consent-label";

export type QuestionSource = "fieldset_legend" | "radiogroup_label" | "aria_reference" | "group_container_text" | "preceding_text" | "nearest_heading" | "none";

export interface ConsentGroupMember {
  fieldId: string;
  /** The option's own visible label (internal only -- never emitted in diagnostics). */
  label: string;
  /** The option's own value attribute (internal only -- polarity evidence, never emitted). */
  value: string;
  /** The radio itself, or its associated label for a custom-styled control, is rendered. */
  visible: boolean;
  /** The radio input itself is rendered (false for a custom control whose input is hidden behind its label). */
  inputVisible: boolean;
  checked: boolean;
}

export interface ConsentGroupDescriptor {
  /** The shared `name` attribute of the group's radio inputs (its stable identity across rescans). */
  groupId: string;
  members: ConsentGroupMember[];
  memberFieldIds: string[];
  memberLabels: string[];
  visible: boolean;
  requiredEvidence: "attribute" | "marker" | "none";
  /** Internal only, never emitted: the associated question text, used for classification. */
  questionText: string;
  questionSource: QuestionSource;
  checkedMemberFieldId: string | null;
}

const DISCOVER_SOURCE = `(formEl, attrs) => {
  const attr = attrs.fieldAttr;
  const norm = (t) => (t || "").replace(/\\s+/g, " ").trim();
  const rendered = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const textOfIds = (ids) =>
    norm((ids || "").split(/\\s+/).filter(Boolean).map((id) => { const el = document.getElementById(id); return el ? el.textContent : ""; }).join(" "));
  const radios = Array.from(formEl.querySelectorAll('input[type="radio"]'));
  const groups = new Map();
  radios.forEach((radio) => {
    const name = radio.getAttribute("name");
    if (!name) return;
    const list = groups.get(name) || [];
    list.push(radio);
    groups.set(name, list);
  });
  const results = [];
  groups.forEach((radiosInGroup, groupId) => {
    const members = radiosInGroup.map((m) => {
      const id = m.getAttribute("id");
      const byFor = id ? formEl.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
      const labelEl = byFor || m.closest("label");
      const fieldId = m.getAttribute(attr) || "";
      if (labelEl && fieldId) labelEl.setAttribute(attrs.labelAttr, fieldId);
      const label = norm((labelEl && labelEl.textContent) || m.getAttribute("aria-label") || textOfIds(m.getAttribute("aria-labelledby")) || "");
      const inputVisible = rendered(m);
      return { fieldId, label, value: m.value || "", inputVisible, visible: inputVisible || rendered(labelEl), checked: m.checked, el: m };
    });
    const optionTexts = new Set(members.map((m) => m.label.toLowerCase()).filter(Boolean));
    const stripOptions = (text) => {
      let out = " " + norm(text) + " ";
      members.forEach((m) => { if (m.label) out = out.split(m.label).join(" "); });
      return norm(out);
    };
    const usable = (text) => text.length > 10 && !optionTexts.has(text.toLowerCase());
    const anchor = (members.find((m) => m.visible) || members[0]).el;
    let questionText = "";
    let questionSource = "none";
    const fieldset = anchor.closest("fieldset");
    const legend = fieldset && formEl.contains(fieldset) ? fieldset.querySelector("legend") : null;
    if (legend && usable(norm(legend.textContent))) { questionText = norm(legend.textContent); questionSource = "fieldset_legend"; }
    if (!questionText) {
      const rg = anchor.closest('[role="radiogroup"]');
      if (rg) {
        const t = norm(textOfIds(rg.getAttribute("aria-labelledby")) || rg.getAttribute("aria-label") || "");
        if (usable(t)) { questionText = t; questionSource = "radiogroup_label"; }
      }
    }
    if (!questionText) {
      for (const m of members) {
        const t = stripOptions(textOfIds(m.el.getAttribute("aria-describedby")) + " " + textOfIds(m.el.getAttribute("aria-labelledby")));
        if (usable(t)) { questionText = t; questionSource = "aria_reference"; break; }
      }
    }
    if (!questionText) {
      let container = anchor.parentElement;
      while (container && container !== formEl && !members.every((m) => container.contains(m.el))) container = container.parentElement;
      if (container && container !== formEl && Array.from(container.querySelectorAll('input[type="radio"]')).every((r) => r.getAttribute("name") === groupId)) {
        const t = stripOptions(container.textContent);
        if (usable(t)) { questionText = t; questionSource = "group_container_text"; }
      }
    }
    if (!questionText) {
      let node = anchor;
      let steps = 0;
      while (node && node !== formEl && steps < 8 && !questionText) {
        let sibling = node.previousElementSibling;
        let siblingSteps = 0;
        while (sibling && siblingSteps < 6 && !questionText) {
          const t = norm(sibling.textContent);
          if (usable(t) && sibling.querySelector('input[type="radio"]') === null) { questionText = t; questionSource = "preceding_text"; }
          sibling = sibling.previousElementSibling;
          siblingSteps += 1;
        }
        node = node.parentElement;
        steps += 1;
      }
    }
    if (!questionText) {
      const headings = Array.from(formEl.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')).filter(
        (h) => h.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
      const nearest = headings[headings.length - 1];
      if (nearest && usable(norm(nearest.textContent))) { questionText = norm(nearest.textContent); questionSource = "nearest_heading"; }
    }
    const hasAttributeRequired = radiosInGroup.some((m) => m.hasAttribute("required") || m.getAttribute("aria-required") === "true") ||
      Boolean(anchor.closest('[role="radiogroup"][aria-required="true"]'));
    const requiredEvidence = hasAttributeRequired ? "attribute" : /\\*\\s*$/.test(questionText) ? "marker" : "none";
    const checked = members.find((m) => m.checked);
    results.push({
      groupId,
      members: members.map((m) => ({ fieldId: m.fieldId, label: m.label, value: m.value, visible: m.visible, inputVisible: m.inputVisible, checked: m.checked })),
      memberFieldIds: members.map((m) => m.fieldId),
      memberLabels: members.map((m) => m.label),
      visible: members.some((m) => m.visible),
      requiredEvidence,
      questionText,
      questionSource,
      checkedMemberFieldId: checked ? checked.fieldId || null : null,
    });
  });
  return results;
}`;

/**
 * Generic, language-agnostic radio-group discovery. A consent question is very often expressed
 * as two (or more) `<input type="radio">` options whose OWN labels are only "Yes"/"No"-shaped --
 * the actual question lives elsewhere, so the field-level keyword matcher can never identify
 * these. Groups by the native `name`, then associates the question through fieldset/legend,
 * role="radiogroup" labelling, aria references, the group's own exclusive container, preceding
 * text, and finally the nearest preceding heading. A member counts as visible when the radio or
 * its own label is rendered, so a custom-styled control is not lost and a hidden responsive
 * duplicate is.
 */
export async function discoverConsentGroups(form: Locator): Promise<ConsentGroupDescriptor[]> {
  return callInPageFunction<ConsentGroupDescriptor[]>(form, "__navEngineDiscoverConsentGroups", DISCOVER_SOURCE, {
    fieldAttr: FIELD_INDEX_ATTR,
    labelAttr: CONSENT_LABEL_ATTR,
  }).catch(() => []);
}

export type OptionPolarity = "positive" | "negative" | "unknown";

const NEGATIVE_LABEL_PHRASES = [
  "no", "non", "nein", "nee", "nie", "nao", "do not", "don't", "i decline", "decline", "refuse", "je refuse", "ne souhaite pas", "n'accepte pas", "ne pas",
  "ich stimme nicht", "nicht einverstanden", "niet akkoord", "non accetto", "non acconsento", "no acepto", "no deseo", "nie zgadzam", "nao aceito", "nao desejo",
];
const POSITIVE_LABEL_PHRASES = [
  "yes", "oui", "ja", "si", "tak", "sim", "i agree", "agree", "i accept", "accept", "j'accepte", "accepte", "je souhaite", "ich stimme zu", "einverstanden",
  "akkoord", "accetto", "acconsento", "acepto", "zgadzam", "aceito", "concordo",
];
const NEGATIVE_VALUES = new Set(["0", "false", "no", "n", "non", "nein", "nee", "nie", "nao", "off", "optout", "opt-out", "decline", "declined", "refuse", "refused", "deny", "denied"]);
const POSITIVE_VALUES = new Set(["1", "true", "yes", "y", "oui", "ja", "si", "tak", "sim", "on", "optin", "opt-in", "accept", "accepted", "agree", "agreed"]);

function foldText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => {
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z'])${escaped}([^a-z]|$)`).test(text);
  });
}

/**
 * Whether an option declines or accepts, from its own label (any supported language, whole-word)
 * and its value attribute. Negative wording is checked first: most negative phrases contain the
 * positive verb ("nie zgadzam", "n'accepte pas").
 */
export function optionPolarity(label: string, value: string): OptionPolarity {
  const text = foldText(label);
  const val = foldText(value);
  if (text && containsPhrase(text, NEGATIVE_LABEL_PHRASES)) return "negative";
  if (text && containsPhrase(text, POSITIVE_LABEL_PHRASES)) return "positive";
  if (NEGATIVE_VALUES.has(val)) return "negative";
  if (POSITIVE_VALUES.has(val)) return "positive";
  return "unknown";
}

/** Picks the option of the wanted polarity among visible members; with exactly two visible options and the other one recognised, the remaining one is taken. */
function pickByPolarity(members: ConsentGroupMember[], wanted: "positive" | "negative"): ConsentGroupMember | undefined {
  const visible = members.filter((m) => m.visible);
  const direct = visible.filter((m) => optionPolarity(m.label, m.value) === wanted);
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) {
    // The same option rendered twice under one name (responsive copies): either is the same answer.
    const labels = new Set(direct.map((m) => foldText(m.label)));
    return labels.size === 1 ? direct[0] : undefined;
  }
  if (visible.length === 2) {
    const opposite = wanted === "positive" ? "negative" : "positive";
    const other = visible.find((m) => optionPolarity(m.label, m.value) === opposite);
    if (other) return visible.find((m) => m !== other);
  }
  return undefined;
}

export type ConsentInteraction =
  | "selected_decline"
  | "flipped_preselected_accept_to_decline"
  | "committed_preselected_decline"
  | "accepted_required"
  | "kept_preselected_accept_required"
  | "selected_by_policy"
  | "left_untouched";

export interface ConsentGroupDiagnostic {
  groupId: string;
  /** Consent purpose (see radioGroupClassifier.ts's ConsentPurpose). */
  purpose: ConsentPurpose;
  /** Which dictionary term or name token decided `purpose` -- never page text. */
  purposeEvidence: string;
  questionFound: boolean;
  questionSource: QuestionSource;
  requiredEvidence: "attribute" | "marker" | "none";
  optionCount: number;
  visibleOptionCount: number;
  /** Members neither rendered nor visibly labelled that repeat a visible option -- e.g. a responsive copy. Never interacted with. */
  hiddenDuplicateCount: number;
  checkedBefore: OptionPolarity | "none";
  checkedAfter: OptionPolarity | "none";
  interaction: ConsentInteraction;
  /** True when the intended option read back as checked after the interaction; null when none was attempted. */
  checkedStateVerified: boolean | null;
  resolved: boolean;
  selectedMemberFieldId: string | null;
  classification: RadioGroupClassification;
  classificationEvidence: string;
  selectionReason?: string;
  unresolvedReason?: string;
}

export interface ConsentGroupResolutionResult {
  consentGroupsDetected: number;
  consentGroupsInitiallyVisible: number;
  consentGroupDiagnostics: ConsentGroupDiagnostic[];
  consentGroupsCompleted: number;
  conditionalConsentGroupsRevealed: number;
  consentRescanCount: number;
  unresolvedRequiredConsentGroups: string[];
}

const MAX_RESCANS = 5;

const OPTIONAL_COMMERCIAL_PURPOSES = new Set<ConsentPurpose>(["optional_marketing", "optional_profiling", "optional_third_party"]);
const REQUIRED_PURPOSES = new Set<ConsentPurpose>(["required_privacy_processing", "terms_and_conditions"]);

interface GroupOutcome {
  purpose: ConsentPurpose;
  purposeEvidence: string;
  classification: RadioGroupClassification;
  classificationEvidence: string;
  checkedBefore: OptionPolarity | "none";
  interaction: ConsentInteraction;
  checkedStateVerified: boolean | null;
  completed: boolean;
  selectionReason?: string;
  unresolvedReason?: string;
}

function checkedPolarity(group: ConsentGroupDescriptor): OptionPolarity | "none" {
  const checked = group.members.find((m) => m.checked);
  return checked ? optionPolarity(checked.label, checked.value) : "none";
}

async function activateMember(form: Locator, fieldByIndex: (form: Locator, index: string) => Promise<Locator>, member: ConsentGroupMember): Promise<boolean> {
  const input = await fieldByIndex(form, member.fieldId);
  const label = form.locator(`[${CONSENT_LABEL_ATTR}="${member.fieldId}"]`).first();
  // A real click even on an already-checked option: some widgets record the answer only from their
  // own click handler, so a pre-rendered default is not necessarily a committed one.
  if (member.inputVisible) await input.click({ timeout: 3_000 }).catch(() => {});
  else await label.click({ timeout: 3_000 }).catch(() => {});
  if (await input.isChecked().catch(() => false)) return true;
  await input.check({ force: true, timeout: 3_000 }).catch(() => {});
  return input.isChecked().catch(() => false);
}

/**
 * Resolves every visible radio group by purpose. Optional commercial purposes (marketing,
 * profiling, third-party sharing) always end on the decline option -- a pre-selected accept is
 * flipped and a pre-selected decline is explicitly committed; required processing/terms are
 * accepted only when the form marks them required; customer qualification and journey intent keep
 * their fixed policies; ambiguous groups are never touched. Every interaction is read back.
 * Rescans after each pass so a group revealed by an earlier answer is handled too.
 */
export async function resolveConsentGroups(
  page: Page,
  form: Locator,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  journeyContext: FormJourneyContext = {},
): Promise<ConsentGroupResolutionResult> {
  const seenVisibleGroupIds = new Set<string>();
  const outcomes = new Map<string, GroupOutcome>();
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

    const pending = visibleGroups.filter((g) => !outcomes.has(g.groupId));
    if (pending.length === 0) break;

    for (const group of pending) {
      outcomes.set(group.groupId, await resolveOneGroup(form, group, language, fieldByIndex, journeyContext));
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
      const visibleMembers = g.members.filter((m) => m.visible);
      const visibleLabels = new Set(visibleMembers.map((m) => foldText(m.label)));
      const outcome = outcomes.get(g.groupId) ?? lateGroupOutcome(g, language);
      return {
        groupId: g.groupId,
        purpose: outcome.purpose,
        purposeEvidence: outcome.purposeEvidence,
        questionFound: g.questionSource !== "none",
        questionSource: g.questionSource,
        requiredEvidence: g.requiredEvidence,
        optionCount: g.members.length,
        visibleOptionCount: visibleMembers.length,
        hiddenDuplicateCount: g.members.filter((m) => !m.visible && visibleLabels.has(foldText(m.label))).length,
        checkedBefore: outcome.checkedBefore,
        checkedAfter: checkedPolarity(g),
        interaction: outcome.interaction,
        checkedStateVerified: outcome.checkedStateVerified,
        resolved,
        selectedMemberFieldId: g.checkedMemberFieldId,
        classification: outcome.classification,
        classificationEvidence: outcome.classificationEvidence,
        ...(resolved
          ? { selectionReason: outcome.selectionReason ?? "already selected on the page; left as is" }
          : { unresolvedReason: outcome.unresolvedReason ?? "left unanswered" }),
      };
    }),
    consentGroupsCompleted: [...outcomes.values()].filter((o) => o.completed && o.interaction !== "left_untouched").length,
    conditionalConsentGroupsRevealed: conditionalRevealedCount,
    consentRescanCount: rescanCount,
    unresolvedRequiredConsentGroups: unresolvedRequired.map((g) => g.groupId),
  };
}

function classifyGroup(group: ConsentGroupDescriptor, language: SupportedLanguage): ReturnType<typeof classifyRadioGroup> {
  return classifyRadioGroup(
    { questionText: group.questionText, memberLabels: group.members.filter((m) => m.visible).map((m) => m.label), groupName: group.groupId },
    language,
  );
}

function lateGroupOutcome(group: ConsentGroupDescriptor, language: SupportedLanguage): GroupOutcome {
  const classified = classifyGroup(group, language);
  return {
    purpose: classified.purpose,
    purposeEvidence: classified.evidence,
    classification: classified.classification,
    classificationEvidence: classified.evidence,
    checkedBefore: checkedPolarity(group),
    interaction: "left_untouched",
    checkedStateVerified: null,
    completed: false,
    unresolvedReason: "became visible only after the bounded rescan loop ended",
  };
}

async function resolveOneGroup(
  form: Locator,
  group: ConsentGroupDescriptor,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  journeyContext: FormJourneyContext,
): Promise<GroupOutcome> {
  const visibleMembers = group.members.filter((m) => m.visible);
  const classified = classifyGroup(group, language);
  const base = {
    purpose: classified.purpose,
    purposeEvidence: classified.evidence,
    classification: classified.classification,
    classificationEvidence: classified.evidence,
    checkedBefore: checkedPolarity(group),
  };
  const untouched = (reason: string, completed = false): GroupOutcome => ({
    ...base,
    interaction: "left_untouched",
    checkedStateVerified: null,
    completed,
    ...(completed ? { selectionReason: reason } : { unresolvedReason: reason }),
  });
  const act = async (target: ConsentGroupMember, interaction: ConsentInteraction, reason: string): Promise<GroupOutcome> => {
    const verified = await activateMember(form, fieldByIndex, target);
    return verified
      ? { ...base, interaction, checkedStateVerified: true, completed: true, selectionReason: reason }
      : { ...base, interaction, checkedStateVerified: false, completed: false, unresolvedReason: "the intended option did not read back as checked after the interaction" };
  };

  if (OPTIONAL_COMMERCIAL_PURPOSES.has(classified.purpose)) {
    const decline = pickByPolarity(group.members, "negative");
    if (!decline) return untouched("optional commercial purpose, but no visible decline option could be recognised; left untouched rather than guessed");
    const interaction: ConsentInteraction =
      base.checkedBefore === "negative" ? "committed_preselected_decline" : base.checkedBefore === "none" ? "selected_decline" : "flipped_preselected_accept_to_decline";
    return act(decline, interaction, `${classified.purpose}: declined`);
  }

  if (REQUIRED_PURPOSES.has(classified.purpose)) {
    if (group.requiredEvidence === "none") return untouched("required-processing/terms acknowledgement not marked required for this submission; left untouched");
    if (base.checkedBefore === "positive") {
      return { ...base, interaction: "kept_preselected_accept_required", checkedStateVerified: null, completed: true, selectionReason: "already accepted; marked required for this submission" };
    }
    const accept = pickByPolarity(group.members, "positive");
    return accept
      ? act(accept, "accepted_required", `${classified.purpose} marked required (${group.requiredEvidence}): accepted`)
      : untouched("required acknowledgement, but no visible accept option could be recognised; left untouched rather than guessed");
  }

  if (classified.purpose === "journey_intent" || classified.purpose === "customer_qualification") {
    if (group.checkedMemberFieldId !== null) return untouched("already answered on the page before resolution ran", true);
    const labels = visibleMembers.map((m) => m.label);
    const resolution = classified.purpose === "journey_intent" ? resolveJourneyIntentOption(labels, journeyContext, language) : resolvePrivateCustomerOption(labels, language);
    const target = resolution ? visibleMembers[resolution.index] : undefined;
    return target && resolution
      ? act(target, "selected_by_policy", resolution.reason)
      : untouched(`classified as ${classified.classification} but no option could be confidently resolved; left unresolved rather than guessed`);
  }

  return untouched("classification was ambiguous; left untouched rather than guessed", group.checkedMemberFieldId !== null);
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
