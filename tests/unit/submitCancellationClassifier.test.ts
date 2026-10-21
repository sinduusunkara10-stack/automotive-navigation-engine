import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyClientSideCancellation, CANCELLATION_STAGES, type ProbeAttemptRecord } from "../../src/actions/submitCancellationProbe.js";
import { buildFillPlan, isFillTarget, type FormFieldDescriptor } from "../../src/forms/fillPlan.js";
import { diffSnapshots, requiredUncommitted, type ControlStateSnapshot } from "../../src/actions/formStateSnapshot.js";

const PAGE = "https://www.example-automotive-oem.com/forms/test-drive";
const ACTION = "https://forms.example-automotive-oem.com/index/postajax";

function probe(overrides: Partial<ProbeAttemptRecord> = {}): ProbeAttemptRecord {
  return {
    attempt: 1,
    clickReceived: true,
    clickAt: 1000,
    submitEventFired: true,
    submitEventCount: 1,
    otherFormSubmitEvents: 0,
    submitterPresent: true,
    submitterMatchesControl: true,
    defaultPrevented: true,
    reachedWindowBubble: true,
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
    inFlightXhrAtSubmit: 0,
    errorLikeBefore: 0,
    errorLikeAfter: 0,
    formConnected: true,
    formReplaced: false,
    inFlightXhrNow: 0,
    ...overrides,
  };
}

function classify(p: ProbeAttemptRecord | null, extra: Partial<Parameters<typeof classifyClientSideCancellation>[0]> = {}) {
  return classifyClientSideCancellation({
    attempt: 1,
    probe: p,
    pageUrl: PAGE,
    formActionUrl: ACTION,
    businessRequestObservedOnNetwork: false,
    succeeded: false,
    challengeDetected: false,
    requiredAcknowledgementUncheckedIds: [],
    requiredUncommittedFieldIds: [],
    ...extra,
  });
}

test("classifier: every terminal stage is reachable from its own evidence", () => {
  const cases: [string, ReturnType<typeof classify>][] = [
    ["submit_event_never_fired", classify(probe({ submitEventFired: false, submitEventCount: 0, defaultPrevented: null }))],
    ["native_validity_blocked", classify(probe({ submitEventFired: false, invalidEventCount: 2, invalidFieldIds: ["4"] }))],
    ["custom_validation_rejected", classify(probe({ errorLikeAfter: 2 }))],
    ["required_acknowledgement_missing", classify(probe(), { requiredAcknowledgementUncheckedIds: ["30"] })],
    ["state_not_committed", classify(probe(), { requiredUncommittedFieldIds: ["2"] })],
    ["submit_handler_prevented_default", classify(probe())],
    ["submit_handler_exception", classify(probe({ errors: [{ name: "TypeError", source: "same_origin", duringSubmitDispatch: true, atMs: 3 }] }))],
    ["serialisation_failed", classify(probe({ serialiseCalls: 1, serialiseThrew: true, errors: [{ name: "Error", source: "same_origin", duringSubmitDispatch: true, atMs: 3 }] }))],
    ["business_dispatch_not_invoked", classify(probe({ formDataEventCount: 1 }))],
    ["business_transport_not_observed", classify(probe({ dispatches: [{ transport: "xhr", method: "POST", endpoint: ACTION, atMs: 12 }] }))],
    ["form_reset_before_dispatch", classify(probe({ resetEventFired: true, resetBeforeDispatch: true }))],
    ["anti_bot_or_security_block", classify(probe(), { challengeDetected: true })],
    ["unknown_client_side_cancellation", classify(probe({ defaultPrevented: false }))],
  ];
  assert.deepEqual(cases.map(([stage]) => stage).sort(), [...CANCELLATION_STAGES].sort());
  for (const [stage, result] of cases) assert.equal(result.cancellationStage, stage, result.cancellationReason);
});

test("classifier: a business request on the network or a success is never called a cancellation", () => {
  assert.equal(classify(probe(), { businessRequestObservedOnNetwork: true }).cancellationStage, null);
  assert.equal(classify(probe(), { succeeded: true }).cancellationStage, null);
});

test("classifier: no probe means the stage cannot be proven", () => {
  assert.equal(classify(null).cancellationStage, "unknown_client_side_cancellation");
  assert.equal(classify(null).evidence.probeAvailable, false);
});

test("classifier: a click that never reached the Submit control is reported as such", () => {
  const r = classify(probe({ clickReceived: false, submitEventFired: false }));
  assert.equal(r.cancellationStage, "submit_event_never_fired");
  assert.match(r.cancellationReason, /never reached/);
});

test("classifier: a tracking beacon or third-party call is not a business dispatch", () => {
  const r = classify(
    probe({
      formDataEventCount: 1,
      dispatches: [
        { transport: "beacon", method: "POST", endpoint: "https://analytics.example-tracker.com/collect", atMs: 2 },
        { transport: "fetch", method: "POST", endpoint: "https://cdn.example-thirdparty.com/form/ab-test", atMs: 4 },
      ],
    }),
  );
  assert.equal(r.evidence.businessDispatchInvoked, false);
  assert.equal(r.cancellationStage, "business_dispatch_not_invoked");
  assert.ok(r.evidence.dispatchInvocations.every((d) => !d.endpointPattern.includes("?")));
});

