import type { Locator } from "playwright";
import { TREE_ELEMENT_BY_ID_SOURCE } from "../observation/openShadowDom.js";
import { callInPageFunction } from "../forms/inPageFunction.js";

export type CheckedCategory = "checked" | "unchecked" | "not_applicable";
export type ValidityCategory =
  | "valid"
  | "value_missing"
  | "type_mismatch"
  | "pattern_mismatch"
  | "length_out_of_range"
  | "range_or_step_mismatch"
  | "bad_input"
  | "custom_error"
  | "not_validated";

/**
 * Sanitised state of one form control at one instant. Never a value, label text, option text or
 * serialised data: only categories and booleans, plus the control's own `name` attribute with any
 * run of five or more digits masked (a form's technical field name, never something typed).
 */
export interface ControlStateSnapshot {
  fieldId: string;
  purpose: string;
  safeName: string | null;
  type: string;
  visible: boolean;
  enabled: boolean;
  readonly: boolean;
  requiredHtml: boolean;
  requiredAria: boolean;
  /** Required only by page metadata: a visible "*" marker, a data-*required attribute, or a required/mandatory class. */
  requiredClientMetadata: boolean;
  populated: boolean;
  checkedCategory: CheckedCategory;
  /** The value the site will read is in place: a non-empty value (a hidden select's visible proxy agreeing with it), a checked box, a radio group with a checked member. */
  committed: boolean;
  includedInSerialisation: boolean;
  validityCategory: ValidityCategory;
  validationMessagePresent: boolean;
  /** Set for a hidden native select with a visible custom stand-in, and for that stand-in itself. */
  proxyRole: "proxied_select" | "select_proxy" | null;
  /** Checkbox-only state, null for every other control. */
  checkbox: CheckboxSurfaceState | null;
}

export interface CheckboxSurfaceState {
  /** Native input or one of its labels is rendered with a box and on the document. */
  actionable: boolean;
  ariaChecked: "true" | "false" | "absent";
  /** A label or wrapper of the checkbox carries a checked/selected/active class. */
  visualSelected: boolean | null;
}

/** Kept in Node only, never serialised into the response: a hash of the hidden inputs next to each checkbox, used to tell whether a hidden companion changed. */
export interface SnapshotWithCompanions {
  controls: ControlStateSnapshot[];
  companionSignatures: Record<string, string>;
}

