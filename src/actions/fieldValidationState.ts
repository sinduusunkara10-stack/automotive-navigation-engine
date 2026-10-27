import type { Locator } from "playwright";
import { DEEP_QUERY_ALL_SOURCE, TREE_ELEMENT_BY_ID_SOURCE } from "../observation/openShadowDom.js";
import { callInPageFunction } from "../forms/inPageFunction.js";
import type { ControlStateSnapshot } from "./formStateSnapshot.js";

/**
 * What the site's own validator shows about each control, read from the DOM without calling any
 * validator method (only property reads on a jQuery Validation instance, never valid()/form()/
 * element(), which run rules and change the page) and without dispatching an event. Class tokens
 * and data-* attribute names are the site's technical identifiers; message text never leaves the
 * page -- only its length and a required/format/unspecified category. No value is read.
 */

export type StateTokenCategory = "error" | "pending" | "valid" | "touched" | "untouched";
export type RuleCategory = "required" | "format" | "unspecified" | "none";
export type SiteValidatorState = "invalid" | "pending" | "valid" | "unknown";
export type TouchedState = "touched" | "untouched" | "unknown";

export interface StateToken {
  token: string;
  category: StateTokenCategory;
  location: "control" | "host";
}

export interface DataStateAttribute {
  name: string;
  valueCategory: "true" | "false" | "empty" | "other";
  location: "control" | "host" | "form";
}

export interface FieldValidationState {
  fieldId: string;
  safeName: string | null;
  type: string;
  stateTokens: StateToken[];
  /** File-name stem of a rendered error/wrong/invalid icon in the field's own host (background, pseudo-element or img), e.g. "icon-wrong-field". */
  errorIcon: string | null;
  errorMessagePresent: boolean;
  errorMessageLength: number;
  ruleCategory: RuleCategory;
  ariaInvalid: "true" | "false" | "absent";
  dataStateAttributes: DataStateAttribute[];
  jqueryValidatorInvalid: boolean | null;
  jqueryValidatorPending: boolean | null;
  validatorState: SiteValidatorState;
  touchedState: TouchedState;
  /** Which signals produced validatorState: error_class, error_icon, error_message, aria_invalid, jquery_validator_invalid, pending_class, jquery_validator_pending, valid_class. */
  evidence: string[];
}

export interface UnattributedErrorSurface {
  /** The last tagged control before this surface in document order -- the field it most likely belongs to. */
  nearestPrecedingFieldId: string | null;
  /** Tagged controls inside this surface, when it is a container marked as failing (a fieldset or section). */
  containsFieldIds: string[];
  stateTokens: StateToken[];
  role: "alert" | "status" | "live_region" | null;
  textLength: number;
  ruleCategory: RuleCategory;
  errorIcon: string | null;
}

export interface JqueryHandlerCounts {
  formSubmit: number;
  formClick: number;
  submitControlClick: number;
  delegatedSubmitOnAncestors: number;
  delegatedClickOnAncestors: number;
}

export interface JqueryValidatorState {
  present: boolean;
  invalidFieldIds: string[];
  errorListFieldIds: string[];
  pendingRequestCount: number;
  pendingFieldIds: string[];
  submittedFieldCount: number;
}

export interface FormLevelValidationState {
  formStateTokens: StateToken[];
  formDataStateAttributes: DataStateAttribute[];
  noValidate: boolean;
  /** Validator libraries or framework form layers detected on the page or the form element. */
  validatorLibraries: string[];
  jqueryPresent: boolean;
  jqueryHandlers: JqueryHandlerCounts | null;
  jqueryValidator: JqueryValidatorState | null;
}

export interface FormValidationStateCapture {
  capturedAt: "before_submit" | "after_cancellation";
  fields: FieldValidationState[];
  unattributedErrorSurfaces: UnattributedErrorSurface[];
  form: FormLevelValidationState;
}

