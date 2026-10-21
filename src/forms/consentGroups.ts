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
const CONSENT_WRAPPER_ATTR = "data-nav-engine-consent-wrapper";

export type QuestionSource = "fieldset_legend" | "radiogroup_label" | "aria_reference" | "group_container_text" | "preceding_text" | "nearest_heading" | "none";

export interface ConsentSurfaceState {
  found: boolean;
  /** Rendered: non-zero box, not display:none / visibility:hidden, not inside a [hidden] or [inert] subtree. */
  visible: boolean;
  /** Intersects the viewport (measured after the group was scrolled into view when needed). */
  onScreen: boolean;
  /** Visually clipped away (a 1-2 px box, clip: rect(0 0 0 0) or clip-path: inset(50%)). */
  clipped: boolean;
  /** A hit-test at the centre of its on-screen part lands on this surface itself, not on something covering it. */
  hitTestable: boolean;
}

export type ConsentActivationSurface = "native_input" | "label" | "wrapper";

export interface ConsentGroupMember {
  fieldId: string;
  /** The option's own visible label (internal only -- never emitted in diagnostics). */
  label: string;
  /** The option's own value attribute (internal only -- polarity evidence, never emitted). */
  value: string;
  /** At least one of the option's surfaces (input, associated label, own wrapper) is rendered. */
  visible: boolean;
  /** At least one exact activation surface is rendered, enabled, on screen, unclipped and hit-testable. */
  actionable: boolean;
  /** The surface that made the option actionable, in ladder order; null when none did. */
  activationSurface: ConsentActivationSurface | null;
  disabled: boolean;
  input: ConsentSurfaceState;
  labelSurface: ConsentSurfaceState;
  wrapperSurface: ConsentSurfaceState;
  /** A non-actionable copy of an option another member of the same group renders actionably (a responsive duplicate). Never interacted with. */
  hiddenDuplicate: boolean;
  checked: boolean;
}

export type ConsentRejectionStage = "member_visibility" | "label_wrapper_lookup" | "actionable_filter" | "responsive_dedupe";
export type ConsentRejectionReason =
  | "not_rendered"
  | "native_input_unusable_and_no_label_or_wrapper"
  | "all_options_disabled"
  | "visually_clipped"
  | "outside_viewport_after_scroll"
  | "obscured_by_other_element"
  | "hidden_responsive_duplicate_of_actionable_group";

export interface ConsentGroupDescriptor {
  /** The shared `name` attribute of the group's radio inputs (its stable identity across rescans). */
  groupId: string;
  members: ConsentGroupMember[];
  memberFieldIds: string[];
  memberLabels: string[];
  /** Some surface of some member is rendered. */
  visible: boolean;
  /** Some member is actionable; only actionable groups are ever interacted with. */
  actionable: boolean;
  /** The group was scrolled into view during this scan because none of its surfaces was on screen. */
  scrolledIntoView: boolean;
  /** Why the group is not actionable; null when it is. */
  rejection: { stage: ConsentRejectionStage; reason: ConsentRejectionReason } | null;
  requiredEvidence: "attribute" | "marker" | "none";
  /** Internal only, never emitted: the associated question text, used for classification. */
  questionText: string;
  questionSource: QuestionSource;
  checkedMemberFieldId: string | null;
}

