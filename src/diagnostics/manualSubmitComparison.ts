import { FIELD_VALIDATION_STATE_SOURCE } from "../actions/fieldValidationState.js";
import { buildSubmitProbeSource, PROBE_FORM_ATTR, PROBE_SUBMIT_ATTR } from "../actions/submitCancellationProbe.js";

const FIELD_ATTR = "data-nav-engine-field-index";

/**
 * A DevTools-console snippet that records, in a person's own browser, the same sanitised evidence
 * the engine records for an automated Submit: the passive submit probe (listeners only, no page
 * function replaced) and the per-field validator state before and after the Submit. Pasted after
 * filling the form by hand and before clicking Submit; the output carries no value, body or
 * message text, so it can be compared field by field (by safeName) with an automated run's
 * submitCancellationDiagnostics.
 */
export function buildManualSubmitComparisonSnippet(): string {
  return `(() => {
  const forms = Array.from(document.forms).filter((f) => f.querySelector('[type="submit"]'));
  const form = forms.find((f) => f.getBoundingClientRect().height > 0) || forms[0];
  if (!form) return console.warn("no form with a Submit control found");
  form.querySelectorAll("input, select, textarea").forEach((el, i) => el.setAttribute(${JSON.stringify(FIELD_ATTR)}, String(i)));
  form.setAttribute(${JSON.stringify(PROBE_FORM_ATTR)}, "1");
  const submit = Array.from(form.querySelectorAll('[type="submit"]')).find((b) => b.getBoundingClientRect().height > 0);
  if (submit) submit.setAttribute(${JSON.stringify(PROBE_SUBMIT_ATTR)}, "1");
  ${buildSubmitProbeSource("passive")};
  const fieldState = ${FIELD_VALIDATION_STATE_SOURCE};
  const before = fieldState(form, { fieldAttr: ${JSON.stringify(FIELD_ATTR)} });
  window.__navEngineSubmitProbe.begin(1);
  window.__navEngineManualComparison = {
    read() {
      return JSON.stringify({ kind: "manual_submit_comparison", probe: window.__navEngineSubmitProbe.read(), before, after: fieldState(form, { fieldAttr: ${JSON.stringify(FIELD_ATTR)} }) }, null, 2);
    },
  };
  console.log("Ready. Click Submit, wait for the outcome, then run: copy(window.__navEngineManualComparison.read())");
})();`;
}