type RawField = Omit<FieldValidationState, "validatorState" | "touchedState" | "evidence" | "jqueryValidatorInvalid" | "jqueryValidatorPending">;
interface RawCapture {
  fields: RawField[];
  unattributedErrorSurfaces: UnattributedErrorSurface[];
  form: FormLevelValidationState;
}

export const FIELD_VALIDATION_STATE_SOURCE = `(formEl, arg) => {
  const attr = arg.fieldAttr;
  const MAX_TOKENS = 8;
  const MAX_SURFACES = 10;
  const VOCAB = {
    error: ["error", "errors", "err", "invalid", "wrong", "erreur", "fehler", "errore", "ko", "danger", "fail", "failed", "failure", "incorrect", "nok"],
    pending: ["pending", "loading", "checking", "validating", "busy"],
    valid: ["valid", "success", "ok", "correct", "good", "validated", "passed"],
    touched: ["touched", "dirty", "visited", "blurred", "interacted", "modified"],
    untouched: ["untouched", "pristine"],
  };
  const ICON_RE = /(error|wrong|invalid|warn|alert|fail|erreur)/i;
  const REQUIRED_RE = /(obligatoire|required|requis|mandatory|pflicht|obbligatori|verplicht|obligatori|wymagane|necess)/i;
  const FORMAT_RE = /(invalid|non valide|incorrect|format|ungültig|ungultig|non valido|ongeldig|válid|valid|correct)/i;
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    const s = window.getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const sanitize = (s) => String(s).replace(/\\d{3,}/g, "{n}").slice(0, 40);
  const categoriesOf = (token) => {
    const parts = token.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().split(/[-_]+/).filter(Boolean);
    const out = [];
    for (const cat of ["error", "pending", "untouched", "touched", "valid"]) {
      if (parts.some((p) => VOCAB[cat].includes(p))) out.push(cat);
    }
    if (out.includes("error")) return ["error"];
    if (out.includes("untouched")) return out.filter((c) => c !== "touched");
    return out;
  };
  const tokensOf = (el, location) => {
    const out = [];
    const cls = typeof el.className === "string" ? el.className : (el.getAttribute && el.getAttribute("class")) || "";
    for (const token of cls.split(/\\s+/).filter(Boolean)) {
      if (token.startsWith("data-nav-engine")) continue;
      for (const category of categoriesOf(token)) out.push({ token: sanitize(token), category, location });
    }
    return out;
  };
  const dataAttrsOf = (el, location) =>
    Array.from(el.attributes || [])
      .filter((a) => a.name.startsWith("data-") && !a.name.startsWith("data-nav-engine") && /(valid|error|touch|dirty|pristine|pending|state|status|check)/i.test(a.name))
      .slice(0, 6)
      .map((a) => {
        const v = String(a.value).trim().toLowerCase();
        return { name: sanitize(a.name), valueCategory: v === "" ? "empty" : v === "true" || v === "1" ? "true" : v === "false" || v === "0" ? "false" : "other", location };
      });
  const iconStem = (raw) => {
    const m = /url\\(["']?([^"')]+)["']?\\)/i.exec(raw || "");
    if (!m || m[1].startsWith("data:")) return null;
    const file = (m[1].split(/[?#]/)[0].split("/").pop() || "").replace(/\\.[a-z0-9]+$/i, "");
    return ICON_RE.test(file) ? sanitize(file) : null;
  };
  const iconOf = (n) => {
    if (n.tagName === "IMG" && shown(n)) {
      const s = iconStem("url(" + (n.currentSrc || n.getAttribute("src") || "") + ")");
      if (s) return s;
    }
    if (!shown(n)) return null;
    const own = iconStem(window.getComputedStyle(n).backgroundImage);
    if (own) return own;
    for (const pseudo of ["::before", "::after"]) {
      const ps = window.getComputedStyle(n, pseudo);
      if (ps.display === "none" || ps.content === "none") continue;
      const p = iconStem(ps.backgroundImage) || iconStem(ps.content);
      if (p) return p;
    }
    return null;
  };
  const ruleOf = (text) => (!text ? "none" : REQUIRED_RE.test(text) ? "required" : FORMAT_RE.test(text) ? "format" : "unspecified");
  const roleOf = (n) => {
    const role = (n.getAttribute("role") || "").toLowerCase();
    if (role === "alert") return "alert";
    if (role === "status") return "status";
    const live = (n.getAttribute("aria-live") || "").toLowerCase();
    return live === "assertive" || live === "polite" ? "live_region" : null;
  };
  const tagged = Array.from(formEl.querySelectorAll("[" + attr + "]")).filter((el) => !(el.tagName === "INPUT" && el.type === "hidden"));
  const groupKey = (el) => (el.type === "radio" && el.name ? "r:" + el.name : "i:" + (el.getAttribute(attr + "-proxy-for") || el.getAttribute(attr)));
  const hostOf = (el) => {
    let cur = el;
    for (let level = 0; level < 5 && cur.parentElement && cur.parentElement !== formEl; level += 1) {
      const p = cur.parentElement;
      const other = tagged.some((o) => o !== el && p.contains(o) && groupKey(o) !== groupKey(el));
      if (other) break;
      cur = p;
    }
    return cur;
  };
  const hosts = new Map();
  for (const el of tagged) hosts.set(el, hostOf(el));
  const hostSet = new Set(hosts.values());
  const insideHost = (n) => {
    for (const h of hostSet) if (h === n || h.contains(n)) return true;
    return false;
  };
  const errorLike = (n) => n.getAttribute("aria-invalid") === "true" || roleOf(n) === "alert" || tokensOf(n, "host").some((t) => t.category === "error");
  const textOf = (n) => (n.textContent || "").replace(/\\s+/g, " ").trim();

  const fields = tagged.filter((el) => !el.hasAttribute(attr + "-proxy-for")).map((el) => {
    const host = hosts.get(el);
    const labels = new Set(Array.from(el.labels || []));
    const stateTokens = tokensOf(el, "control");
    for (let n = el.parentElement; n && host.contains(n); n = n.parentElement) {
      stateTokens.push(...tokensOf(n, "host"));
      if (n === host) break;
    }
    let errorIcon = iconOf(el);
    let message = "";
    const flaggedHost = stateTokens.some((t) => t.category === "error") || el.getAttribute("aria-invalid") === "true";
    const describedBy = (el.getAttribute("aria-describedby") || "").split(/\\s+/).filter(Boolean).map((id) => (${TREE_ELEMENT_BY_ID_SOURCE})(el, id)).filter(Boolean);
    const scope = [host, ...Array.from(host.querySelectorAll("*")), ...describedBy];
    for (const n of scope) {
      if (n === el || labels.has(n) || n.matches("input, select, textarea, option, label")) continue;
      if (!errorIcon) errorIcon = iconOf(n);
      if (message || n.contains(el) || n.closest("label") || !shown(n)) continue;
      if (errorLike(n) || describedBy.includes(n) || (flaggedHost && n.children.length === 0)) message = textOf(n);
    }
    const aria = el.getAttribute("aria-invalid");
    return {
      fieldId: el.getAttribute(attr) || "",
      safeName: el.getAttribute("name") ? el.getAttribute("name").replace(/\\d{5,}/g, "{n}").slice(0, 64) : null,
      type: el.tagName === "INPUT" ? el.type || "text" : el.tagName.toLowerCase(),
      stateTokens: stateTokens.slice(0, MAX_TOKENS),
      errorIcon,
      errorMessagePresent: message.length > 0,
      errorMessageLength: message.length,
      ruleCategory: ruleOf(message),
      ariaInvalid: aria === "true" ? "true" : aria === "false" ? "false" : "absent",
      dataStateAttributes: [...dataAttrsOf(el, "control"), ...(host !== el ? dataAttrsOf(host, "host") : [])].slice(0, 6),
    };
  });

  const unattributed = [];
  const recorded = [];
  for (const n of Array.from(formEl.querySelectorAll("*"))) {
    if (unattributed.length >= MAX_SURFACES) break;
    if (n.matches("input, select, textarea, option") || insideHost(n)) continue;
    if (recorded.some((r) => r.contains(n))) continue;
    const icon = iconOf(n);
    const text = textOf(n);
    const flagged = (errorLike(n) && text.length > 0) || icon !== null;
    if (!flagged || !shown(n)) continue;
    const containsFieldIds = tagged.filter((t) => n.contains(t)).map((t) => t.getAttribute(attr) || "").slice(0, 10);
    let nearest = null;
    for (const t of tagged) if (t.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING && !n.contains(t)) nearest = t.getAttribute(attr);
    if (containsFieldIds.length === 0) recorded.push(n);
    unattributed.push({
      nearestPrecedingFieldId: nearest,
      containsFieldIds,
      stateTokens: tokensOf(n, "host").slice(0, MAX_TOKENS),
      role: roleOf(n),
      textLength: containsFieldIds.length > 0 ? 0 : text.length,
      ruleCategory: containsFieldIds.length > 0 ? "none" : ruleOf(text),
      errorIcon: icon,
    });
  }

  const jq = window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery ? window.jQuery : null;
  const libs = [];
  if (jq && jq.validator) libs.push("jquery_validate");
  if (jq && jq.fn.validationEngine) libs.push("jquery_validation_engine");
  if (window.Parsley || (jq && jq.fn.parsley)) libs.push("parsley");
  if (window.FormValidation) libs.push("formvalidation");
  if (window.Pristine) libs.push("pristine");
  if (window.JustValidate) libs.push("just_validate");
  if (window.Bouncer) libs.push("bouncer");
  if (Object.keys(formEl).some((k) => k.startsWith("__react"))) libs.push("react_managed_form");
  if (formEl.__vue__ || formEl.__vueParentComponent) libs.push("vue_managed_form");
  if (/(^|\\s)ng-(valid|invalid|pristine|dirty|touched|untouched)(\\s|$)/.test(formEl.className || "")) libs.push("angular_forms");
  if (typeof formEl.onsubmit === "function") libs.push("inline_onsubmit_handler");

  const submitEl = (${DEEP_QUERY_ALL_SOURCE})(document, "[data-nav-engine-probe-submit]")[0] || null;
  let jqueryHandlers = null;
  let jqueryValidator = null;
  if (jq) {
    const events = (el) => {
      try {
        return (jq._data && jq._data(el, "events")) || {};
      } catch (e) {
        return {};
      }
    };
    const count = (el, type, delegatedOnly) => (events(el)[type] || []).filter((h) => (delegatedOnly ? Boolean(h.selector) : !h.selector)).length;
    let delegatedSubmit = 0;
    let delegatedClick = 0;
    for (let n = formEl.parentNode; n; n = n.parentNode) {
      delegatedSubmit += count(n, "submit", true);
      delegatedClick += count(n, "click", true);
    }
    jqueryHandlers = {
      formSubmit: count(formEl, "submit", false) + count(formEl, "submit", true),
      formClick: count(formEl, "click", false) + count(formEl, "click", true),
      submitControlClick: submitEl ? count(submitEl, "click", false) : 0,
      delegatedSubmitOnAncestors: delegatedSubmit,
      delegatedClickOnAncestors: delegatedClick,
    };
    let v = null;
    try {
      v = jq.data ? jq.data(formEl, "validator") : null;
    } catch (e) {}
    if (v && typeof v === "object") {
      const idOfName = (name) => {
        const el = Array.from(formEl.elements || []).find((e) => e.name === name);
        return el ? el.getAttribute(attr) : null;
      };
      const keysTrue = (o) => Object.keys(o || {}).filter((k) => o[k]);
      jqueryValidator = {
        present: true,
        invalidFieldIds: keysTrue(v.invalid).map(idOfName).filter(Boolean).slice(0, 20),
        errorListFieldIds: (Array.isArray(v.errorList) ? v.errorList : []).map((e) => e && e.element && e.element.getAttribute && e.element.getAttribute(attr)).filter(Boolean).slice(0, 20),
        pendingRequestCount: Number(v.pendingRequest) || 0,
        pendingFieldIds: keysTrue(v.pending).map(idOfName).filter(Boolean).slice(0, 20),
        submittedFieldCount: Object.keys(v.submitted || {}).length,
      };
    }
  }

  return {
    fields,
    unattributedErrorSurfaces: unattributed,
    form: {
      formStateTokens: tokensOf(formEl, "host").map((t) => ({ token: t.token, category: t.category, location: "host" })).slice(0, MAX_TOKENS),
      formDataStateAttributes: dataAttrsOf(formEl, "form"),
      noValidate: Boolean(formEl.noValidate),
      validatorLibraries: libs,
      jqueryPresent: Boolean(jq),
      jqueryHandlers,
      jqueryValidator,
    },
  };
}`;

