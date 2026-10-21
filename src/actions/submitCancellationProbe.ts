import type { Locator, Page } from "playwright";
import { classifyBusinessRequest } from "./submissionObserver.js";
import { classifyRequestPurpose } from "./dealerLookupNetwork.js";
import type { AcknowledgementCheckboxDiagnostic, ControlStateSnapshot, SnapshotDifference } from "./formStateSnapshot.js";

/**
 * Passive client-side evidence of what happened between a Submit click and the business request:
 * listeners on window for click/submit/invalid/reset/formdata/error/unhandledrejection/
 * securitypolicyviolation, plus transparent call recorders on fetch, XMLHttpRequest open/send,
 * navigator.sendBeacon, HTMLFormElement submit/requestSubmit and (when the page has it) jQuery's
 * serialize/serializeArray. A recorder is a Proxy whose trap notes the call and then returns
 * Reflect.apply's result unchanged -- same `this`, same arguments, same return value, the same
 * exception rethrown, synchronously, so ordering and timing are the page's own. No listener calls
 * preventDefault/stopPropagation, no promise returned by the page is chained (that would mark a
 * rejection handled), and validity is read from `validity` rather than checkValidity(), which
 * fires `invalid` events. Never records a value, a body, a query string or message text beyond an
 * error's constructor name.
 */
export const PROBE_FORM_ATTR = "data-nav-engine-probe-form";
export const PROBE_SUBMIT_ATTR = "data-nav-engine-probe-submit";
const PROBE_KEY = "__navEngineSubmitProbe";

