import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareDomAndValidatorState,
  deriveFieldState,
  siteRejectedFields,
  type FieldValidationState,
  type FormValidationStateCapture,
} from "../../src/actions/fieldValidationState.js";
import type { ControlStateSnapshot } from "../../src/actions/formStateSnapshot.js";
import { categoriseScript, classifyClientSideCancellation, type ProbeAttemptRecord } from "../../src/actions/submitCancellationProbe.js";

type RawField = Parameters<typeof deriveFieldState>[0];

function raw(overrides: Partial<RawField> = {}): RawField {
  return {
    fieldId: "1",
    safeName: "f",
    type: "text",
    stateTokens: [],
    errorIcon: null,
    errorMessagePresent: false,
    errorMessageLength: 0,
    ruleCategory: "none",
    ariaInvalid: "absent",
    dataStateAttributes: [],
    ...overrides,
  };
}

function capture(fields: FieldValidationState[], extra: Partial<FormValidationStateCapture> = {}): FormValidationStateCapture {
  return {
    capturedAt: "after_cancellation",
    fields,
    unattributedErrorSurfaces: [],
    form: { formStateTokens: [], formDataStateAttributes: [], noValidate: false, validatorLibraries: [], jqueryPresent: false, jqueryHandlers: null, jqueryValidator: null },
    ...extra,
  };
}