export function deriveFieldState(raw: RawField, validator: JqueryValidatorState | null): FieldValidationState {
  const evidence: string[] = [];
  const has = (c: StateTokenCategory) => raw.stateTokens.some((t) => t.category === c);
  const jqInvalid = validator ? validator.invalidFieldIds.includes(raw.fieldId) || validator.errorListFieldIds.includes(raw.fieldId) : null;
  const jqPending = validator ? validator.pendingFieldIds.includes(raw.fieldId) : null;
  if (has("error")) evidence.push("error_class");
  if (raw.errorIcon) evidence.push("error_icon");
  if (raw.errorMessagePresent) evidence.push("error_message");
  if (raw.ariaInvalid === "true") evidence.push("aria_invalid");
  if (jqInvalid) evidence.push("jquery_validator_invalid");
  const invalid = evidence.length > 0;
  if (!invalid) {
    if (has("pending")) evidence.push("pending_class");
    if (jqPending) evidence.push("jquery_validator_pending");
  }
  const pending = !invalid && evidence.length > 0;
  if (!invalid && !pending && has("valid")) evidence.push("valid_class");
  const validatorState: SiteValidatorState = invalid ? "invalid" : pending ? "pending" : has("valid") ? "valid" : "unknown";
  const touchedState: TouchedState = has("untouched") ? "untouched" : has("touched") ? "touched" : "unknown";
  return { ...raw, jqueryValidatorInvalid: jqInvalid, jqueryValidatorPending: jqPending, validatorState, touchedState, evidence };
}