test("classifier: a pending lookup at Submit outranks the generic preventDefault reading (tests 21, 22)", () => {
  assert.equal(classify(probe({ inFlightXhrAtSubmit: 1 })).cancellationStage, "state_not_committed");
});

test("classifier: a dispatch invoked before a later reset is still a dispatch, not a reset", () => {
  const r = classify(probe({ resetEventFired: true, resetBeforeDispatch: false, dispatches: [{ transport: "fetch", method: "POST", endpoint: ACTION, atMs: 5 }] }));
  assert.equal(r.cancellationStage, "business_transport_not_observed");
});

test("classifier: digit and e-mail-shaped path segments of a dispatch endpoint are masked", () => {
  const r = classify(probe({ dispatches: [{ transport: "xhr", method: "POST", endpoint: "https://www.example-automotive-oem.com/lead/123456/send", atMs: 5 }] }));
  assert.equal(r.evidence.dispatchInvocations[0]!.endpointPattern, "https://www.example-automotive-oem.com/lead/{param}/send");
  const mail = classify(probe({ dispatches: [{ transport: "fetch", method: "GET", endpoint: "https://www.example-automotive-oem.com/check/someone%40example.com", atMs: 5 }] }));
  assert.equal(mail.evidence.dispatchInvocations[0]!.endpointPattern, "https://www.example-automotive-oem.com/check/{param}");
});

function descriptor(overrides: Partial<FormFieldDescriptor>): FormFieldDescriptor {
  return { id: "0", tagName: "input", type: "text", required: false, visible: true, currentValue: "", ...overrides };
}

test("fill plan: the live form's shape -- a marker-required hidden civility select with a visible readonly stand-in -- is filled through the stand-in and gated as required", () => {
  const select = descriptor({
    id: "2",
    tagName: "select",
    type: undefined,
    label: "Civilité*",
    required: true,
    requiredEvidence: "marker",
    visible: false,
    selectProxyKind: "readonly_input",
    options: [
      { value: "", label: "" },
      { value: "1", label: "M." },
      { value: "2", label: "Mme" },
    ],
  });
  const proxy = descriptor({ id: "3", label: "M.Mme", visible: true, isSelectProxy: true });
  const plan = buildFillPlan([select, proxy], { language: "fr", market: "FR", hasCountryCodeSelector: false });
  assert.equal(plan[0]!.decision.kind, "choose_first_valid_option");
  assert.deepEqual(plan[1]!.decision, { kind: "skip", reason: "select_proxy" });
  assert.equal(isFillTarget(select), true);
  assert.equal(isFillTarget(proxy), false);
});

test("fill plan: hidden selects without a stand-in, optional proxied selects and dealer selects keep the old hidden handling", () => {
  const ctx = { language: "fr" as const, market: "FR" as const, hasCountryCodeSelector: false };
  const opts = [
    { value: "", label: "" },
    { value: "a", label: "A" },
  ];
  const noProxy = descriptor({ tagName: "select", type: undefined, label: "Civilité*", required: true, visible: false, options: opts });
  const optional = descriptor({ tagName: "select", type: undefined, label: "Civilité", required: false, visible: false, selectProxyKind: "combobox", options: opts });
  const dealer = descriptor({ tagName: "select", type: undefined, label: "Concessionnaire*", required: true, visible: false, selectProxyKind: "combobox", options: opts });
  for (const d of [noProxy, optional, dealer]) {
    assert.deepEqual(buildFillPlan([d], ctx)[0]!.decision, { kind: "skip", reason: "hidden" }, d.label);
    assert.equal(isFillTarget(d), false, d.label);
  }
});

function control(overrides: Partial<ControlStateSnapshot>): ControlStateSnapshot {
  return {
    fieldId: "0",
    purpose: "unclassified",
    safeName: null,
    type: "text",
    visible: true,
    enabled: true,
    readonly: false,
    requiredHtml: false,
    requiredAria: false,
    requiredClientMetadata: false,
    populated: true,
    checkedCategory: "not_applicable",
    committed: true,
    includedInSerialisation: true,
    validityCategory: "valid",
    validationMessagePresent: false,
    proxyRole: null,
    checkbox: null,
    ...overrides,
  };
}

test("snapshot: a required hidden select behind a stand-in that has no value is uncommitted; hidden inputs, stand-ins and optional controls are not", () => {
  const controls = [
    control({ fieldId: "2", type: "select", visible: false, requiredClientMetadata: true, populated: false, committed: false, proxyRole: "proxied_select" }),
    control({ fieldId: "3", readonly: true, requiredClientMetadata: true, committed: false, proxyRole: "select_proxy" }),
    control({ fieldId: "9", type: "hidden", visible: false, requiredHtml: true, committed: false }),
    control({ fieldId: "10", committed: false }),
    control({ fieldId: "11", requiredHtml: true, visible: false, committed: false }),
  ];
  assert.deepEqual(requiredUncommitted(controls), ["2"]);
});

test("snapshot: differences report only categorical changes and a field that disappeared", () => {
  const before = [control({ fieldId: "1", committed: true }), control({ fieldId: "2" })];
  const after = [control({ fieldId: "1", committed: false, populated: false })];
  const diffs = diffSnapshots("a_vs_b", before, after);
  assert.deepEqual(
    diffs.map((d) => `${d.fieldId}:${d.property}:${d.from}->${d.to}`).sort(),
    ["1:committed:true->false", "1:populated:true->false", "2:present:true->false"],
  );
});