const SNAPSHOT_SOURCE = `(formEl, arg) => {
  const attr = arg.fieldAttr;
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    const s = window.getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const errorNear = (el) => {
    const ids = (el.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean);
    if (ids.some((id) => { const d = (${TREE_ELEMENT_BY_ID_SOURCE})(el, id); return d && shown(d) && (d.textContent || "").trim().length > 0; })) return true;
    const host = el.parentElement;
    if (!host) return false;
    return Array.from(host.querySelectorAll('[role="alert"], [class*="error" i], [class*="invalid" i]')).some(
      (n) => n !== el && !n.matches("input, select, textarea") && shown(n) && (n.textContent || "").trim().length > 0,
    );
  };
  const validityOf = (el) => {
    if (!el.willValidate || !el.validity) return "not_validated";
    const v = el.validity;
    if (v.valid) return "valid";
    if (v.valueMissing) return "value_missing";
    if (v.typeMismatch) return "type_mismatch";
    if (v.patternMismatch) return "pattern_mismatch";
    if (v.tooShort || v.tooLong) return "length_out_of_range";
    if (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch) return "range_or_step_mismatch";
    if (v.badInput) return "bad_input";
    if (v.customError) return "custom_error";
    return "valid";
  };
  const hash = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h >>> 0);
  };
  const norm = (s) => String(s || "").toLowerCase().replace(/\\s+/g, " ").trim();
  const companions = {};
  const controls = Array.from(formEl.querySelectorAll("[" + attr + "]")).map((el) => {
    const id = el.getAttribute(attr) || "";
    const tag = el.tagName.toLowerCase();
    const type = tag === "input" ? (el.type || "text") : tag;
    const isCheck = type === "checkbox" || type === "radio";
    const proxyFor = el.getAttribute(attr + "-proxy-for");
    const proxyEl = tag === "select" ? formEl.querySelector("[" + attr + "-proxy-for=\\"" + id + "\\"]") : null;
    const disabled = el.disabled || Boolean(el.closest("fieldset[disabled]"));
    const value = tag === "select" ? el.value : isCheck ? "" : el.value || "";
    let groupChecked = false;
    if (type === "radio" && el.name) {
      groupChecked = Array.from(formEl.querySelectorAll('input[type="radio"]')).some((r) => r.name === el.name && r.checked);
    }
    const populated = isCheck ? el.checked : value.trim().length > 0;
    let committed = type === "radio" ? groupChecked : populated;
    if (tag === "select" && proxyEl && populated) {
      const opt = el.options[el.selectedIndex];
      const shownText = norm(proxyEl.tagName === "INPUT" ? proxyEl.value : proxyEl.textContent);
      committed = !shownText || !opt || shownText.includes(norm(opt.textContent));
    }
    let included = Boolean(el.name) && !disabled && type !== "submit" && type !== "button" && type !== "reset" && type !== "image" && type !== "file";
    if (included && isCheck) included = el.checked;
    if (included && tag === "select") included = el.selectedIndex >= 0;
    const requiredHtml = el.hasAttribute("required");
    const requiredAria = el.getAttribute("aria-required") === "true";
    const markerRequired = el.getAttribute(attr + "-required") === "true" && !requiredHtml && !requiredAria;
    const classRequired = /(^|[\\s_-])(required|mandatory)([\\s_-]|$)/i.test(el.className || "");
    const dataRequired = Array.from(el.attributes).some((a) => /^data-.*required/i.test(a.name) && !a.name.startsWith("data-nav-engine-"));
    let checkbox = null;
    if (type === "checkbox") {
      const labels = Array.from(el.labels || []);
      const actionable = (shown(el) && el.getBoundingClientRect().right > 0) || labels.some((l) => shown(l) && l.getBoundingClientRect().right > 0);
      const aria = el.getAttribute("aria-checked") || labels.map((l) => l.getAttribute("aria-checked")).find((v) => v) || null;
      const surfaces = labels.concat(el.parentElement ? [el.parentElement] : []);
      const classed = surfaces.filter((s) => /(^|[\\s_-])(checked|selected|active|is-checked)([\\s_-]|$)/i.test(s.className || ""));
      checkbox = {
        actionable,
        ariaChecked: aria === "true" ? "true" : aria === "false" ? "false" : "absent",
        visualSelected: surfaces.some((s) => /check|select|active/i.test(s.className || "")) ? classed.length > 0 : null,
      };
      const host = el.parentElement && el.parentElement.parentElement ? el.parentElement.parentElement : el.parentElement;
      const hidden = host ? Array.from(host.querySelectorAll('input[type="hidden"]')) : [];
      companions[id] = hash(hidden.map((h) => h.value).join("|"));
    }
    return {
      fieldId: id,
      purpose: "",
      safeName: el.getAttribute("name") ? el.getAttribute("name").replace(/\\d{5,}/g, "{n}").slice(0, 64) : null,
      type,
      visible: type === "hidden" ? false : shown(el),
      enabled: !disabled,
      readonly: Boolean(el.readOnly),
      requiredHtml,
      requiredAria,
      requiredClientMetadata: markerRequired || classRequired || dataRequired,
      populated,
      checkedCategory: isCheck ? (el.checked ? "checked" : "unchecked") : "not_applicable",
      committed,
      includedInSerialisation: included,
      validityCategory: validityOf(el),
      validationMessagePresent: Boolean(el.validationMessage) || el.getAttribute("aria-invalid") === "true" || errorNear(el),
      proxyRole: proxyEl ? "proxied_select" : proxyFor !== null ? "select_proxy" : null,
      checkbox,
    };
  });
  return { controls, companionSignatures: companions };
}`;