export async function captureFieldValidationState(form: Locator, fieldAttr: string, capturedAt: FormValidationStateCapture["capturedAt"]): Promise<FormValidationStateCapture | null> {
  const raw = await callInPageFunction<RawCapture>(form, "__navEngineFieldValidationState", FIELD_VALIDATION_STATE_SOURCE, { fieldAttr }).catch(() => null);
  if (!raw) return null;
  return {
    capturedAt,
    fields: raw.fields.map((f) => deriveFieldState(f, raw.form.jqueryValidator)),
    unattributedErrorSurfaces: raw.unattributedErrorSurfaces,
    form: raw.form,
  };
}

export interface SiteRejectedField {
  fieldId: string;
  purpose: string;
  safeName: string | null;
  ruleCategory: RuleCategory;
  evidence: string[];
  /** The site already marked this field invalid before the Submit click. */
  markedBeforeSubmit: boolean;
}

/** Fields the site's own validator shows as invalid after the cancellation (or, failing an after-capture, before Submit). */
export function siteRejectedFields(
  before: FormValidationStateCapture | null,
  after: FormValidationStateCapture | null,
  purposes: Map<string, string>,
): SiteRejectedField[] {
  const reference = after ?? before;
  if (!reference) return [];
  const invalidBefore = new Set((before?.fields ?? []).filter((f) => f.validatorState === "invalid").map((f) => f.fieldId));
  return reference.fields
    .filter((f) => f.validatorState === "invalid")
    .map((f) => ({
      fieldId: f.fieldId,
      purpose: purposes.get(f.fieldId) ?? "unclassified",
      safeName: f.safeName,
      ruleCategory: f.ruleCategory,
      evidence: f.evidence,
      markedBeforeSubmit: invalidBefore.has(f.fieldId),
    }));
}