const DISCOVER_SOURCE = `(formEl, attrs) => {
  const attr = attrs.fieldAttr;
  const norm = (t) => (t || "").replace(/\\s+/g, " ").trim();
  formEl.querySelectorAll("[" + attrs.labelAttr + "]").forEach((e) => e.removeAttribute(attrs.labelAttr));
  formEl.querySelectorAll("[" + attrs.wrapperAttr + "]").forEach((e) => e.removeAttribute(attrs.wrapperAttr));
  const rendered = (el) => {
    if (!el || !el.isConnected || el.closest("[hidden], [inert]")) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const isClipped = (el) => {
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return (r.width <= 2 && r.height <= 2) || /rect\\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\\)/.test(st.clip || "") || /inset\\(50%/.test(st.clipPath || "");
  };
  const NONE = { found: false, visible: false, onScreen: false, clipped: false, hitTestable: false };
  const surfaceState = (el, owners) => {
    if (!el) return NONE;
    const visible = rendered(el);
    if (!visible) return { found: true, visible: false, onScreen: false, clipped: false, hitTestable: false };
    const r = el.getBoundingClientRect();
    const clipped = isClipped(el);
    const left = Math.max(r.left, 0);
    const right = Math.min(r.right, window.innerWidth);
    const top = Math.max(r.top, 0);
    const bottom = Math.min(r.bottom, window.innerHeight);
    const onScreen = right - left >= 1 && bottom - top >= 1;
    let hitTestable = false;
    if (onScreen && !clipped) {
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      hitTestable = Boolean(hit) && owners.some((o) => o === hit || o.contains(hit));
    }
    return { found: true, visible: true, onScreen, clipped, hitTestable };
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

  const structureOf = (m) => {
    // input.labels is the browser's own association: a label whose for= resolves to a different
    // element with the same id (a responsive copy) is not this input's label.
    const labels = Array.from(m.labels || []);
    const exclusive = (el) => Array.from(el.querySelectorAll('input[type="radio"]')).every((r) => r === m);
    const usableWrapper = (el) => Boolean(el) && el !== formEl && formEl.contains(el) && exclusive(el);
    const wrapperFor = (labelEl) => {
      let wrapper = labelEl ? (labelEl.contains(m) ? labelEl : labelEl.parentElement) : m.parentElement;
      while (wrapper && wrapper !== formEl && !wrapper.contains(m)) wrapper = wrapper.parentElement;
      if (!usableWrapper(wrapper)) wrapper = null;
      while (wrapper && (wrapper === labelEl || !rendered(wrapper)) && usableWrapper(wrapper.parentElement)) wrapper = wrapper.parentElement;
      return wrapper === labelEl ? null : wrapper;
    };
    return { labels, wrapperFor };
  };

  // An input under a display:none ancestor belongs to an inactive copy (another responsive layout):
  // none of its surfaces counts, even a label rendered elsewhere.
  const inactiveCopy = (m) => {
    for (let a = m.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (window.getComputedStyle(a).display === "none") return true;
    }
    return false;
  };
  const assessMember = (m) => {
    const { labels, wrapperFor } = structureOf(m);
    const labelStates = labels.map((l) => ({ el: l, state: surfaceState(l, [l]) }));
    const best = labelStates.find((l) => l.state.hitTestable) || labelStates.find((l) => l.state.visible) || labelStates[0] || null;
    const labelEl = best ? best.el : null;
    const wrapper = wrapperFor(labelEl);
    const disabled = m.disabled || Boolean(m.closest("fieldset[disabled]")) || m.getAttribute("aria-disabled") === "true";
    const input = surfaceState(m, [m, ...labels]);
    const labelSurface = best ? best.state : NONE;
    const wrapperSurface = surfaceState(wrapper, wrapper ? [wrapper] : []);
    const inactive = inactiveCopy(m);
    const activationSurface = disabled || inactive ? null : input.hitTestable ? "native_input" : labelSurface.hitTestable ? "label" : wrapperSurface.hitTestable ? "wrapper" : null;
    return { labelEl, wrapper, disabled, inactive, input, labelSurface, wrapperSurface, activationSurface };
  };

  const results = [];
  groups.forEach((radiosInGroup, groupId) => {
    let assessed = radiosInGroup.map((m) => ({ el: m, ...assessMember(m) }));
    let scrolledIntoView = false;
    if (attrs.scroll && !assessed.some((a) => a.activationSurface)) {
      // Outside the viewport is never treated as hidden: bring the group's own rendered label,
      // wrapper or container into view and measure again. An off-document native input is never
      // the scroll target -- it is the visually-hidden half of a custom control.
      const container = radiosInGroup[0].closest('fieldset, [role="radiogroup"]');
      const anchor =
        assessed.map((a) => a.labelEl).find((l) => l && rendered(l) && !isClipped(l)) ||
        assessed.map((a) => a.wrapper).find((w) => w && rendered(w) && !isClipped(w)) ||
        (container && formEl.contains(container) && rendered(container) ? container : null);
      if (anchor) {
        anchor.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        scrolledIntoView = true;
        assessed = radiosInGroup.map((m) => ({ el: m, ...assessMember(m) }));
      }
    }
    const members = assessed.map((a) => {
      const m = a.el;
      const fieldId = m.getAttribute(attr) || "";
      if (a.labelEl && fieldId) a.labelEl.setAttribute(attrs.labelAttr, fieldId);
      if (a.wrapper && fieldId) a.wrapper.setAttribute(attrs.wrapperAttr, fieldId);
      const label = norm((a.labelEl && a.labelEl.textContent) || m.getAttribute("aria-label") || textOfIds(m.getAttribute("aria-labelledby")) || (a.wrapper && a.wrapper.textContent) || "");
      return {
        fieldId,
        label,
        value: m.value || "",
        visible: !a.inactive && (a.input.visible || a.labelSurface.visible || a.wrapperSurface.visible),
        actionable: a.activationSurface !== null,
        activationSurface: a.activationSurface,
        disabled: a.disabled,
        input: a.input,
        labelSurface: a.labelSurface,
        wrapperSurface: a.wrapperSurface,
        hiddenDuplicate: false,
        checked: m.checked,
        el: m,
        hasLabelOrWrapper: Boolean(a.labelEl || a.wrapper),
      };
    });
    const optionKey = (m) => (m.value + "|" + m.label).toLowerCase();
    members.forEach((m) => {
      m.hiddenDuplicate = !m.actionable && members.some((o) => o !== m && o.actionable && optionKey(o) === optionKey(m));
    });
    const optionTexts = new Set(members.map((m) => m.label.toLowerCase()).filter(Boolean));
    const stripOptions = (text) => {
      let out = " " + norm(text) + " ";
      members.forEach((m) => { if (m.label) out = out.split(m.label).join(" "); });
      return norm(out);
    };
    const usable = (text) => text.length > 10 && !optionTexts.has(text.toLowerCase());
    const anchor = (members.find((m) => m.actionable) || members.find((m) => m.visible) || members[0]).el;
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
    const actionable = members.some((m) => m.actionable);
    let rejection = null;
    if (!actionable) {
      const usableSurfaces = (m) => [m.input, m.labelSurface, m.wrapperSurface].filter((s) => s.visible);
      if (!members.some((m) => m.visible)) rejection = { stage: "member_visibility", reason: "not_rendered" };
      else if (members.every((m) => m.disabled)) rejection = { stage: "actionable_filter", reason: "all_options_disabled" };
      else if (members.every((m) => !m.hasLabelOrWrapper && !m.input.hitTestable)) rejection = { stage: "label_wrapper_lookup", reason: "native_input_unusable_and_no_label_or_wrapper" };
      else if (members.every((m) => usableSurfaces(m).every((s) => s.clipped))) rejection = { stage: "actionable_filter", reason: "visually_clipped" };
      else if (members.every((m) => usableSurfaces(m).every((s) => s.clipped || !s.onScreen))) rejection = { stage: "actionable_filter", reason: "outside_viewport_after_scroll" };
      else rejection = { stage: "actionable_filter", reason: "obscured_by_other_element" };
    }
    results.push({
      groupId,
      members: members.map((m) => ({
        fieldId: m.fieldId, label: m.label, value: m.value, visible: m.visible, actionable: m.actionable, activationSurface: m.activationSurface,
        disabled: m.disabled, input: m.input, labelSurface: m.labelSurface, wrapperSurface: m.wrapperSurface, hiddenDuplicate: m.hiddenDuplicate, checked: m.checked,
      })),
      memberFieldIds: members.map((m) => m.fieldId),
      memberLabels: members.map((m) => m.label),
      visible: members.some((m) => m.visible),
      actionable,
      scrolledIntoView,
      rejection,
      requiredEvidence,
      questionText,
      questionSource,
      checkedMemberFieldId: checked ? checked.fieldId || null : null,
      duplicateKey: norm(questionText).toLowerCase() + "||" + members.map((m) => m.label.toLowerCase()).sort().join("|"),
    });
  });
  // A whole group that renders nothing while another group asks the same question with the same
  // options actionably is an inactive responsive copy, not a second question.
  results.forEach((g) => {
    if (g.actionable || !g.rejection || g.rejection.reason !== "not_rendered" || !g.questionText) return;
    if (results.some((o) => o !== g && o.actionable && o.duplicateKey === g.duplicateKey)) {
      g.rejection = { stage: "responsive_dedupe", reason: "hidden_responsive_duplicate_of_actionable_group" };
    }
  });
  results.forEach((g) => { delete g.duplicateKey; });
  return results;
}`;