export const SUBMIT_PROBE_SOURCE = `(() => {
  const KEY = ${JSON.stringify(PROBE_KEY)};
  if (window[KEY]) return true;
  const FORM_ATTR = ${JSON.stringify(PROBE_FORM_ATTR)};
  const SUBMIT_ATTR = ${JSON.stringify(PROBE_SUBMIT_ATTR)};
  const FIELD_ATTR = "data-nav-engine-field-index";
  const MAX_ITEMS = 25;
  const now = () => Math.round(performance.now());
  const state = { rec: null, inDispatch: false, inFlightXhr: 0, wrapped: new WeakSet() };
  const isProbeForm = (f) => Boolean(f && f.nodeType === 1 && f.tagName === "FORM" && f.hasAttribute(FORM_ATTR));
  const shown = (n) => {
    const r = n.getBoundingClientRect();
    const s = window.getComputedStyle(n);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const errorLikeCount = (form) => {
    if (!form) return 0;
    return Array.from(form.querySelectorAll('[aria-invalid="true"], [role="alert"], [class*="error" i], [class*="invalid" i]')).filter(
      (n) => shown(n) && (n.getAttribute("aria-invalid") === "true" || (n.textContent || "").trim().length > 0),
    ).length;
  };
  const endpointOf = (url) => {
    try {
      const u = new URL(String(url), document.baseURI);
      return u.origin + u.pathname;
    } catch (e) {
      return "unparseable-url";
    }
  };
  const afterClick = (rec) => rec && rec.clickAt !== null;
  const noteDispatch = (transport, method, url) => {
    const rec = state.rec;
    if (!afterClick(rec) || rec.dispatches.length >= MAX_ITEMS) return;
    rec.dispatches.push({ transport, method: String(method || "GET").toUpperCase(), endpoint: endpointOf(url), atMs: now() - rec.clickAt });
  };
  const wrap = (owner, prop, onCall) => {
    const original = owner && owner[prop];
    if (typeof original !== "function" || state.wrapped.has(original)) return;
    const proxy = new Proxy(original, {
      apply(target, thisArg, args) {
        try {
          onCall(thisArg, args);
        } catch (e) {}
        return Reflect.apply(target, thisArg, args);
      },
    });
    state.wrapped.add(proxy);
    try {
      owner[prop] = proxy;
    } catch (e) {}
  };
  const wrapThrowing = (owner, prop, onCall, onThrow) => {
    const original = owner && owner[prop];
    if (typeof original !== "function" || state.wrapped.has(original)) return;
    const proxy = new Proxy(original, {
      apply(target, thisArg, args) {
        try {
          onCall(thisArg, args);
        } catch (e) {}
        try {
          return Reflect.apply(target, thisArg, args);
        } catch (err) {
          try {
            onThrow(err);
          } catch (e) {}
          throw err;
        }
      },
    });
    state.wrapped.add(proxy);
    try {
      owner[prop] = proxy;
    } catch (e) {}
  };

  const xhrMeta = new WeakMap();
  wrap(window, "fetch", (thisArg, args) => {
    const input = args[0];
    const init = args[1] || {};
    const url = input && typeof input === "object" && "url" in input ? input.url : input;
    const method = init.method || (input && typeof input === "object" && "method" in input ? input.method : "GET");
    noteDispatch("fetch", method, url);
  });
  if (window.XMLHttpRequest) {
    wrap(XMLHttpRequest.prototype, "open", (xhr, args) => {
      xhrMeta.set(xhr, { method: args[0], url: args[1] });
    });
    wrap(XMLHttpRequest.prototype, "send", (xhr) => {
      const meta = xhrMeta.get(xhr) || {};
      noteDispatch("xhr", meta.method, meta.url);
      state.inFlightXhr += 1;
      xhr.addEventListener("loadend", () => {
        state.inFlightXhr = Math.max(0, state.inFlightXhr - 1);
      }, { once: true });
    });
  }
  if (navigator.sendBeacon) wrap(navigator, "sendBeacon", (thisArg, args) => noteDispatch("beacon", "POST", args[0]));
  wrap(HTMLFormElement.prototype, "submit", (form) => {
    if (state.rec && isProbeForm(form)) {
      state.rec.nativeSubmitCalled = true;
      noteDispatch("native_form_submit", form.getAttribute("method") || "GET", form.getAttribute("action") || location.href);
    }
  });
  wrap(HTMLFormElement.prototype, "requestSubmit", (form) => {
    if (state.rec && isProbeForm(form)) state.rec.requestSubmitCalled = true;
  });
  const wrapJquery = () => {
    const fn = window.jQuery && window.jQuery.fn;
    if (!fn) return;
    ["serialize", "serializeArray"].forEach((name) =>
      wrapThrowing(
        fn,
        name,
        () => {
          if (afterClick(state.rec)) state.rec.serialiseCalls += 1;
        },
        () => {
          if (afterClick(state.rec)) state.rec.serialiseThrew = true;
        },
      ),
    );
  };

  window.addEventListener("click", (e) => {
    const rec = state.rec;
    if (!rec || !e.target || !e.target.closest) return;
    if (e.target.closest("[" + SUBMIT_ATTR + "]")) {
      rec.clickReceived = true;
      rec.clickAt = now();
    }
  }, true);
  window.addEventListener("submit", (e) => {
    const rec = state.rec;
    if (!rec) return;
    if (!isProbeForm(e.target)) {
      rec.otherFormSubmitEvents += 1;
      return;
    }
    wrapJquery();
    if (rec.clickAt === null) rec.clickAt = now();
    rec.submitEventCount += 1;
    rec.submitEventFired = true;
    rec.submitterPresent = Boolean(e.submitter);
    rec.submitterMatchesControl = Boolean(e.submitter && e.submitter.hasAttribute && e.submitter.hasAttribute(SUBMIT_ATTR));
    rec.inFlightXhrAtSubmit = state.inFlightXhr;
    state.inDispatch = true;
    setTimeout(() => {
      state.inDispatch = false;
      rec.defaultPrevented = e.defaultPrevented;
    }, 0);
  }, true);
  window.addEventListener("submit", (e) => {
    if (state.rec && isProbeForm(e.target)) state.rec.reachedWindowBubble = true;
  }, false);
  window.addEventListener("invalid", (e) => {
    const rec = state.rec;
    const t = e.target;
    if (!rec || !t || !isProbeForm(t.form)) return;
    rec.invalidEventCount += 1;
    const id = t.getAttribute && t.getAttribute(FIELD_ATTR);
    if (id !== null && id !== undefined && rec.invalidFieldIds.length < MAX_ITEMS && !rec.invalidFieldIds.includes(id)) rec.invalidFieldIds.push(id);
  }, true);
  window.addEventListener("reset", (e) => {
    const rec = state.rec;
    if (!rec || !isProbeForm(e.target)) return;
    rec.resetEventFired = true;
    if (rec.dispatches.length === 0) rec.resetBeforeDispatch = true;
  }, true);
  window.addEventListener("formdata", (e) => {
    if (afterClick(state.rec) && isProbeForm(e.target)) state.rec.formDataEventCount += 1;
  }, true);
  window.addEventListener("error", (e) => {
    const rec = state.rec;
    if (!afterClick(rec) || !e || e.target !== window || rec.errors.length >= MAX_ITEMS) return;
    let source = "unknown";
    try {
      source = e.filename ? (new URL(e.filename, document.baseURI).origin === location.origin ? "same_origin" : "cross_origin") : "inline_or_unknown";
    } catch (x) {}
    const name = e.error && e.error.constructor && typeof e.error.constructor.name === "string" ? e.error.constructor.name.slice(0, 40) : "Error";
    rec.errors.push({ name, source, duringSubmitDispatch: state.inDispatch, atMs: now() - rec.clickAt });
  }, true);
  window.addEventListener("unhandledrejection", () => {
    if (afterClick(state.rec)) state.rec.unhandledRejections += 1;
  }, true);
  document.addEventListener("securitypolicyviolation", (e) => {
    const rec = state.rec;
    if (!afterClick(rec) || rec.securityPolicyViolations.length >= MAX_ITEMS) return;
    rec.securityPolicyViolations.push(String(e.effectiveDirective || "unknown").slice(0, 40));
  }, true);

  window[KEY] = {
    begin(attempt) {
      wrapJquery();
      const form = document.querySelector("form[" + FORM_ATTR + "]");
      state.rec = {
        attempt,
        formRef: form,
        clickReceived: false,
        clickAt: null,
        submitEventFired: false,
        submitEventCount: 0,
        otherFormSubmitEvents: 0,
        submitterPresent: null,
        submitterMatchesControl: null,
        defaultPrevented: null,
        reachedWindowBubble: false,
        invalidEventCount: 0,
        invalidFieldIds: [],
        resetEventFired: false,
        resetBeforeDispatch: false,
        formDataEventCount: 0,
        serialiseCalls: 0,
        serialiseThrew: false,
        dispatches: [],
        nativeSubmitCalled: false,
        requestSubmitCalled: false,
        errors: [],
        unhandledRejections: 0,
        securityPolicyViolations: [],
        inFlightXhrAtSubmit: null,
        errorLikeBefore: errorLikeCount(form),
      };
      return true;
    },
    read() {
      const rec = state.rec;
      if (!rec) return null;
      const current = document.querySelector("form[" + FORM_ATTR + "]");
      const out = Object.assign({}, rec);
      delete out.formRef;
      out.formConnected = Boolean(rec.formRef && rec.formRef.isConnected);
      out.formReplaced = Boolean(rec.formRef) && (!rec.formRef.isConnected || (current !== null && current !== rec.formRef));
      out.errorLikeAfter = errorLikeCount(rec.formRef && rec.formRef.isConnected ? rec.formRef : current);
      out.inFlightXhrNow = state.inFlightXhr;
      return out;
    },
  };
  return true;
})()`;