export type AsyncValidationState = "pending" | "settled" | "none_observed";

export interface FieldStateComparison {
  fieldId: string;
  purpose: string;
  safeName: string | null;
  domCommitted: boolean;
  /** From a page-level validator instance when one is readable (jQuery Validation); null when no application state could be read. */
  applicationStateCommitted: boolean | null;
  validatorState: SiteValidatorState;
  touchedState: TouchedState;
  asyncValidationState: AsyncValidationState;
  stateAgreement: "agree" | "disagree" | "unknown";
  disagreementReason: string | null;
}

/**
 * Per logical field: the DOM's committed state (from the sanitised snapshot) against what the
 * site's validator shows. A field committed in the DOM that the site still marks invalid -- or an
 * uncommitted one the site marks valid -- is the disagreement a custom validator rejects on.
 */
export function compareDomAndValidatorState(
  snapshot: ControlStateSnapshot[] | null,
  capture: FormValidationStateCapture | null,
  validationRequestPending: boolean,
): FieldStateComparison[] {
  if (!snapshot || !capture) return [];
  const byId = new Map(capture.fields.map((f) => [f.fieldId, f]));
  const validator = capture.form.jqueryValidator;
  const seenRadioGroups = new Set<string>();
  const out: FieldStateComparison[] = [];
  for (const c of snapshot) {
    if (c.type === "hidden" || c.type === "submit" || c.type === "button" || c.proxyRole === "select_proxy") continue;
    if (!c.visible && c.proxyRole !== "proxied_select") continue;
    if (c.type === "radio") {
      const key = c.safeName ?? c.fieldId;
      if (seenRadioGroups.has(key)) continue;
      seenRadioGroups.add(key);
    }
    const f = byId.get(c.fieldId);
    const validatorState = f?.validatorState ?? "unknown";
    const applicationStateCommitted = validator && f ? !(f.jqueryValidatorInvalid ?? false) : null;
    const asyncValidationState: AsyncValidationState =
      validatorState === "pending" || f?.jqueryValidatorPending ? "pending" : validationRequestPending ? "pending" : f && f.evidence.length > 0 ? "settled" : "none_observed";
    let stateAgreement: FieldStateComparison["stateAgreement"] = "unknown";
    let disagreementReason: string | null = null;
    if (validatorState === "invalid") {
      stateAgreement = c.committed ? "disagree" : "agree";
      if (c.committed) disagreementReason = "committed in the DOM but the site marks it invalid";
    } else if (validatorState === "valid") {
      stateAgreement = c.committed ? "agree" : "disagree";
      if (!c.committed) disagreementReason = "the site marks it valid but no value is committed in the DOM";
    } else if (validatorState === "pending") {
      stateAgreement = "disagree";
      disagreementReason = "the site's validation of this field had not settled";
    }
    if (applicationStateCommitted === false && c.committed && stateAgreement !== "disagree") {
      stateAgreement = "disagree";
      disagreementReason = "committed in the DOM but the page's validator instance lists it invalid";
    }
    out.push({
      fieldId: c.fieldId,
      purpose: c.purpose,
      safeName: c.safeName,
      domCommitted: c.committed,
      applicationStateCommitted,
      validatorState,
      touchedState: f?.touchedState ?? "unknown",
      asyncValidationState,
      stateAgreement,
      disagreementReason,
    });
  }
  return out;
}
