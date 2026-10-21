import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { SubmissionObservationConfig } from "../../src/actions/submissionObserver.js";
import type { SubmitCancellationAttempt, SubmitCancellationDiagnostics } from "../../src/actions/submitCancellationProbe.js";
import { FIXED_FIELDS, marketDataFor } from "../../src/forms/testData.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

function validateSubmitCancellationDiagnostics(value: unknown): void {
  const schema = JSON.parse(readFileSync(join(__dirname, "..", "..", "schemas", "task-response.schema.json"), "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/actionResult/properties/formPostSubmitDiagnostics/properties/submitCancellationDiagnostics`);
  assert.ok(validate, "sub-schema not found");
  assert.ok(validate(value), ajv.errorsText(validate.errors));
}

const FAST: SubmissionObservationConfig = { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 3_000, pollIntervalMs: 100 };

interface Outcome {
  result: Awaited<ReturnType<typeof executeFillForm>>;
  page: Page;
  businessHits: number;
  submitCount: number;
  honeypotValue: string | null;
  pageFunctionsUntouched: boolean;
}

async function run<T>(query: Record<string, string>, check: (outcome: Outcome) => Promise<T> | T): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let businessHits = 0;
    await page.route("**/api/lead", async (route: Route) => {
      businessHits += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {});
    });
    await page.goto(`${baseUrl}/lead-form-site-validator.html?${new URLSearchParams(query).toString()}`);
    const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], submissionObservationConfig: FAST });
    const state = await page
      .evaluate(() => {
        const w = window as unknown as { __submitCount: number; __pageFetch: unknown; __pagePreventDefault: unknown };
        const hp = document.querySelector("#website") as HTMLInputElement | null;
        return {
          submitCount: w.__submitCount,
          honeypotValue: hp ? hp.value : null,
          pageFunctionsUntouched: window.fetch === w.__pageFetch && Event.prototype.preventDefault === w.__pagePreventDefault,
        };
      })
      .catch(() => ({ submitCount: -1, honeypotValue: null, pageFunctionsUntouched: false }));
    return await check({ result, page, businessHits, ...state });
  } finally {
    await browser?.close();
    await close();
  }
}

const diagnostics = (result: Outcome["result"]): SubmitCancellationDiagnostics => result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!;
const first = (result: Outcome["result"]): SubmitCancellationAttempt => diagnostics(result).attempts[0]!;
const fieldByName = (a: SubmitCancellationAttempt, name: string, when: "before" | "after" = "after") =>
  (when === "after" ? a.fieldValidationAfterCancellation : a.fieldValidationBeforeSubmit)!.fields.find((f) => f.safeName === name);

async function withProbeMode<T>(mode: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.SUBMIT_PROBE_MODE;
  process.env.SUBMIT_PROBE_MODE = mode;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.SUBMIT_PROBE_MODE;
    else process.env.SUBMIT_PROBE_MODE = previous;
  }
}

test("site validator 1 (tests 1, 2, 22): a silent custom reject that only marks a field's row names the rejected field from its error class and icon", async () => {
  await run({ v: "silent_class" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 0);
    const a = first(result);
    assert.equal(a.cancellationStage, "custom_validation_rejected");
    const email = fieldByName(a, "email")!;
    assert.equal(email.validatorState, "invalid");
    assert.ok(email.evidence.includes("error_class"), email.evidence.join(","));
    assert.equal(email.errorIcon, "icon-wrong-field");
    assert.equal(email.ruleCategory, "none");
    assert.equal(fieldByName(a, "email", "before")!.validatorState, "unknown");
    const rejected = a.siteRejectedFields!;
    assert.deepEqual(rejected.map((f) => f.safeName), ["email"]);
    assert.equal(rejected[0]!.purpose, "email");
    assert.equal(rejected[0]!.markedBeforeSubmit, false);
    assert.match(a.cancellationReason, /marks field\(s\) .*\(email, no message\) invalid/);
    assert.deepEqual(a.evidence!.siteRejectedFieldIds, [email.fieldId]);
  });
});

test("site validator 2 (tests 2, 27): a field message gives its rule category and length, never its text", async () => {
  await run({ v: "message" }, ({ result }) => {
    const a = first(result);
    const email = fieldByName(a, "email")!;
    assert.equal(email.errorMessagePresent, true);
    assert.equal(email.errorMessageLength, "Adresse e-mail invalide".length);
    assert.equal(email.ruleCategory, "format");
    const text = JSON.stringify(diagnostics(result));
    assert.ok(!text.includes("Adresse e-mail invalide"));
    const fixed = FIXED_FIELDS as unknown as Record<string, string>;
    for (const value of [fixed.firstName, fixed.lastName, fixed.email, marketDataFor("FR").postcode, "fixture-token"]) assert.ok(!text.includes(value!), `diagnostics leak ${value}`);
  });
});