export interface ProbeDispatch {
  transport: "fetch" | "xhr" | "beacon" | "native_form_submit";
  method: string;
  /** origin + path only -- reduced to an endpoint pattern before it leaves this module. */
  endpoint: string;
  atMs: number;
}

export interface ProbeAttemptRecord {
  attempt: number;
  clickReceived: boolean;
  clickAt: number | null;
  submitEventFired: boolean;
  submitEventCount: number;
  otherFormSubmitEvents: number;
  submitterPresent: boolean | null;
  submitterMatchesControl: boolean | null;
  defaultPrevented: boolean | null;
  reachedWindowBubble: boolean;
  invalidEventCount: number;
  invalidFieldIds: string[];
  resetEventFired: boolean;
  resetBeforeDispatch: boolean;
  formDataEventCount: number;
  serialiseCalls: number;
  serialiseThrew: boolean;
  dispatches: ProbeDispatch[];
  nativeSubmitCalled: boolean;
  requestSubmitCalled: boolean;
  errors: { name: string; source: string; duringSubmitDispatch: boolean; atMs: number }[];
  unhandledRejections: number;
  securityPolicyViolations: string[];
  inFlightXhrAtSubmit: number | null;
  errorLikeBefore: number;
  errorLikeAfter: number;
  formConnected: boolean;
  formReplaced: boolean;
  inFlightXhrNow: number;
}

export async function installSubmitProbe(page: Page): Promise<boolean> {
  return (await page
    .mainFrame()
    .evaluate(SUBMIT_PROBE_SOURCE)
    .catch(() => false)) as boolean;
}