function control(overrides: Partial<ControlStateSnapshot>): ControlStateSnapshot {
  return {
    fieldId: "1",
    purpose: "unclassified",
    safeName: "f",
    type: "text",
    visible: true,
    enabled: true,
    readonly: false,
    requiredHtml: false,
    requiredAria: false,
    requiredClientMetadata: true,
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

test("derive: error evidence outranks a valid or pending class, and every signal is named", () => {
  const f = deriveFieldState(
    raw({
      stateTokens: [
        { token: "has-error", category: "error", location: "host" },
        { token: "is-valid", category: "valid", location: "control" },
        { token: "is-pending", category: "pending", location: "host" },
      ],
      errorIcon: "icon-wrong-field",
      ariaInvalid: "true",
    }),
    null,
  );
  assert.equal(f.validatorState, "invalid");
  assert.deepEqual(f.evidence, ["error_class", "error_icon", "aria_invalid"]);
  assert.equal(deriveFieldState(raw({ stateTokens: [{ token: "is-pending", category: "pending", location: "host" }] }), null).validatorState, "pending");
  assert.equal(deriveFieldState(raw({ stateTokens: [{ token: "ng-valid", category: "valid", location: "control" }] }), null).validatorState, "valid");
  assert.equal(deriveFieldState(raw(), null).validatorState, "unknown");
});

test("derive: a jQuery Validation instance's invalid map or error list marks the field even without a class", () => {
  const validator = { present: true, invalidFieldIds: ["1"], errorListFieldIds: [], pendingRequestCount: 0, pendingFieldIds: [], submittedFieldCount: 1 };
  const f = deriveFieldState(raw(), validator);
  assert.equal(f.validatorState, "invalid");
  assert.equal(f.jqueryValidatorInvalid, true);
  assert.deepEqual(f.evidence, ["jquery_validator_invalid"]);
  assert.equal(deriveFieldState(raw({ fieldId: "2" }), validator).jqueryValidatorInvalid, false);
  assert.equal(deriveFieldState(raw(), null).jqueryValidatorInvalid, null);
});

test("derive: touched state comes from touched/untouched tokens, untouched winning", () => {
  const t = (category: "touched" | "untouched", token: string) => ({ token, category, location: "host" as const });
  assert.equal(deriveFieldState(raw({ stateTokens: [t("touched", "ng-touched")] }), null).touchedState, "touched");
  assert.equal(deriveFieldState(raw({ stateTokens: [t("untouched", "ng-untouched")] }), null).touchedState, "untouched");
  assert.equal(deriveFieldState(raw(), null).touchedState, "unknown");
});

test("compare (test 10): a field committed in the DOM that the site marks invalid is a disagreement; an uncommitted one it marks invalid agrees", () => {
  const fields = [
    deriveFieldState(raw({ fieldId: "1", stateTokens: [{ token: "has-error", category: "error", location: "host" }] }), null),
    deriveFieldState(raw({ fieldId: "2", stateTokens: [{ token: "has-error", category: "error", location: "host" }] }), null),
    deriveFieldState(raw({ fieldId: "3", stateTokens: [{ token: "is-valid", category: "valid", location: "host" }] }), null),
  ];
  const rows = compareDomAndValidatorState(
    [control({ fieldId: "1" }), control({ fieldId: "2", committed: false, populated: false }), control({ fieldId: "3", committed: false, populated: false })],
    capture(fields),
    false,
  );
  assert.deepEqual(
    rows.map((r) => [r.fieldId, r.stateAgreement, r.disagreementReason]),
    [
      ["1", "disagree", "committed in the DOM but the site marks it invalid"],
      ["2", "agree", null],
      ["3", "disagree", "the site marks it valid but no value is committed in the DOM"],
    ],
  );
});

test("compare (test 11): a hidden duplicate radio group is compared once by name, and hidden inputs, stand-ins and buttons are skipped", () => {
  const rows = compareDomAndValidatorState(
    [
      control({ fieldId: "1", type: "radio", safeName: "customerType", checkedCategory: "checked" }),
      control({ fieldId: "2", type: "radio", safeName: "customerType", checkedCategory: "unchecked" }),
      control({ fieldId: "3", type: "radio", safeName: "customerType", visible: false, checkedCategory: "unchecked" }),
      control({ fieldId: "4", type: "hidden", visible: false }),
      control({ fieldId: "5", proxyRole: "select_proxy" }),
      control({ fieldId: "6", type: "submit" }),
    ],
    capture([]),
    false,
  );
  assert.deepEqual(rows.map((r) => r.fieldId), ["1"]);
});

test("compare (test 12): a conditional field hidden by the customer-type choice is not compared, a visible required one is", () => {
  const rows = compareDomAndValidatorState(
    [control({ fieldId: "8", safeName: "companyName", visible: false, committed: false }), control({ fieldId: "9", safeName: "postcode" })],
    capture([deriveFieldState(raw({ fieldId: "8", stateTokens: [{ token: "has-error", category: "error", location: "host" }] }), null)]),
    false,
  );
  assert.deepEqual(rows.map((r) => r.fieldId), ["9"]);
  assert.equal(rows[0]!.stateAgreement, "unknown");
});

test("compare (tests 5, 6, 13): a page request in flight at Submit makes the async state pending; a validator instance's list decides the application state", () => {
  const validator = { present: true, invalidFieldIds: ["13"], errorListFieldIds: [], pendingRequestCount: 0, pendingFieldIds: [], submittedFieldCount: 1 };
  const rows = compareDomAndValidatorState(
    [control({ fieldId: "13", type: "checkbox", checkedCategory: "checked" }), control({ fieldId: "14" })],
    capture([deriveFieldState(raw({ fieldId: "13" }), validator), deriveFieldState(raw({ fieldId: "14" }), validator)], {
      form: { formStateTokens: [], formDataStateAttributes: [], noValidate: false, validatorLibraries: ["jquery_validate"], jqueryPresent: true, jqueryHandlers: null, jqueryValidator: validator },
    }),
    true,
  );
  assert.equal(rows[0]!.applicationStateCommitted, false);
  assert.equal(rows[0]!.stateAgreement, "disagree");
  assert.equal(rows[1]!.applicationStateCommitted, true);
  assert.ok(rows.every((r) => r.asyncValidationState === "pending"));
});

test("rejected fields: marks whether the site already flagged the field before Submit (test 14: a committed acknowledgement is not listed)", () => {
  const err = [{ token: "has-error", category: "error" as const, location: "host" as const }];
  const before = capture([deriveFieldState(raw({ fieldId: "1", stateTokens: err }), null), deriveFieldState(raw({ fieldId: "24", type: "checkbox" }), null)], { capturedAt: "before_submit" });
  const after = capture([
    deriveFieldState(raw({ fieldId: "1", stateTokens: err, ruleCategory: "format", errorMessagePresent: true, errorMessageLength: 12 }), null),
    deriveFieldState(raw({ fieldId: "2", stateTokens: err }), null),
    deriveFieldState(raw({ fieldId: "24", type: "checkbox" }), null),
  ]);
  const rejected = siteRejectedFields(before, after, new Map([["1", "email"]]));
  assert.deepEqual(
    rejected.map((r) => [r.fieldId, r.purpose, r.ruleCategory, r.markedBeforeSubmit]),
    [
      ["1", "email", "format", true],
      ["2", "unclassified", "none", false],
    ],
  );
  assert.deepEqual(siteRejectedFields(null, null, new Map()), []);
});

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
    errorLikeBefore: 1,
    errorLikeAfter: 1,
    formConnected: true,
    formReplaced: false,
    inFlightXhrNow: 0,
    ...overrides,
  };
}