test("site validator 3 (test 3): an error count outside every field is reported as unattributed, not guessed onto a field", async () => {
  await run({ v: "count_only" }, ({ result }) => {
    const a = first(result);
    assert.equal(a.cancellationStage, "custom_validation_rejected");
    assert.deepEqual(a.siteRejectedFields, []);
    const surfaces = a.fieldValidationAfterCancellation!.unattributedErrorSurfaces;
    assert.equal(surfaces.length, 1);
    assert.equal(surfaces[0]!.ruleCategory, "unspecified");
    assert.ok(surfaces[0]!.stateTokens.some((t) => t.token === "form-errors" && t.category === "error"));
    assert.equal(surfaces[0]!.nearestPrecedingFieldId, fieldByName(a, "email")!.fieldId);
    assert.match(a.cancellationReason, /1 error surface\(s\) .* not attributable/);
  });
});

test("site validator 4 (tests 4, 5): a jQuery Validation instance with a pending remote rule is read without running it, and the field shows as pending", async () => {
  await run({ v: "jquery_pending" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 0);
    const a = first(result);
    const v = a.fieldValidationBeforeSubmit!.form.jqueryValidator!;
    assert.equal(v.pendingRequestCount, 1);
    const email = fieldByName(a, "email", "before")!;
    assert.deepEqual(v.pendingFieldIds, [email.fieldId]);
    assert.equal(email.jqueryValidatorPending, true);
    assert.equal(email.validatorState, "pending");
    const cmp = a.fieldStateComparison!.find((c) => c.safeName === "email")!;
    assert.equal(cmp.asyncValidationState, "pending");
    assert.equal(cmp.stateAgreement, "disagree");
    assert.ok(a.fieldValidationBeforeSubmit!.form.validatorLibraries.length === 0);
    assert.equal(a.fieldValidationBeforeSubmit!.form.jqueryHandlers!.delegatedSubmitOnAncestors, 1);
  });
});

test("site validator 5 (test 7, 10): a required select committed in the DOM but never touched by the validator is a DOM/validator disagreement", async () => {
  await run({ v: "untouched_reject", civility: "proxy" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 0);
    const a = first(result);
    const civ = fieldByName(a, "civility")!;
    assert.equal(civ.validatorState, "invalid");
    assert.equal(civ.touchedState, "untouched");
    const cmp = a.fieldStateComparison!.find((c) => c.safeName === "civility")!;
    assert.equal(cmp.domCommitted, true);
    assert.equal(cmp.stateAgreement, "disagree");
    assert.equal(cmp.disagreementReason, "committed in the DOM but the site marks it invalid");
    assert.deepEqual(a.siteRejectedFields!.map((f) => f.safeName), ["civility"]);
    assert.ok(fieldByName(a, "firstName")!.touchedState === "touched");
  });
});

test("site validator 6 (tests 8, 9): a validator that counts a change or a blur as touched accepts the engine's fill", async () => {
  await run({ v: "change_touched", civility: "proxy" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(first(result).cancellationStage, null);
  });
  await run({ v: "blur_touched" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(first(result).cancellationStage, null);
  });
});

test("site validator 7 (tests 18, 19): the Submit click and the submit event are trusted, carry the real submitter and the cancelling call is located", async () => {
  await run({ v: "silent_class" }, ({ result }) => {
    const e = first(result).evidence!;
    assert.equal(e.clickEventTrusted, true);
    assert.equal(e.submitEventTrusted, true);
    assert.equal(e.submitterMatchesClickedControl, true);
    const call = e.preventDefaultCalls!.find((c) => c.eventType === "submit")!;
    assert.equal(call.currentTarget, "form");
    assert.equal(call.phase, "target");
    assert.match(call.frames[0]!.functionName, /validateLeadForm$/);
    assert.match(call.frames[0]!.scriptPattern, /\/validator-lib\/site-validator\.js$/);
    assert.equal(call.frames[0]!.scriptCategory, "same_site");
    assert.equal(e.defaultPreventedWithoutRecordedCall, false);
  });
});