/** Re-marks the live form and Submit control (a site may have replaced either) and opens a fresh record for this attempt. */
export async function beginProbeAttempt(page: Page, form: Locator, submit: Locator, attempt: number): Promise<boolean> {
  await installSubmitProbe(page);
  await page
    .mainFrame()
    .evaluate(
      `(() => { document.querySelectorAll("[${PROBE_FORM_ATTR}],[${PROBE_SUBMIT_ATTR}]").forEach((n) => { n.removeAttribute("${PROBE_FORM_ATTR}"); n.removeAttribute("${PROBE_SUBMIT_ATTR}"); }); return true; })()`,
    )
    .catch(() => false);
  const formMarked = await form
    .evaluate((el, attr) => {
      el.setAttribute(attr, "1");
      return true;
    }, PROBE_FORM_ATTR)
    .catch(() => false);
  await submit.evaluate((el, attr) => el.setAttribute(attr, "1"), PROBE_SUBMIT_ATTR).catch(() => {});
  const begun = await page
    .mainFrame()
    .evaluate(`(() => { const p = window.${PROBE_KEY}; return p ? p.begin(${Number(attempt)}) : false; })()`)
    .catch(() => false);
  return Boolean(formMarked && begun);
}

export async function readProbeAttempt(page: Page): Promise<ProbeAttemptRecord | null> {
  return (await page
    .mainFrame()
    .evaluate(`(() => { const p = window.${PROBE_KEY}; return p ? p.read() : null; })()`)
    .catch(() => null)) as ProbeAttemptRecord | null;
}

export const CANCELLATION_STAGES = [
  "submit_event_never_fired",
  "native_validity_blocked",
  "custom_validation_rejected",
  "required_acknowledgement_missing",
  "state_not_committed",
  "submit_handler_prevented_default",
  "submit_handler_exception",
  "serialisation_failed",
  "business_dispatch_not_invoked",
  "business_transport_not_observed",
  "form_reset_before_dispatch",
  "anti_bot_or_security_block",
  "unknown_client_side_cancellation",
] as const;
export type CancellationStage = (typeof CANCELLATION_STAGES)[number];

export interface SanitizedProbeDispatch {
  transport: ProbeDispatch["transport"];
  method: string;
  endpointPattern: string;
  businessCandidate: boolean;
  atMs: number;
}

export interface ClientSideCancellationEvidence {
  probeAvailable: boolean;
  submitClickReceived: boolean;
  submitEventFired: boolean;
  submitEventCount: number;
  submitterPresent: boolean | null;
  submitterMatchesClickedControl: boolean | null;
  defaultPrevented: boolean | null;
  submitEventReachedWindowBubble: boolean;
  invalidEventCount: number;
  invalidFieldIds: string[];
  handlerExceptionDuringDispatch: boolean;
  errorsAfterSubmit: { name: string; source: string; duringSubmitDispatch: boolean; atMs: number }[];
  unhandledRejectionsAfterSubmit: number;
  serialisationObserved: boolean;
  formDataEventCount: number;
  serialiseCalls: number;
  serialisationThrew: boolean;
  dispatchInvocations: SanitizedProbeDispatch[];
  businessDispatchInvoked: boolean;
  businessRequestObservedOnNetwork: boolean;
  nativeSubmitCalled: boolean;
  requestSubmitCalled: boolean;
  formResetEventFired: boolean;
  formReplacedOrDetached: boolean;
  securityPolicyViolations: string[];
  challengeDetected: boolean;
  inFlightXhrAtSubmit: number | null;
  validationSurfaceAppeared: boolean;
  requiredAcknowledgementUncheckedIds: string[];
  requiredUncommittedFieldIds: string[];
}

export interface ClientSideCancellationClassification {
  attempt: number;
  /** Null when the attempt was not cancelled client-side: a business request reached the network or the attempt succeeded. */
  cancellationStage: CancellationStage | null;
  cancellationReason: string;
  evidence: ClientSideCancellationEvidence;
}

function endpointPattern(endpoint: string): string {
  try {
    const parsed = new URL(endpoint);
    const segments = parsed.pathname.split("/").map((segment) => (segment.length > 0 && /[\d@]|%40/.test(segment) ? "{param}" : segment));
    return `${parsed.origin}${segments.join("/")}`;
  } catch {
    return "unparseable-url";
  }
}

const TRANSPORT_RESOURCE_TYPE: Record<ProbeDispatch["transport"], string> = {
  fetch: "fetch",
  xhr: "xhr",
  beacon: "ping",
  native_form_submit: "document",
};