const base = {
  attempt: 1,
  pageUrl: "https://www.example-automotive-oem.com/forms/lead.html",
  formActionUrl: "https://forms.example-automotive-oem.com/index/postajax",
  businessRequestObservedOnNetwork: false,
  succeeded: false,
  challengeDetected: false,
  requiredAcknowledgementUncheckedIds: [],
  requiredUncommittedFieldIds: [],
};

test("classifier (test 22): a field the site still marks invalid makes a second, surface-unchanged attempt custom_validation_rejected rather than a bare preventDefault", () => {
  const without = classifyClientSideCancellation({ ...base, probe: probe() });
  assert.equal(without.cancellationStage, "submit_handler_prevented_default");
  const withField = classifyClientSideCancellation({
    ...base,
    probe: probe(),
    siteValidation: { rejectedFields: [{ fieldId: "6", purpose: "email", ruleCategory: "format", markedBeforeSubmit: true }], unattributedErrorSurfaceCount: 0 },
  });
  assert.equal(withField.cancellationStage, "custom_validation_rejected");
  assert.match(withField.cancellationReason, /6 \(email, format rule, already marked before Submit\)/);
  assert.deepEqual(withField.evidence.siteRejectedFieldIds, ["6"]);
});

test("classifier: a required gap still outranks the site's field marks, and nothing changes when the submit was not prevented", () => {
  const siteValidation = { rejectedFields: [{ fieldId: "6", purpose: "email", ruleCategory: "none", markedBeforeSubmit: false }], unattributedErrorSurfaceCount: 2 };
  assert.equal(classifyClientSideCancellation({ ...base, probe: probe(), requiredUncommittedFieldIds: ["2"], siteValidation }).cancellationStage, "state_not_committed");
  assert.equal(classifyClientSideCancellation({ ...base, probe: probe({ defaultPrevented: false }), siteValidation }).cancellationStage, "unknown_client_side_cancellation");
});

test("classifier: preventDefault frames are reduced to script origin + path, categorised, and a cancellation with no recorded call is flagged", () => {
  const r = classifyClientSideCancellation({
    ...base,
    probe: probe({
      probeMode: "full",
      preventDefaultCalls: [
        {
          eventType: "submit",
          phase: "bubble",
          currentTarget: "document",
          atMs: 2,
          frames: [{ functionName: "jqDispatch", script: "https://cdn.example-thirdparty.com/libs/jquery-3.7.1.min.js", line: 2, column: 40211 }],
        },
      ],
    }),
  });
  const frame = r.evidence.preventDefaultCalls![0]!.frames[0]!;
  assert.equal(frame.library, "jquery");
  assert.equal(frame.scriptCategory, "third_party");
  assert.equal(frame.scriptPattern, "https://cdn.example-thirdparty.com/libs/{param}");
  assert.equal(r.evidence.defaultPreventedWithoutRecordedCall, false);
  const inline = classifyClientSideCancellation({ ...base, probe: probe({ probeMode: "full", preventDefaultCalls: [] }) });
  assert.equal(inline.evidence.defaultPreventedWithoutRecordedCall, true);
  const passive = classifyClientSideCancellation({ ...base, probe: probe({ probeMode: "passive" }) });
  assert.equal(passive.evidence.callRecordersActive, false);
  assert.equal(passive.evidence.defaultPreventedWithoutRecordedCall, null);
});

test("script categorisation: the page's own inline script, a same-site bundle and a tag manager are told apart", () => {
  const page = "https://www.example-automotive-oem.com/lp/forms.html";
  assert.equal(categoriseScript(page, page).scriptCategory, "page_inline");
  assert.equal(categoriseScript("https://forms.example-automotive-oem.com/js/app.js", page).scriptCategory, "same_site");
  assert.equal(categoriseScript("https://www.googletagmanager.com/gtm.js", page).library, "tag_manager");
  assert.equal(categoriseScript("", page).scriptPattern, "inline_or_eval");
});