/**
 * Generic, language-agnostic radio-group discovery. A consent question is very often expressed
 * as two (or more) `<input type="radio">` options whose OWN labels are only "Yes"/"No"-shaped --
 * the actual question lives elsewhere, so the field-level keyword matcher can never identify
 * these. Groups by the native `name`, then associates the question through fieldset/legend,
 * role="radiogroup" labelling, aria references, the group's own exclusive container, preceding
 * text, and finally the nearest preceding heading.
 *
 * One logical option is its native input plus the browser-associated label and its own exclusive
 * wrapper. The option is actionable when one of those surfaces is rendered, enabled, on screen,
 * unclipped and wins a hit-test -- so a custom control whose native input sits off-screen is
 * actionable through its label, while a hidden responsive copy never is. With `scroll`, a group
 * none of whose surfaces is on screen is scrolled into view and measured again before it can be
 * rejected; every rejected group carries the stage and reason.
 */
export async function discoverConsentGroups(form: Locator, options: { scroll?: boolean } = {}): Promise<ConsentGroupDescriptor[]> {
  return callInPageFunction<ConsentGroupDescriptor[]>(form, "__navEngineDiscoverConsentGroups", DISCOVER_SOURCE, {
    fieldAttr: FIELD_INDEX_ATTR,
    labelAttr: CONSENT_LABEL_ATTR,
    wrapperAttr: CONSENT_WRAPPER_ATTR,
    scroll: options.scroll === true,
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

/** Picks the option of the wanted polarity among actionable members; with exactly two actionable options and the other one recognised, the remaining one is taken. */
function pickByPolarity(members: ConsentGroupMember[], wanted: "positive" | "negative"): ConsentGroupMember | undefined {
  const visible = members.filter((m) => m.actionable);
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
  /** Non-actionable members that repeat an actionable option -- e.g. a responsive copy. Never interacted with. */
  hiddenDuplicateCount: number;
  /** The group had to be scrolled into view before it could be assessed. */
  scrolledIntoView: boolean;
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
  /** How the intended option was activated and read back; present whenever an interaction was attempted. */
  activation?: ConsentActivationDiagnostic;
  /** Set when an optional commercial purpose's decline could not be read back as selected. */
  outcomeTag?: "consent_decline_not_committed";
}

export interface ConsentSurfaceSummary {
  found: boolean;
  visible: boolean;
  onScreen: boolean;
  clipped: boolean;
}

/**
 * Why a detected radio group was never interacted with. Every detected group ends up either in
 * consentGroupDiagnostics or here -- none disappears. Surface flags hold when they hold for at
 * least one member. Never a label, value or question text.
 */
export interface ConsentGroupRejection {
  groupId: string;
  purpose: ConsentPurpose;
  purposeEvidence: string;
  memberCount: number;
  nativeInput: ConsentSurfaceSummary;
  label: ConsentSurfaceSummary;
  wrapper: ConsentSurfaceSummary;
  scrolledIntoView: boolean;
  hiddenResponsiveDuplicateDetected: boolean;
  actionableMemberCount: number;
  rejectionStage: ConsentRejectionStage;
  rejectionReason: ConsentRejectionReason;
}

export interface ConsentGroupResolutionResult {
  consentGroupsDetected: number;
  /** Groups actionable on the first scan (the name predates actionability; kept for compatibility). */
  consentGroupsInitiallyVisible: number;
  /** Detected groups that were actionable at some scan, each with a consentGroupDiagnostics entry. */
  consentGroupsActionable: number;
  /** Detected groups never actionable, each with a consentGroupRejections entry. */
  consentGroupsDiscoveredNonActionable: number;
  /** Actionable groups an activation was attempted on. */
  consentGroupsInteracted: number;
  /** Actionable groups whose intended option read back as selected. */
  consentGroupsCommitted: number;
  consentGroupDiagnostics: ConsentGroupDiagnostic[];
  consentGroupRejections: ConsentGroupRejection[];
  consentGroupsCompleted: number;
  conditionalConsentGroupsRevealed: number;
  consentRescanCount: number;
  unresolvedRequiredConsentGroups: string[];
  /** Optional commercial groups (actionable or not) that did not end on a decline. */
  unresolvedOptionalConsentGroups: string[];
  /** Optional commercial groups whose decline was attempted but never read back as selected. */
  optionalDeclineNotCommittedGroups: string[];
}

const MAX_RESCANS = 5;
const RESCAN_SETTLE_MS = 100;
// A group rendered late (after the dealer selection, a layout change or a lazy reveal) gets a few
// bounded rescans before it is reported as non-actionable.
const NON_ACTIONABLE_RESCAN_WAIT_MS = 400;

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
  activation?: ConsentActivationDiagnostic;
  outcomeTag?: "consent_decline_not_committed";
}

function checkedPolarity(group: ConsentGroupDescriptor): OptionPolarity | "none" {
  const checked = group.members.find((m) => m.checked);
  return checked ? optionPolarity(checked.label, checked.value) : "none";
}

export type ConsentActivationElement = "native_input" | "label" | "wrapper" | "keyboard" | "programmatic";
export type ConsentActivationMethod = "pointer_click" | "focus_and_space" | "dispatched_click_input_change";
export type ConsentVerificationMethod =
  | "native_checked"
  | "radio_name_selected_value"
  | "checked_attribute"
  | "aria_checked"
  | "selected_class"
  | "framework_state";
export type ConsentVerificationResult = "verified" | "not_committed" | "contradicted";
export type ConsentIntendedAnswer = "decline" | "accept" | "policy_option";

export interface ConsentActivationDiagnostic {
  intendedAnswer: ConsentIntendedAnswer;
  /** The surface discovery found actionable for this option (null: only keyboard/programmatic routes remained). */
  actionableSurface: ConsentActivationSurface | null;
  /** Every activation tried, in order, until the intended option read back as selected. */
  attempts: { clickedElementType: ConsentActivationElement; activationMethod: ConsentActivationMethod; verificationResult: ConsentVerificationResult }[];
  /** The last activation tried; null when no activation route was available at all. */
  clickedElementType: ConsentActivationElement | null;
  activationMethod: ConsentActivationMethod | null;
  intendedOptionCheckedBefore: boolean;
  intendedOptionCheckedAfter: boolean;
  /** Which independent state signals read the intended option back as selected. */
  verificationMethods: ConsentVerificationMethod[];
  /** Whether a hidden input inside the group's own container changed value -- recorded only, never a value. Null when the container holds no hidden input. */
  hiddenConsentFieldChanged: boolean | null;
  verificationResult: ConsentVerificationResult;
}

interface SelectionSignals {
  nativeChecked: boolean;
  selectedValueMatches: boolean;
  groupSelectedOther: boolean;
  checkedAttribute: boolean;
  aria: boolean;
  ariaFalse: boolean;
  ariaExposed: boolean;
  selectedClass: boolean;
  framework: boolean;
  frameworkExposed: boolean;
  otherAria: boolean;
  otherSelectedClass: boolean;
  otherFramework: boolean;
  hiddenCount: number;
  hiddenHash: number;
}

const VERIFY_SOURCE = `(formEl, a) => {
  const input = formEl.querySelector("[" + a.fieldAttr + '="' + CSS.escape(a.fieldId) + '"]');
  if (!input) return null;
  const name = input.getAttribute("name");
  const members = Array.from(formEl.querySelectorAll('input[type="radio"]')).filter((r) => r.getAttribute("name") === name);
  const partsOf = (r) => {
    const id = r.getAttribute(a.fieldAttr) || "";
    const label = id ? formEl.querySelector("[" + a.labelAttr + '="' + CSS.escape(id) + '"]') : null;
    const wrapper = id ? formEl.querySelector("[" + a.wrapperAttr + '="' + CSS.escape(id) + '"]') : null;
    return [r, label, wrapper].filter(Boolean);
  };
  const withDescendants = (els) => {
    const out = [];
    els.forEach((e) => { out.push(e); e.querySelectorAll("[aria-checked], [data-state], [data-checked], [data-selected]").forEach((d) => out.push(d)); });
    return out;
  };
  const selectedToken = (token) => /(^|[_-])(checked|selected|active)$/i.test(token) && !/(^|[_-])(un|not|non|no)[_-]?(checked|selected|active)$/i.test(token);
  const hasSelectedClass = (e) => typeof e.className === "string" && e.className.split(/\\s+/).some(selectedToken);
  const fwOn = (e) => ["checked", "on", "selected", "active"].includes((e.getAttribute("data-state") || "").toLowerCase()) || e.getAttribute("data-checked") === "true" || e.getAttribute("data-selected") === "true";
  const fwAttr = (e) => e.hasAttribute("data-state") || e.hasAttribute("data-checked") || e.hasAttribute("data-selected");
  const signalsOf = (r) => {
    const parts = partsOf(r);
    const all = withDescendants(parts);
    return {
      aria: all.some((e) => e.getAttribute("aria-checked") === "true"),
      ariaFalse: all.some((e) => e.getAttribute("aria-checked") === "false"),
      ariaExposed: all.some((e) => e.hasAttribute("aria-checked")),
      cls: parts.slice(1).some(hasSelectedClass),
      fw: all.some(fwOn),
      fwExposed: all.some(fwAttr),
    };
  };
  const own = signalsOf(input);
  const others = members.filter((r) => r !== input && r.value !== input.value);
  const otherSignals = others.map(signalsOf);
  const selected = members.find((r) => r.checked) || null;
  let selectedValueMatches = false;
  const ownerForm = input.form;
  if (ownerForm && name) {
    try { selectedValueMatches = input.value !== "" && new FormData(ownerForm).get(name) === input.value; } catch (e) { selectedValueMatches = false; }
  }
  let container = input.parentElement;
  while (container && container !== formEl && !members.every((m) => container.contains(m))) container = container.parentElement;
  const hidden = container && container !== formEl ? Array.from(container.querySelectorAll('input[type="hidden"]')) : [];
  let hash = 2166136261;
  hidden.map((h) => h.value || "").join("\\u0001").split("").forEach((ch) => { hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0; });
  return {
    nativeChecked: input.checked,
    selectedValueMatches,
    groupSelectedOther: selected !== null && selected !== input && selected.value !== input.value,
    checkedAttribute: input.hasAttribute("checked") && !others.some((o) => o.hasAttribute("checked")),
    aria: own.aria,
    ariaFalse: own.ariaFalse,
    ariaExposed: own.ariaExposed || otherSignals.some((o) => o.ariaExposed),
    selectedClass: own.cls,
    framework: own.fw,
    frameworkExposed: own.fwExposed || otherSignals.some((o) => o.fwExposed),
    otherAria: otherSignals.some((o) => o.aria),
    otherSelectedClass: otherSignals.some((o) => o.cls),
    otherFramework: otherSignals.some((o) => o.fw),
    hiddenCount: hidden.length,
    hiddenHash: hash,
  };
}`;

async function readSelectionSignals(form: Locator, fieldId: string): Promise<SelectionSignals | null> {
  return callInPageFunction<SelectionSignals | null>(form, "__navEngineVerifyConsentOption", VERIFY_SOURCE, {
    fieldAttr: FIELD_INDEX_ATTR,
    labelAttr: CONSENT_LABEL_ATTR,
    wrapperAttr: CONSENT_WRAPPER_ATTR,
    fieldId,
  }).catch(() => null);
}

/**
 * Reads the intended option back from independent state signals. Native state (the input's own
 * checked flag, or the form's selected value for the shared name) or a component state (ARIA,
 * framework data attribute, selected class on the option's own label/wrapper) can verify, but
 * never while another option of the group reads as selected. `strict` (the test-only opt-in)
 * needs native state, plus every component state the widget exposes.
 */
export function assessSelection(signals: SelectionSignals | null, strict: boolean): { result: ConsentVerificationResult; methods: ConsentVerificationMethod[] } {
  if (!signals) return { result: "not_committed", methods: [] };
  const methods: ConsentVerificationMethod[] = [];
  if (signals.nativeChecked) methods.push("native_checked");
  if (signals.selectedValueMatches) methods.push("radio_name_selected_value");
  if (signals.checkedAttribute) methods.push("checked_attribute");
  if (signals.aria) methods.push("aria_checked");
  if (signals.selectedClass) methods.push("selected_class");
  if (signals.framework) methods.push("framework_state");
  const nativeOk = signals.nativeChecked || signals.selectedValueMatches;
  const componentOk = signals.aria || signals.framework || signals.selectedClass;
  const contradicted =
    signals.groupSelectedOther ||
    (signals.ariaFalse && !signals.aria) ||
    signals.otherAria ||
    signals.otherFramework ||
    (signals.otherSelectedClass && !signals.selectedClass);
  if (contradicted) return { result: (nativeOk || componentOk) ? "contradicted" : "not_committed", methods };
  if (strict) {
    const ok = nativeOk && (!signals.ariaExposed || signals.aria) && (!signals.frameworkExposed || signals.framework);
    return { result: ok ? "verified" : "not_committed", methods };
  }
  return { result: nativeOk || componentOk ? "verified" : "not_committed", methods };
}

const RECONCILE_WINDOW_MS = 1_200;
const RECONCILE_POLL_MS = 100;
const RECONCILE_STABLE_MS = 250;

async function waitForReconciledSelection(page: Page, form: Locator, fieldId: string, strict: boolean): Promise<{ result: ConsentVerificationResult; methods: ConsentVerificationMethod[]; signals: SelectionSignals | null }> {
  const deadline = Date.now() + RECONCILE_WINDOW_MS;
  let last = { result: "not_committed" as ConsentVerificationResult, methods: [] as ConsentVerificationMethod[], signals: null as SelectionSignals | null };
  while (true) {
    const signals = await readSelectionSignals(form, fieldId);
    last = { ...assessSelection(signals, strict), signals };
    if (last.result === "verified") {
      // A framework that re-renders from its own state can revert a native change a moment later.
      await page.waitForTimeout(RECONCILE_STABLE_MS);
      const again = await readSelectionSignals(form, fieldId);
      const settled = assessSelection(again, strict);
      if (settled.result === "verified") return { ...settled, signals: again };
      last = { ...settled, signals: again };
    }
    if (Date.now() >= deadline) return last;
    await page.waitForTimeout(RECONCILE_POLL_MS);
  }
}

async function activateMember(
  form: Locator,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  member: ConsentGroupMember,
  intendedAnswer: ConsentIntendedAnswer,
  strict = false,
): Promise<{ verified: boolean; activation: ConsentActivationDiagnostic }> {
  const page = form.page();
  const input = await fieldByIndex(form, member.fieldId);
  const label = form.locator(`[${CONSENT_LABEL_ATTR}="${member.fieldId}"]`).first();
  const wrapper = form.locator(`[${CONSENT_WRAPPER_ATTR}="${member.fieldId}"]`).first();
  const before = await readSelectionSignals(form, member.fieldId);
  const steps: { clickedElementType: ConsentActivationElement; activationMethod: ConsentActivationMethod; run: () => Promise<unknown> }[] = [];
  const usable = (s: ConsentSurfaceState) => s.visible && !s.clipped;
  // An off-screen or clipped native input (a common "visually hidden" custom-radio pattern) cannot
  // take a real pointer click: Playwright waits out its timeout and the label is never tried. It is
  // pointer-clicked only when it was on screen and won the hit-test.
  if (member.input.hitTestable) steps.push({ clickedElementType: "native_input", activationMethod: "pointer_click", run: () => input.click({ timeout: 1_500 }) });
  if (usable(member.labelSurface)) steps.push({ clickedElementType: "label", activationMethod: "pointer_click", run: () => label.click({ timeout: 1_500 }) });
  if (usable(member.wrapperSurface)) steps.push({ clickedElementType: "wrapper", activationMethod: "pointer_click", run: () => wrapper.click({ timeout: 1_500 }) });
  steps.push({
    clickedElementType: "keyboard",
    activationMethod: "focus_and_space",
    run: async () => {
      await input.focus({ timeout: 1_000 });
      await page.keyboard.press("Space");
    },
  });
  steps.push({
    clickedElementType: "programmatic",
    activationMethod: "dispatched_click_input_change",
    // HTMLElement.click() on a radio runs the browser's own activation behaviour: click, then input
    // and change only if the click was not cancelled -- never a forced checked flag.
    run: () => input.evaluate((el: Element) => (el as HTMLElement).click(), undefined, { timeout: 1_000 }),
  });

  const attempts: ConsentActivationDiagnostic["attempts"] = [];
  let final: { result: ConsentVerificationResult; methods: ConsentVerificationMethod[]; signals: SelectionSignals | null } = {
    result: "not_committed",
    methods: [],
    signals: before,
  };
  for (const step of steps) {
    // A real activation even on an already-checked option: some widgets record the answer only from
    // their own click handler, so a pre-rendered default is not necessarily a committed one.
    await step.run().catch(() => {});
    final = await waitForReconciledSelection(page, form, member.fieldId, strict);
    attempts.push({ clickedElementType: step.clickedElementType, activationMethod: step.activationMethod, verificationResult: final.result });
    if (final.result === "verified") break;
  }
  const after = final.signals;
  const lastAttempt = attempts[attempts.length - 1];
  return {
    verified: final.result === "verified",
    activation: {
      intendedAnswer,
      actionableSurface: member.activationSurface,
      attempts,
      clickedElementType: lastAttempt?.clickedElementType ?? null,
      activationMethod: lastAttempt?.activationMethod ?? null,
      intendedOptionCheckedBefore: before?.nativeChecked ?? false,
      intendedOptionCheckedAfter: after?.nativeChecked ?? false,
      verificationMethods: final.methods,
      hiddenConsentFieldChanged: before && after && (before.hiddenCount > 0 || after.hiddenCount > 0) ? before.hiddenHash !== after.hiddenHash : null,
      verificationResult: final.result,
    },
  };
}

/**
 * Resolves every actionable radio group by purpose. Optional commercial purposes (marketing,
 * profiling, third-party sharing) always end on the decline option -- a pre-selected accept is
 * flipped and a pre-selected decline is explicitly committed; required processing/terms are
 * accepted only when the form marks them required; customer qualification and journey intent keep
 * their fixed policies; ambiguous groups are never touched. Every interaction is read back.
 * Rescans after each pass so a group revealed by an earlier answer is handled too, and rescans a
 * bounded number of times while a detected group is still not actionable (rendered late, moved by
 * a layout change). Every detected group ends in either consentGroupDiagnostics or
 * consentGroupRejections.
 */
export async function resolveConsentGroups(
  page: Page,
  form: Locator,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  journeyContext: FormJourneyContext = {},
): Promise<ConsentGroupResolutionResult> {
  const seenActionableGroupIds = new Set<string>();
  const lastSeen = new Map<string, ConsentGroupDescriptor>();
  const scrolledGroupIds = new Set<string>();
  const outcomes = new Map<string, GroupOutcome>();
  let conditionalRevealedCount = 0;
  let consentGroupsInitiallyVisible = 0;
  let rescanCount = 0;

  for (let pass = 0; ; pass += 1) {
    const groups = await discoverConsentGroups(form, { scroll: true });
    groups.forEach((g) => {
      lastSeen.set(g.groupId, g);
      if (g.scrolledIntoView) scrolledGroupIds.add(g.groupId);
    });
    const actionableGroups = groups.filter((g) => g.actionable);

    if (pass === 0) {
      consentGroupsInitiallyVisible = actionableGroups.length;
      actionableGroups.forEach((g) => seenActionableGroupIds.add(g.groupId));
    } else {
      const newlyRevealed = actionableGroups.filter((g) => !seenActionableGroupIds.has(g.groupId));
      conditionalRevealedCount += newlyRevealed.length;
      newlyRevealed.forEach((g) => seenActionableGroupIds.add(g.groupId));
    }

    const pending = actionableGroups.filter((g) => !outcomes.has(g.groupId));
    for (const group of pending) {
      outcomes.set(group.groupId, await resolveOneGroup(form, group, language, fieldByIndex, journeyContext));
    }
    const waitingOnNonActionable = groups.some((g) => !g.actionable && !outcomes.has(g.groupId) && g.rejection?.stage !== "responsive_dedupe");
    if ((pending.length === 0 && !waitingOnNonActionable) || rescanCount >= MAX_RESCANS) break;
    rescanCount += 1;
    await page.waitForTimeout(pending.length > 0 ? RESCAN_SETTLE_MS : NON_ACTIONABLE_RESCAN_WAIT_MS);
  }

  const finalGroups = await discoverConsentGroups(form, { scroll: true });
  finalGroups.forEach((g) => lastSeen.set(g.groupId, g));
  const allGroups = [...lastSeen.values()];
  const unresolvedRequired = finalGroups.filter((g) => g.actionable && g.checkedMemberFieldId === null && g.requiredEvidence !== "none");

  const diagnostics: ConsentGroupDiagnostic[] = [];
  const rejections: ConsentGroupRejection[] = [];
  for (const g of allGroups) {
    if (!outcomes.has(g.groupId) && !g.actionable) {
      rejections.push(rejectionRecord(g, language));
      continue;
    }
    const resolved = g.checkedMemberFieldId !== null;
    const actionableMembers = g.members.filter((m) => m.actionable);
    const outcome = outcomes.get(g.groupId) ?? lateGroupOutcome(g, language);
    diagnostics.push({
      groupId: g.groupId,
      purpose: outcome.purpose,
      purposeEvidence: outcome.purposeEvidence,
      questionFound: g.questionSource !== "none",
      questionSource: g.questionSource,
      requiredEvidence: g.requiredEvidence,
      optionCount: g.members.length,
      visibleOptionCount: actionableMembers.length,
      hiddenDuplicateCount: g.members.filter((m) => m.hiddenDuplicate).length,
      scrolledIntoView: scrolledGroupIds.has(g.groupId),
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
      ...(outcome.activation ? { activation: outcome.activation } : {}),
      ...(outcome.outcomeTag ? { outcomeTag: outcome.outcomeTag } : {}),
    });
  }
  const outcomeList = [...outcomes.values()];

  return {
    consentGroupsDetected: allGroups.length,
    consentGroupsInitiallyVisible,
    consentGroupsActionable: diagnostics.length,
    consentGroupsDiscoveredNonActionable: rejections.length,
    consentGroupsInteracted: outcomeList.filter((o) => o.activation !== undefined).length,
    consentGroupsCommitted: outcomeList.filter((o) => o.checkedStateVerified === true).length,
    consentGroupDiagnostics: diagnostics,
    consentGroupRejections: rejections,
    consentGroupsCompleted: outcomeList.filter((o) => o.completed && o.interaction !== "left_untouched").length,
    conditionalConsentGroupsRevealed: conditionalRevealedCount,
    consentRescanCount: rescanCount,
    unresolvedRequiredConsentGroups: unresolvedRequired.map((g) => g.groupId),
    unresolvedOptionalConsentGroups: [
      ...diagnostics.filter((d) => OPTIONAL_COMMERCIAL_PURPOSES.has(d.purpose) && d.checkedAfter !== "negative").map((d) => d.groupId),
      ...rejections.filter((r) => OPTIONAL_COMMERCIAL_PURPOSES.has(r.purpose) && r.rejectionStage !== "responsive_dedupe").map((r) => r.groupId),
    ],
    optionalDeclineNotCommittedGroups: [...outcomes.entries()].filter(([, o]) => o.outcomeTag === "consent_decline_not_committed").map(([id]) => id),
  };
}

function surfaceSummary(members: ConsentGroupMember[], pick: (m: ConsentGroupMember) => ConsentSurfaceState): ConsentSurfaceSummary {
  const states = members.map(pick);
  return {
    found: states.some((s) => s.found),
    visible: states.some((s) => s.visible),
    onScreen: states.some((s) => s.onScreen),
    clipped: states.some((s) => s.visible && s.clipped),
  };
}

function rejectionRecord(group: ConsentGroupDescriptor, language: SupportedLanguage): ConsentGroupRejection {
  const classified = classifyGroup(group, language);
  const rejection = group.rejection ?? { stage: "actionable_filter" as const, reason: "obscured_by_other_element" as const };
  return {
    groupId: group.groupId,
    purpose: classified.purpose,
    purposeEvidence: classified.evidence,
    memberCount: group.members.length,
    nativeInput: surfaceSummary(group.members, (m) => m.input),
    label: surfaceSummary(group.members, (m) => m.labelSurface),
    wrapper: surfaceSummary(group.members, (m) => m.wrapperSurface),
    scrolledIntoView: group.scrolledIntoView,
    hiddenResponsiveDuplicateDetected: rejection.stage === "responsive_dedupe" || group.members.some((m) => m.hiddenDuplicate),
    actionableMemberCount: group.members.filter((m) => m.actionable).length,
    rejectionStage: rejection.stage,
    rejectionReason: rejection.reason,
  };
}

function classifyGroup(group: ConsentGroupDescriptor, language: SupportedLanguage): ReturnType<typeof classifyRadioGroup> {
  const actionable = group.members.filter((m) => m.actionable);
  const members = actionable.length > 0 ? actionable : group.members;
  return classifyRadioGroup({ questionText: group.questionText, memberLabels: [...new Set(members.map((m) => m.label))], groupName: group.groupId }, language);
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
    unresolvedReason: "became actionable only after the bounded rescan loop ended",
  };
}

async function resolveOneGroup(
  form: Locator,
  group: ConsentGroupDescriptor,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
  journeyContext: FormJourneyContext,
): Promise<GroupOutcome> {
  const visibleMembers = group.members.filter((m) => m.actionable);
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
  const act = async (target: ConsentGroupMember, interaction: ConsentInteraction, reason: string, intendedAnswer: ConsentIntendedAnswer): Promise<GroupOutcome> => {
    const { verified, activation } = await activateMember(form, fieldByIndex, target, intendedAnswer);
    return verified
      ? { ...base, interaction, checkedStateVerified: true, completed: true, selectionReason: reason, activation }
      : {
          ...base,
          interaction,
          checkedStateVerified: false,
          completed: false,
          unresolvedReason: `the intended option did not read back as selected after ${activation.attempts.length} activation routes (${activation.verificationResult})`,
          activation,
          ...(intendedAnswer === "decline" ? { outcomeTag: "consent_decline_not_committed" as const } : {}),
        };
  };

  if (OPTIONAL_COMMERCIAL_PURPOSES.has(classified.purpose)) {
    const decline = pickByPolarity(group.members, "negative");
    if (!decline) return untouched("optional commercial purpose, but no visible decline option could be recognised; left untouched rather than guessed");
    const interaction: ConsentInteraction =
      base.checkedBefore === "negative" ? "committed_preselected_decline" : base.checkedBefore === "none" ? "selected_decline" : "flipped_preselected_accept_to_decline";
    return act(decline, interaction, `${classified.purpose}: declined`, "decline");
  }

  if (REQUIRED_PURPOSES.has(classified.purpose)) {
    if (group.requiredEvidence === "none") return untouched("required-processing/terms acknowledgement not marked required for this submission; left untouched");
    if (base.checkedBefore === "positive") {
      return { ...base, interaction: "kept_preselected_accept_required", checkedStateVerified: null, completed: true, selectionReason: "already accepted; marked required for this submission" };
    }
    const accept = pickByPolarity(group.members, "positive");
    return accept
      ? act(accept, "accepted_required", `${classified.purpose} marked required (${group.requiredEvidence}): accepted`, "accept")
      : untouched("required acknowledgement, but no visible accept option could be recognised; left untouched rather than guessed");
  }

  if (classified.purpose === "journey_intent" || classified.purpose === "customer_qualification") {
    if (group.checkedMemberFieldId !== null) return untouched("already answered on the page before resolution ran", true);
    const labels = visibleMembers.map((m) => m.label);
    const resolution = classified.purpose === "journey_intent" ? resolveJourneyIntentOption(labels, journeyContext, language) : resolvePrivateCustomerOption(labels, language);
    const target = resolution ? visibleMembers[resolution.index] : undefined;
    return target && resolution
      ? act(target, "selected_by_policy", resolution.reason, "policy_option")
      : untouched(`classified as ${classified.classification} but no option could be confidently resolved; left unresolved rather than guessed`);
  }

  return untouched("classification was ambiguous; left untouched rather than guessed", group.checkedMemberFieldId !== null);
}

export const EMPTY_CONSENT_GROUP_RESULT: ConsentGroupResolutionResult = {
  consentGroupsDetected: 0,
  consentGroupsInitiallyVisible: 0,
  consentGroupsActionable: 0,
  consentGroupsDiscoveredNonActionable: 0,
  consentGroupsInteracted: 0,
  consentGroupsCommitted: 0,
  consentGroupDiagnostics: [],
  consentGroupRejections: [],
  consentGroupsCompleted: 0,
  conditionalConsentGroupsRevealed: 0,
  consentRescanCount: 0,
  unresolvedRequiredConsentGroups: [],
  unresolvedOptionalConsentGroups: [],
  optionalDeclineNotCommittedGroups: [],
};

export interface OptionalConsentOptInGroup {
  groupId: string;
  purpose: ConsentPurpose;
  intendedAnswer: "accept";
  checkedBefore: OptionPolarity | "none";
  checkedAfter: OptionPolarity | "none";
  verified: boolean;
  /** Null when no visible accept option could be recognised, so nothing was clicked. */
  activation: ConsentActivationDiagnostic | null;
}

export interface OptionalConsentOptInResult {
  groups: OptionalConsentOptInGroup[];
  /** Live discoveries this opt-in ran (never a reuse of an earlier scan). */
  rediscoveryCount: number;
  /** True only when at least one optional group exists and every one of them reads back as accepted under strict verification. */
  allVerified: boolean;
}

export interface OptionalConsentRediscovery {
  /** Live discoveries run, including the bounded rescans. */
  rediscoveryCount: number;
  optionalGroupsDetected: number;
  actionableOptionalGroupIds: string[];
  /** Optional groups still not actionable after the last rescan (responsive copies of an actionable group excluded). */
  nonActionableOptionalGroups: ConsentGroupRejection[];
}

const REDISCOVERY_MAX_PASSES = 3;

/**
 * Re-reads the optional commercial groups from the live DOM for the fallback decision, scrolling
 * each group into view and rescanning a bounded number of times while any is detected but not yet
 * actionable. Never derived from the pre-submit scan, which may have run before the controls were
 * rendered or reachable.
 */
export async function rediscoverOptionalConsentGroups(page: Page, form: Locator, language: SupportedLanguage): Promise<OptionalConsentRediscovery> {
  let rediscoveryCount = 0;
  let optional: { group: ConsentGroupDescriptor; classified: ReturnType<typeof classifyRadioGroup> }[] = [];
  for (let pass = 0; pass < REDISCOVERY_MAX_PASSES; pass += 1) {
    if (pass > 0) await page.waitForTimeout(NON_ACTIONABLE_RESCAN_WAIT_MS);
    const groups = await discoverConsentGroups(form, { scroll: true });
    rediscoveryCount += 1;
    optional = groups
      .map((group) => ({ group, classified: classifyGroup(group, language) }))
      .filter(({ classified }) => OPTIONAL_COMMERCIAL_PURPOSES.has(classified.purpose));
    if (!optional.some(({ group }) => !group.actionable && group.rejection?.stage !== "responsive_dedupe")) break;
  }
  return {
    rediscoveryCount,
    optionalGroupsDetected: optional.filter(({ group }) => group.rejection?.stage !== "responsive_dedupe").length,
    actionableOptionalGroupIds: optional.filter(({ group }) => group.actionable).map(({ group }) => group.groupId),
    nonActionableOptionalGroups: optional
      .filter(({ group }) => !group.actionable && group.rejection?.stage !== "responsive_dedupe")
      .map(({ group }) => rejectionRecord(group, language)),
  };
}

/**
 * Test-only opt-in (safety.allowOptionalConsentOptInFallbackForTest): switches every actionable
 * optional commercial group -- marketing, profiling, third-party sharing -- to its accept option,
 * read back strictly (native state plus every component state the widget exposes). Required
 * processing, terms and every other purpose are never touched. Fails closed: a group with no
 * recognisable accept option counts as unverified.
 */
export async function applyOptionalConsentOptInForTest(
  form: Locator,
  language: SupportedLanguage,
  fieldByIndex: (form: Locator, index: string) => Promise<Locator>,
): Promise<OptionalConsentOptInResult> {
  const groups = (await discoverConsentGroups(form, { scroll: true })).filter((g) => g.actionable);
  const results: OptionalConsentOptInGroup[] = [];
  for (const group of groups) {
    const classified = classifyGroup(group, language);
    if (!OPTIONAL_COMMERCIAL_PURPOSES.has(classified.purpose)) continue;
    const checkedBefore = checkedPolarity(group);
    const accept = pickByPolarity(group.members, "positive");
    if (!accept) {
      results.push({ groupId: group.groupId, purpose: classified.purpose, intendedAnswer: "accept", checkedBefore, checkedAfter: checkedBefore, verified: false, activation: null });
      continue;
    }
    const { verified, activation } = await activateMember(form, fieldByIndex, accept, "accept", true);
    const reread = (await discoverConsentGroups(form)).find((g) => g.groupId === group.groupId);
    results.push({
      groupId: group.groupId,
      purpose: classified.purpose,
      intendedAnswer: "accept",
      checkedBefore,
      checkedAfter: reread ? checkedPolarity(reread) : "none",
      verified,
      activation,
    });
  }
  return { groups: results, rediscoveryCount: 1, allVerified: results.length > 0 && results.every((r) => r.verified) };
}