export function sanitizeProbeDispatches(dispatches: ProbeDispatch[], context: { pageUrl: string; formActionUrl: string | null }): SanitizedProbeDispatch[] {
  return dispatches.map((d) => {
    const pattern = endpointPattern(d.endpoint);
    const resourceType = TRANSPORT_RESOURCE_TYPE[d.transport];
    const { purpose } = classifyRequestPurpose({
      endpointPattern: pattern,
      resourceType,
      status: null,
      contentType: null,
      resultCategory: "unknown",
      structureElementNames: [],
      xmlRootElement: null,
    });
    const business = classifyBusinessRequest({ method: d.method, endpointPattern: pattern, resourceType, purpose }, context).tier === "primary";
    return { transport: d.transport, method: d.method, endpointPattern: pattern, businessCandidate: business, atMs: d.atMs };
  });
}

export interface ClassifyCancellationInput {
  attempt: number;
  probe: ProbeAttemptRecord | null;
  pageUrl: string;
  formActionUrl: string | null;
  businessRequestObservedOnNetwork: boolean;
  succeeded: boolean;
  challengeDetected: boolean;
  requiredAcknowledgementUncheckedIds: string[];
  requiredUncommittedFieldIds: string[];
}

/**
 * Names the earliest client-side stage the evidence proves the submission stopped at. The order is
 * the order a submission passes through: the click and the submit event, native validity, the
 * submit handlers (serialisation, then any other exception), the form being reset or replaced, then whether
 * a business dispatch was invoked at all. A pre-submit state gap (an unchecked required
 * acknowledgement, an uncommitted required control or a lookup still in flight) outranks the
 * generic "a handler prevented default" reading, because it is the concrete thing such a handler
 * rejects; a validation surface that newly appeared is evidence of a custom validator. Without any
 * of these the stage is reported as unknown, never guessed.
 */
