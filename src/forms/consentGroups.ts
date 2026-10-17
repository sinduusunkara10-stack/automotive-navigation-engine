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

export interface ConsentGroupMember {
  fieldId: string;
  /** The option's own visible label (internal only -- never emitted in diagnostics). */
  label: string;
  /** The option's own value attribute (internal only -- polarity evidence, never emitted). */
  value: string;
  /** The radio itself, or its associated label for a custom-styled control, is rendered. */
  visible: boolean;
  /** The radio input itself is rendered on the document and not visually clipped, so it can take a direct pointer click. */
  inputVisible: boolean;
  /** The option's associated label is rendered on the document. */
  labelVisible: boolean;
  /** The option's own component wrapper (an ancestor holding this option and no other radio) is rendered on the document and distinct from the label. */
  wrapperVisible: boolean;
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
  const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
  const onDocument = (el) => {
    const r = el.getBoundingClientRect();
    return r.right + window.scrollX > 0 && r.bottom + window.scrollY > 0 && r.left + window.scrollX < docW && r.top + window.scrollY < docH;
  };
  const clipped = (el) => {
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return (r.width <= 2 && r.height <= 2) || /rect\\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\\)/.test(st.clip || "") || /inset\\(50%/.test(st.clipPath || "");
  };
  const shown = (el) => Boolean(el) && rendered(el) && onDocument(el) && !clipped(el);
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
      const exclusive = (el) => Array.from(el.querySelectorAll('input[type="radio"]')).every((r) => r === m);
      const usableWrapper = (el) => Boolean(el) && el !== formEl && formEl.contains(el) && exclusive(el);
      let wrapper = labelEl ? (labelEl.contains(m) ? labelEl : labelEl.parentElement) : m.parentElement;
      while (wrapper && wrapper !== formEl && !wrapper.contains(m)) wrapper = wrapper.parentElement;
      if (!usableWrapper(wrapper)) wrapper = null;
      while (wrapper && (wrapper === labelEl || !rendered(wrapper)) && usableWrapper(wrapper.parentElement)) wrapper = wrapper.parentElement;
      if (wrapper === labelEl) wrapper = null;
      if (wrapper && fieldId) wrapper.setAttribute(attrs.wrapperAttr, fieldId);
      const label = norm((labelEl && labelEl.textContent) || m.getAttribute("aria-label") || textOfIds(m.getAttribute("aria-labelledby")) || (wrapper && wrapper.textContent) || "");
      const inputVisible = shown(m);
      const labelVisible = shown(labelEl);
      const wrapperVisible = shown(wrapper);
      return { fieldId, label, value: m.value || "", inputVisible, labelVisible, wrapperVisible, visible: inputVisible || labelVisible || wrapperVisible, checked: m.checked, el: m };
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
      members: members.map((m) => ({ fieldId: m.fieldId, label: m.label, value: m.value, visible: m.visible, inputVisible: m.inputVisible, labelVisible: m.labelVisible, wrapperVisible: m.wrapperVisible, checked: m.checked })),
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
 * text, and finally the nearest preceding heading. A member counts as visible when the radio, its
 * label or its own component wrapper is rendered on the document and not clipped away, so a
 * custom-styled control is not lost while a hidden responsive duplicate or an off-screen copy is.
 */
export async function discoverConsentGroups(form: Locator): Promise<ConsentGroupDescriptor[]> {
  return callInPageFunction<ConsentGroupDescriptor[]>(form, "__navEngineDiscoverConsentGroups", DISCOVER_SOURCE, {
    fieldAttr: FIELD_INDEX_ATTR,
    labelAttr: CONSENT_LABEL_ATTR,
    wrapperAttr: CONSENT_WRAPPER_ATTR,
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
  /** How the intended option was activated and read back; present whenever an interaction was attempted. */
  activation?: ConsentActivationDiagnostic;
  /** Set when an optional commercial purpose's decline could not be read back as selected. */
  outcomeTag?: "consent_decline_not_committed";
}

export interface ConsentGroupResolutionResult {
  consentGroupsDetected: number;
  consentGroupsInitiallyVisible: number;
  consentGroupDiagnostics: ConsentGroupDiagnostic[];
  consentGroupsCompleted: number;
  conditionalConsentGroupsRevealed: number;
  consentRescanCount: number;
  unresolvedRequiredConsentGroups: string[];
  /** Optional commercial groups whose decline was attempted but never read back as selected. */
  optionalDeclineNotCommittedGroups: string[];
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
  // An off-screen or clipped native input (a common "visually hidden" custom-radio pattern) cannot
  // take a real pointer click: Playwright waits out its timeout and the label is never tried.
  if (member.inputVisible) steps.push({ clickedElementType: "native_input", activationMethod: "pointer_click", run: () => input.click({ timeout: 1_500 }) });
  if (member.labelVisible) steps.push({ clickedElementType: "label", activationMethod: "pointer_click", run: () => label.click({ timeout: 1_500 }) });
  if (member.wrapperVisible) steps.push({ clickedElementType: "wrapper", activationMethod: "pointer_click", run: () => wrapper.click({ timeout: 1_500 }) });
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
        ...(outcome.activation ? { activation: outcome.activation } : {}),
        ...(outcome.outcomeTag ? { outcomeTag: outcome.outcomeTag } : {}),
      };
    }),
    consentGroupsCompleted: [...outcomes.values()].filter((o) => o.completed && o.interaction !== "left_untouched").length,
    conditionalConsentGroupsRevealed: conditionalRevealedCount,
    consentRescanCount: rescanCount,
    unresolvedRequiredConsentGroups: unresolvedRequired.map((g) => g.groupId),
    optionalDeclineNotCommittedGroups: [...outcomes.entries()].filter(([, o]) => o.outcomeTag === "consent_decline_not_committed").map(([id]) => id),
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
  consentGroupDiagnostics: [],
  consentGroupsCompleted: 0,
  conditionalConsentGroupsRevealed: 0,
  consentRescanCount: 0,
  unresolvedRequiredConsentGroups: [],
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
  /** True only when at least one optional group exists and every one of them reads back as accepted under strict verification. */
  allVerified: boolean;
}

/**
 * Test-only opt-in (safety.allowOptionalConsentOptInFallbackForTest): switches every visible
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
  const groups = (await discoverConsentGroups(form)).filter((g) => g.visible);
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
  return { groups: results, allVerified: results.length > 0 && results.every((r) => r.verified) };
}