/** Reads every tagged control of the form. Callers re-tag first, so a replaced form is read from its live nodes. */
export async function snapshotFormState(form: Locator, fieldAttr: string, purposes: Map<string, string>): Promise<SnapshotWithCompanions | null> {
  const raw = await callInPageFunction<SnapshotWithCompanions>(form, "__navEngineFormStateSnapshot", SNAPSHOT_SOURCE, { fieldAttr }).catch(() => null);
  if (!raw) return null;
  return {
    controls: raw.controls.map((c) => ({ ...c, purpose: purposes.get(c.fieldId) ?? (c.proxyRole === "select_proxy" ? "select_proxy_display" : "unclassified") })),
    companionSignatures: raw.companionSignatures,
  };
}

export function isRequired(c: ControlStateSnapshot): boolean {
  return c.requiredHtml || c.requiredAria || c.requiredClientMetadata;
}

/** Required checkboxes left unchecked -- an acknowledgement the site will refuse to submit without. */
export function requiredAcknowledgementUnchecked(controls: ControlStateSnapshot[]): string[] {
  return controls.filter((c) => c.type === "checkbox" && isRequired(c) && c.enabled && c.checkedCategory === "unchecked").map((c) => c.fieldId);
}

/** Required, enabled, user-facing controls (visible, or a hidden select with a visible proxy) without a committed value. */
export function requiredUncommitted(controls: ControlStateSnapshot[]): string[] {
  return controls
    .filter((c) => c.type !== "checkbox" && c.type !== "hidden" && c.proxyRole !== "select_proxy" && isRequired(c) && c.enabled)
    .filter((c) => c.visible || c.proxyRole === "proxied_select")
    .filter((c) => !c.committed)
    .map((c) => c.fieldId);
}

export const SNAPSHOT_COMPARED_PROPERTIES = [
  "present",
  "visible",
  "enabled",
  "readonly",
  "requiredHtml",
  "requiredAria",
  "populated",
  "checkedCategory",
  "committed",
  "includedInSerialisation",
  "validityCategory",
  "validationMessagePresent",
] as const;

export interface SnapshotDifference {
  comparison: string;
  fieldId: string;
  purpose: string;
  property: (typeof SNAPSHOT_COMPARED_PROPERTIES)[number];
  from: string;
  to: string;
}

const MAX_DIFFERENCES_PER_COMPARISON = 60;