export function classifyClientSideCancellation(input: ClassifyCancellationInput): ClientSideCancellationClassification {
  const p = input.probe;
  const dispatches = p ? sanitizeProbeDispatches(p.dispatches, { pageUrl: input.pageUrl, formActionUrl: input.formActionUrl }) : [];
  const businessDispatchInvoked = dispatches.some((d) => d.businessCandidate);
  const evidence: ClientSideCancellationEvidence = {
    probeAvailable: p !== null,
    submitClickReceived: p?.clickReceived ?? false,
    submitEventFired: p?.submitEventFired ?? false,
    submitEventCount: p?.submitEventCount ?? 0,
    submitterPresent: p?.submitterPresent ?? null,
    submitterMatchesClickedControl: p?.submitterMatchesControl ?? null,
    defaultPrevented: p?.defaultPrevented ?? null,
    submitEventReachedWindowBubble: p?.reachedWindowBubble ?? false,
    invalidEventCount: p?.invalidEventCount ?? 0,
    invalidFieldIds: p?.invalidFieldIds ?? [],
    handlerExceptionDuringDispatch: (p?.errors ?? []).some((e) => e.duringSubmitDispatch),
    errorsAfterSubmit: p?.errors ?? [],
    unhandledRejectionsAfterSubmit: p?.unhandledRejections ?? 0,
    serialisationObserved: (p?.formDataEventCount ?? 0) + (p?.serialiseCalls ?? 0) > 0,
    formDataEventCount: p?.formDataEventCount ?? 0,
    serialiseCalls: p?.serialiseCalls ?? 0,
    serialisationThrew: p?.serialiseThrew ?? false,
    dispatchInvocations: dispatches,
    businessDispatchInvoked,
    businessRequestObservedOnNetwork: input.businessRequestObservedOnNetwork,
    nativeSubmitCalled: p?.nativeSubmitCalled ?? false,
    requestSubmitCalled: p?.requestSubmitCalled ?? false,
    formResetEventFired: p?.resetEventFired ?? false,
    formReplacedOrDetached: p ? p.formReplaced || !p.formConnected : false,
    securityPolicyViolations: p?.securityPolicyViolations ?? [],
    challengeDetected: input.challengeDetected,
    inFlightXhrAtSubmit: p?.inFlightXhrAtSubmit ?? null,
    validationSurfaceAppeared: p ? p.errorLikeAfter > p.errorLikeBefore : false,
    requiredAcknowledgementUncheckedIds: input.requiredAcknowledgementUncheckedIds,
    requiredUncommittedFieldIds: input.requiredUncommittedFieldIds,
  };
  const result = (cancellationStage: CancellationStage | null, cancellationReason: string): ClientSideCancellationClassification => ({
    attempt: input.attempt,
    cancellationStage,
    cancellationReason,
    evidence,
  });

  if (input.succeeded || input.businessRequestObservedOnNetwork) {
    return result(null, "a business submission request reached the network or the attempt succeeded, so this was not a client-side cancellation");
  }
  if (!p) return result("unknown_client_side_cancellation", "the client-side probe was not available on this page, so no stage can be proven");
  if (input.challengeDetected || evidence.securityPolicyViolations.length > 0) {
    return result("anti_bot_or_security_block", input.challengeDetected ? "a challenge surface was detected after Submit" : "the page reported a content-security-policy violation after Submit");
  }
  const reset = evidence.formResetEventFired && p.resetBeforeDispatch;
  if (!evidence.submitEventFired && !businessDispatchInvoked) {
    if (evidence.invalidEventCount > 0) return result("native_validity_blocked", `the browser's constraint validation blocked submission (${evidence.invalidEventCount} invalid event(s)) before any submit event`);
    return result(
      "submit_event_never_fired",
      evidence.submitClickReceived ? "the Submit control received the click but the form never fired a submit event" : "the click never reached the Submit control and no submit event fired",
    );
  }
  if (evidence.serialisationThrew) return result("serialisation_failed", "serialising the form threw");
  if (evidence.handlerExceptionDuringDispatch || (evidence.unhandledRejectionsAfterSubmit > 0 && !businessDispatchInvoked)) {
    return result(
      "submit_handler_exception",
      evidence.handlerExceptionDuringDispatch ? "a submit handler threw while the submit event was being dispatched" : "an asynchronous submit step rejected without a business dispatch",
    );
  }
  if ((reset || evidence.formReplacedOrDetached) && !businessDispatchInvoked) {
    return result("form_reset_before_dispatch", reset ? "the form was reset before any dispatch" : "the form was replaced or detached before any dispatch");
  }
  if (businessDispatchInvoked) {
    return result("business_transport_not_observed", "the page invoked a business dispatch but no business request was observed on the network");
  }
  if (input.requiredAcknowledgementUncheckedIds.length > 0) {
    return result("required_acknowledgement_missing", `required acknowledgement checkbox(es) ${input.requiredAcknowledgementUncheckedIds.join(",")} were unchecked at Submit`);
  }
  if (input.requiredUncommittedFieldIds.length > 0) {
    return result("state_not_committed", `required control(s) ${input.requiredUncommittedFieldIds.join(",")} had no committed value at Submit`);
  }
  if ((evidence.inFlightXhrAtSubmit ?? 0) > 0) {
    return result("state_not_committed", `${evidence.inFlightXhrAtSubmit} page request(s) were still in flight when Submit fired, so a dependent value may not have been committed`);
  }
  if (evidence.validationSurfaceAppeared) {
    return result("custom_validation_rejected", "the submit was prevented and a new validation surface appeared in the form");
  }
  if (evidence.defaultPrevented === true && evidence.serialisationObserved) {
    return result("business_dispatch_not_invoked", "the form was serialised after the submit event but no business dispatch was invoked");
  }
  if (evidence.defaultPrevented === true) {
    return result("submit_handler_prevented_default", "a submit handler prevented the default action without serialising the form, dispatching, or showing a validation surface");
  }
  return result("unknown_client_side_cancellation", "the submit event was not prevented and no business request followed");
}

export interface SecondAttemptStateRefresh {
  fieldsRetagged: boolean;
  /** Required controls committed before the previous Submit and no longer committed before this one. */
  staleRequiredFieldIds: string[];
  refilledFieldIds: string[];
}

export interface SubmitCancellationAttempt {
  attempt: number;
  cancellationStage: CancellationStage | null;
  cancellationReason: string;
  evidence: ClientSideCancellationEvidence | null;
  stateRefreshBeforeAttempt: SecondAttemptStateRefresh | null;
  preSubmitSnapshot: ControlStateSnapshot[] | null;
  postCancellationSnapshot: ControlStateSnapshot[] | null;
}

export interface SubmitCancellationDiagnostics {
  probeInstalled: boolean;
  attempts: SubmitCancellationAttempt[];
  snapshotDifferences: SnapshotDifference[];
  acknowledgementCheckboxes: AcknowledgementCheckboxDiagnostic[];
}