test("site validator 8 (Phase 1): the listener inventory names the cancelling listener, its layer, phase and script location -- never its body", async () => {
  await run({ v: "silent_class" }, ({ result }) => {
    const inv = diagnostics(result).submitListenerInventory!;
    assert.equal(inv.available, true);
    const submit = inv.listeners.find((l) => l.target === "form" && l.type === "submit")!;
    assert.equal(submit.layer, "native");
    assert.equal(submit.functionName, "validateLeadForm");
    assert.match(submit.scriptPattern, /site-validator\.js$/);
    assert.ok(Number.isInteger(submit.line));
    assert.ok(!inv.listeners.some((l) => l.functionName.startsWith("navEngineProbe")));
    assert.ok(!JSON.stringify(inv).includes("preventDefault()"));
  });
  await run({ v: "jquery_pending" }, ({ result }) => {
    const inv = diagnostics(result).submitListenerInventory!;
    const delegated = inv.listeners.find((l) => l.layer === "jquery_delegated" && l.type === "submit")!;
    assert.equal(delegated.target, "document");
    assert.equal(delegated.functionName, "validateLeadForm");
    assert.match(delegated.scriptPattern, /site-validator\.js$/);
    const dispatcher = inv.listeners.find((l) => l.layer === "native" && l.target === "document" && l.type === "submit")!;
    assert.equal(dispatcher.library, "jquery");
    const call = first(result).evidence!.preventDefaultCalls!.find((c) => c.eventType === "submit")!;
    assert.equal(call.frames[0]!.library, "jquery");
    assert.equal(call.currentTarget, "document");
  });
});

test("site validator 9 (tests 17, 16, 15): a proprietary form flag, the CSRF hidden field and an empty honeypot are all visible", async () => {
  await run({ v: "silent_class", honeypot: "1" }, ({ result, honeypotValue }) => {
    const a = first(result);
    assert.deepEqual(a.fieldValidationAfterCancellation!.form.formDataStateAttributes, [{ name: "data-form-valid", valueCategory: "false", location: "form" }]);
    assert.equal(a.fieldValidationBeforeSubmit!.form.formDataStateAttributes.length, 0);
    assert.equal(a.fieldValidationAfterCancellation!.form.noValidate, true);
    assert.equal(honeypotValue, "");
    const csrf = a.preSubmitSnapshot!.find((c) => c.safeName === "csrf_token")!;
    assert.equal(csrf.committed, true);
    assert.equal(csrf.includedInSerialisation, true);
  });
});

test("site validator 10 (tests 20, 21): passive mode replaces no page function and still classifies; a page-wrapped fetch is reported and still recorded in full mode", async () => {
  await withProbeMode("passive", () =>
    run({ v: "silent_class" }, ({ result, pageFunctionsUntouched }) => {
      assert.equal(pageFunctionsUntouched, true);
      const d = diagnostics(result);
      assert.equal(d.probeMode, "passive");
      const a = first(result);
      assert.equal(a.evidence!.callRecordersActive, false);
      assert.deepEqual(a.evidence!.preventDefaultCalls, []);
      assert.equal(a.evidence!.defaultPreventedWithoutRecordedCall, null);
      assert.equal(a.cancellationStage, "custom_validation_rejected");
    }),
  );
  await run({ v: "silent_class" }, ({ result, pageFunctionsUntouched }) => {
    assert.equal(pageFunctionsUntouched, false);
    assert.equal(diagnostics(result).probeMode, "full");
  });
  await run({ v: "ok", prewrap: "1" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    const e = first(result).evidence!;
    assert.deepEqual(e.pageWrappedTransports, ["fetch"]);
    assert.ok(e.dispatchInvocations.some((d) => d.transport === "fetch" && d.businessCandidate));
    assert.equal(first(result).cancellationStage, null);
  });
});

test("site validator 11 (tests 23, 24, 25, 26): no business request is never success; an accepted request with a same-page confirmation is, and no extra attempt follows", async () => {
  await run({ v: "silent_class" }, ({ result, submitCount }) => {
    assert.notEqual(result.formPostSubmitDiagnostics!.submissionOutcome, "succeeded");
    assert.ok(diagnostics(result).attempts.length <= 2);
    assert.ok(submitCount <= 2);
  });
  await run({ v: "ok" }, ({ result, businessHits, submitCount }) => {
    assert.equal(businessHits, 1);
    assert.equal(submitCount, 1);
    assert.equal(diagnostics(result).attempts.length, 1);
    assert.equal(diagnostics(result).submitListenerInventory, null);
  });
});

test("site validator 12 (test 29): the response with the new diagnostics validates against the response schema", async () => {
  const queries: Record<string, string>[] = [{ v: "jquery_pending", civility: "proxy" }, { v: "message" }, { v: "count_only" }];
  for (const query of queries) {
    await run(query, ({ result }) => {
      validateSubmitCancellationDiagnostics(JSON.parse(JSON.stringify(diagnostics(result))));
    });
  }
});