export function diffSnapshots(comparison: string, before: ControlStateSnapshot[] | null, after: ControlStateSnapshot[] | null): SnapshotDifference[] {
  if (!before || !after) return [];
  const beforeById = new Map(before.map((c) => [c.fieldId, c]));
  const afterById = new Map(after.map((c) => [c.fieldId, c]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];
  const out: SnapshotDifference[] = [];
  for (const id of ids) {
    const a = beforeById.get(id);
    const b = afterById.get(id);
    const purpose = (b ?? a)!.purpose;
    if (!a || !b) {
      out.push({ comparison, fieldId: id, purpose, property: "present", from: String(Boolean(a)), to: String(Boolean(b)) });
      continue;
    }
    for (const property of SNAPSHOT_COMPARED_PROPERTIES) {
      if (property === "present") continue;
      const from = String(a[property]);
      const to = String(b[property]);
      if (from !== to) out.push({ comparison, fieldId: id, purpose, property, from, to });
    }
  }
  return out.slice(0, MAX_DIFFERENCES_PER_COMPARISON);
}

export type CheckboxActivationMethod = "native_check" | "label_click" | "not_activated_by_engine";

export interface AcknowledgementCheckboxDiagnostic {
  fieldId: string;
  semanticPurpose: string;
  required: boolean;
  present: boolean;
  actionable: boolean;
  checkedBeforeInteraction: boolean | null;
  activationMethod: CheckboxActivationMethod;
  checkedAfterInteraction: boolean | null;
  checkedImmediatelyBeforeSubmit: (boolean | null)[];
  /** The checked state changed between the start of the fill and the first Submit although the engine never touched this checkbox -- the page's own script set it. */
  changedWithoutEngineActivation: boolean;
  visualNativeAriaAgreement: "agree" | "disagree" | "no_component_state";
  hiddenCompanionStateChanged: boolean | null;
  includedInSerialisation: boolean | null;
  customValidationResult: "valid" | "native_invalid" | "validation_message_present" | "not_validated";
}

/**
 * One record per checkbox of the form, built from the fill-start, post-fill and pre-Submit
 * snapshots: whether the engine or the page set it, whether its native, ARIA and visual states
 * agree, whether hidden inputs next to it changed, and whether it will be serialised.
 */
export function buildAcknowledgementCheckboxDiagnostics(input: {
  fillStart: SnapshotWithCompanions | null;
  afterFill: SnapshotWithCompanions | null;
  beforeSubmit: (SnapshotWithCompanions | null)[];
  engineActivations: Map<string, "native_check" | "label_click">;
}): AcknowledgementCheckboxDiagnostic[] {
  const firstSubmit = input.beforeSubmit[0] ?? input.afterFill;
  const reference = firstSubmit ?? input.afterFill ?? input.fillStart;
  if (!reference) return [];
  const find = (s: SnapshotWithCompanions | null, id: string) => s?.controls.find((c) => c.fieldId === id) ?? null;
  return reference.controls
    .filter((c) => c.type === "checkbox")
    .map((c) => {
      const start = find(input.fillStart, c.fieldId);
      const afterFill = find(input.afterFill, c.fieldId);
      const pre = input.beforeSubmit.map((s) => {
        const found = find(s, c.fieldId);
        return found ? found.checkedCategory === "checked" : null;
      });
      const native = c.checkedCategory === "checked";
      const states: boolean[] = [];
      if (c.checkbox?.ariaChecked && c.checkbox.ariaChecked !== "absent") states.push(c.checkbox.ariaChecked === "true");
      if (c.checkbox?.visualSelected !== null && c.checkbox?.visualSelected !== undefined) states.push(c.checkbox.visualSelected);
      const startSig = input.fillStart?.companionSignatures[c.fieldId];
      const preSig = firstSubmit?.companionSignatures[c.fieldId];
      const engineActivation = input.engineActivations.get(c.fieldId);
      const engineTouched = engineActivation !== undefined;
      const checkedStart = start ? start.checkedCategory === "checked" : null;
      return {
        fieldId: c.fieldId,
        semanticPurpose: c.purpose,
        required: isRequired(c),
        present: true,
        actionable: c.checkbox?.actionable ?? false,
        checkedBeforeInteraction: checkedStart,
        activationMethod: engineActivation ?? "not_activated_by_engine",
        checkedAfterInteraction: afterFill ? afterFill.checkedCategory === "checked" : null,
        checkedImmediatelyBeforeSubmit: pre,
        changedWithoutEngineActivation: !engineTouched && checkedStart !== null && pre[0] !== null && pre[0] !== undefined && checkedStart !== pre[0],
        visualNativeAriaAgreement: states.length === 0 ? "no_component_state" : states.every((s) => s === native) ? "agree" : "disagree",
        hiddenCompanionStateChanged: startSig !== undefined && preSig !== undefined ? startSig !== preSig : null,
        includedInSerialisation: c.includedInSerialisation,
        customValidationResult: c.validityCategory !== "valid" && c.validityCategory !== "not_validated"
          ? "native_invalid"
          : c.validationMessagePresent
            ? "validation_message_present"
            : c.validityCategory === "not_validated"
              ? "not_validated"
              : "valid",
      };
    });
}
