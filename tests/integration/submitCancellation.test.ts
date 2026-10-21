import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { SubmissionObservationConfig } from "../../src/actions/submissionObserver.js";
import type { SubmitCancellationAttempt } from "../../src/actions/submitCancellationProbe.js";
import { FIXED_FIELDS, marketDataFor } from "../../src/forms/testData.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const FAST: SubmissionObservationConfig = { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 3_000, pollIntervalMs: 100 };

type Query = Record<string, string>;

interface Outcome {
  result: Awaited<ReturnType<typeof executeFillForm>>;
  page: Page;
  businessHits: number;
  submitCount: number;
  civilityValue: string | null;
  civilityDisplay: string | null;
  ackChecked: boolean | null;
}

async function run<T>(query: Query, check: (outcome: Outcome) => Promise<T> | T, options: { flag?: boolean } = {}): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let businessHits = 0;
    await page.route("**/api/lead", async (route: Route) => {
      businessHits += 1;
      const html = route.request().resourceType() === "document";
      await route
        .fulfill(html ? { status: 200, contentType: "text/html", body: "<!doctype html><title>Merci</title><p>Merci</p>" } : { status: 200, contentType: "application/json", body: "{}" })
        .catch(() => {});
    });
    await page.route("**/api/email-check", async (route: Route) => {
      await new Promise((r) => setTimeout(r, 6_000));
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {});
    });
    await page.route("**/api/dealer-lookup", async (route: Route) => {
      await new Promise((r) => setTimeout(r, 6_000));
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" }).catch(() => {});
    });
    await page.goto(`${baseUrl}/lead-form-submit-cancellation.html?${new URLSearchParams(query).toString()}`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      submissionObservationConfig: FAST,
      optionalConsentOptInFallbackForTest: options.flag === true,
    });
    const state = await page
      .evaluate(() => {
        const select = document.querySelector('select[name="civility"]') as HTMLSelectElement | null;
        const display = document.querySelector(".custom-select-display") as HTMLInputElement | null;
        const ackBox = document.querySelector("#ack") as HTMLInputElement | null;
        return {
          submitCount: (window as unknown as { __submitCount: number }).__submitCount,
          civilityValue: select ? select.value : null,
          civilityDisplay: display ? display.value : null,
          ackChecked: ackBox ? ackBox.checked : null,
        };
      })
      .catch(() => ({ submitCount: -1, civilityValue: null, civilityDisplay: null, ackChecked: null }));
    return await check({ result, page, businessHits, ...state });
  } finally {
    await browser?.close();
    await close();
  }
}

const attempts = (result: Outcome["result"]): SubmitCancellationAttempt[] => result.formPostSubmitDiagnostics?.submitCancellationDiagnostics?.attempts ?? [];
const stageOf = (result: Outcome["result"], n = 1) => attempts(result)[n - 1]?.cancellationStage;

test("cancellation 1: a required hidden native select behind a visible custom control is committed through the control, and the business request follows", async () => {
  await run({ civility: "proxy", scenario: "ok_xhr" }, ({ result, businessHits, civilityValue, civilityDisplay }) => {
    assert.equal(civilityValue, "1");
    assert.equal(civilityDisplay, "M.");
    const proxied = result.formDiscoveryDiagnostics?.proxiedSelectDiagnostics ?? [];
    assert.equal(proxied.length, 1);
    assert.equal(proxied[0]!.activationMethod, "proxy_option_click");
    assert.equal(proxied[0]!.nativeValueCommitted, true);
    assert.equal(proxied[0]!.proxyReflectsSelection, true);
    assert.equal(proxied[0]!.proxyKind, "readonly_input");
    const skipped = result.formDiscoveryDiagnostics?.skippedFieldReasons ?? [];
    assert.ok(skipped.some((s) => s.reason === "select_proxy"), "the visible stand-in itself is never typed into");
    assert.equal(businessHits, 1);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(stageOf(result), null);
  });
});

test("cancellation 2: when the custom list never opens, the native select is committed with change events and the widget's display follows", async () => {
  await run({ civility: "proxy_list_never_opens", scenario: "ok_xhr" }, ({ result, businessHits, civilityValue, civilityDisplay }) => {
    const proxied = result.formDiscoveryDiagnostics?.proxiedSelectDiagnostics ?? [];
    assert.deepEqual(proxied[0]!.attemptedMethods, ["proxy_option_click", "native_change_event"]);
    assert.equal(proxied[0]!.activationMethod, "native_change_event");
    assert.equal(civilityValue, "1");
    assert.equal(civilityDisplay, "M.");
    assert.equal(businessHits, 1);
    assert.equal(result.formFillOutcome, "submitted");
  });
});

test("cancellation 3: the required proxied select counts as a required field and is reported filled", async () => {
  await run({ civility: "proxy", scenario: "ok_xhr" }, ({ result }) => {
    const d = result.formDiscoveryDiagnostics!;
    assert.equal(d.requiredFieldsDetected, 4);
    assert.equal(d.requiredFieldsFilled, 4);
    assert.deepEqual(d.unmappedRequiredFieldIds, []);
  });
});

test("cancellation 4 (test 1): a Submit control that never fires a submit event is classified submit_event_never_fired", async () => {
  await run({ scenario: "no_submit_event" }, ({ result, businessHits, submitCount }) => {
    assert.equal(businessHits, 0);
    assert.equal(submitCount, 0);
    assert.equal(stageOf(result), "submit_event_never_fired");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.submitClickReceived, true);
    assert.equal(e.submitEventFired, false);
    assert.equal(e.invalidEventCount, 0);
  });
});

test("cancellation 5 (test 2): native constraint validation blocks the submit event and is classified native_validity_blocked", async () => {
  await run({ scenario: "native_invalid" }, ({ result, businessHits, submitCount }) => {
    assert.equal(businessHits, 0);
    assert.equal(submitCount, 0);
    assert.equal(stageOf(result), "native_validity_blocked");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.submitEventFired, false);
    assert.ok(e.invalidEventCount >= 1);
    assert.ok(e.invalidFieldIds.length >= 1);
    const email = attempts(result)[0]!.preSubmitSnapshot!.find((c) => c.purpose === "email");
    assert.equal(email?.validityCategory, "pattern_mismatch");
  });
});

test("cancellation 6 (test 3): a custom validator that returns false with no message is a silent preventDefault", async () => {
  await run({ scenario: "custom_false_silent" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 0);
    assert.equal(stageOf(result), "submit_handler_prevented_default");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.submitEventFired, true);
    assert.equal(e.defaultPrevented, true);
    assert.equal(e.serialisationObserved, false);
    assert.equal(e.validationSurfaceAppeared, false);
  });
});

test("cancellation 7 (test 4): a custom validator that shows a message is classified custom_validation_rejected", async () => {
  await run({ scenario: "custom_message" }, ({ result }) => {
    assert.equal(stageOf(result), "custom_validation_rejected");
    assert.equal(attempts(result)[0]!.evidence!.validationSurfaceAppeared, true);
  });
});

test("cancellation 8 (test 5): a submit handler that throws is classified submit_handler_exception", async () => {
  await run({ scenario: "throws" }, ({ result }) => {
    assert.equal(stageOf(result), "submit_handler_exception");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.handlerExceptionDuringDispatch, true);
    assert.equal(e.errorsAfterSubmit[0]!.name, "Error");
  });
});

test("cancellation 9 (test 6): a rejected asynchronous validation step is classified submit_handler_exception", async () => {
  await run({ scenario: "async_reject" }, ({ result }) => {
    assert.equal(stageOf(result), "submit_handler_exception");
    assert.ok(attempts(result)[0]!.evidence!.unhandledRejectionsAfterSubmit >= 1);
  });
});

test("cancellation 10 (test 7): serialisation that throws is classified serialisation_failed, ahead of the handler exception it causes", async () => {
  await run({ scenario: "serialise_throws" }, ({ result }) => {
    assert.equal(stageOf(result), "serialisation_failed");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.serialisationThrew, true);
    assert.equal(e.serialiseCalls, 1);
  });
});

test("cancellation 11 (test 8): a form serialised but never dispatched is classified business_dispatch_not_invoked", async () => {
  await run({ scenario: "formdata_no_dispatch" }, ({ result }) => {
    assert.equal(stageOf(result), "business_dispatch_not_invoked");
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.formDataEventCount, 1);
    assert.deepEqual(e.dispatchInvocations, []);
  });
});

test("cancellation 12 (tests 9, 30): an XHR business request followed by a same-page confirmation is not a cancellation", async () => {
  await run({ scenario: "ok_xhr" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(stageOf(result), null);
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.businessDispatchInvoked, true);
    assert.equal(e.dispatchInvocations.find((d) => d.businessCandidate)?.transport, "xhr");
    assert.equal(e.formDataEventCount, 1);
  });
});

test("cancellation 13 (test 10): a fetch business request is recorded as a fetch dispatch", async () => {
  await run({ scenario: "ok_fetch" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(stageOf(result), null);
    assert.equal(attempts(result)[0]!.evidence!.dispatchInvocations.find((d) => d.businessCandidate)?.transport, "fetch");
  });
});

test("cancellation 14 (test 11): a native navigation submit is a success with no client-side cancellation", async () => {
  await run({ scenario: "ok_navigation" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(result.success, true);
    assert.equal(stageOf(result), null);
  });
});

test("cancellation 15 (test 12): a native submit into an iframe reaches the network and is not a cancellation", async () => {
  await run({ scenario: "ok_iframe" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(stageOf(result), null);
    assert.equal(attempts(result)[0]!.evidence!.businessRequestObservedOnNetwork, true);
  });
});

test("cancellation 16 (test 13): a required HTML checkbox is ticked by the engine and reported with native_check", async () => {
  await run({ ack: "required_html", scenario: "ok_xhr" }, ({ result, ackChecked, businessHits }) => {
    assert.equal(ackChecked, true);
    assert.equal(businessHits, 1);
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks.length, 1);
    assert.equal(acks[0]!.required, true);
    assert.equal(acks[0]!.activationMethod, "native_check");
    assert.equal(acks[0]!.checkedBeforeInteraction, false);
    assert.equal(acks[0]!.checkedAfterInteraction, true);
    assert.deepEqual(acks[0]!.checkedImmediatelyBeforeSubmit, [true]);
    assert.equal(acks[0]!.includedInSerialisation, true);
  });
});

test("cancellation 17 (test 14): a checkbox required only by page script is reported as required_acknowledgement_missing", async () => {
  await run({ ack: "required_js", scenario: "ok_xhr" }, ({ result, businessHits, ackChecked }) => {
    assert.equal(ackChecked, false);
    assert.equal(businessHits, 0);
    assert.equal(stageOf(result), "required_acknowledgement_missing");
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks[0]!.required, true);
    assert.equal(acks[0]!.activationMethod, "not_activated_by_engine");
    assert.deepEqual(attempts(result)[0]!.evidence!.requiredAcknowledgementUncheckedIds, [acks[0]!.fieldId]);
  });
});

test("cancellation 18 (test 15): an optional checkbox is left untouched and does not block a submission", async () => {
  await run({ ack: "optional", scenario: "ok_xhr" }, ({ result, ackChecked, businessHits }) => {
    assert.equal(ackChecked, false);
    assert.equal(businessHits, 1);
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks[0]!.required, false);
    assert.equal(acks[0]!.activationMethod, "not_activated_by_engine");
    assert.equal(acks[0]!.changedWithoutEngineActivation, false);
    assert.equal(acks[0]!.includedInSerialisation, false);
  });
});

test("cancellation 19 (test 16): a required checkbox whose native box is off-screen is ticked through its visible label", async () => {
  await run({ ack: "offscreen_required", scenario: "ok_xhr" }, ({ result, ackChecked, businessHits }) => {
    assert.equal(ackChecked, true);
    assert.equal(businessHits, 1);
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks[0]!.activationMethod, "label_click");
    assert.equal(acks[0]!.actionable, true);
  });
});

test("cancellation 20 (test 17): a component state that contradicts the native checkbox is reported as a disagreement", async () => {
  await run({ ack: "ui_disagree", scenario: "ok_xhr" }, ({ result }) => {
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks[0]!.visualNativeAriaAgreement, "disagree");
  });
});

test("cancellation 21 (test 18): a hidden companion the widget never committed is visible in the diagnostics", async () => {
  await run({ ack: "companion", scenario: "ok_xhr" }, ({ result, ackChecked, businessHits }) => {
    assert.equal(ackChecked, true);
    assert.equal(businessHits, 0);
    const acks = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.acknowledgementCheckboxes;
    assert.equal(acks[0]!.activationMethod, "native_check");
    assert.equal(acks[0]!.hiddenCompanionStateChanged, false);
    assert.equal(stageOf(result), "submit_handler_prevented_default");
  });
});

test("cancellation 22 (test 20): an unset dealer-validity hidden flag shows as an uncommitted hidden field before Submit", async () => {
  await run({ scenario: "dealer_flag" }, ({ result }) => {
    assert.equal(stageOf(result), "submit_handler_prevented_default");
    const flag = attempts(result)[0]!.preSubmitSnapshot!.find((c) => c.safeName === "dealerValid");
    assert.equal(flag?.type, "hidden");
    assert.equal(flag?.committed, false);
    assert.equal(flag?.includedInSerialisation, true);
  });
});

test("cancellation 23 (tests 21, 22): a validation or lookup request still in flight at Submit is classified state_not_committed", async () => {
  for (const scenario of ["pending_email", "pending_dealer"]) {
    await run({ scenario }, ({ result, businessHits }) => {
      assert.equal(businessHits, 0, scenario);
      assert.equal(stageOf(result), "state_not_committed", scenario);
      assert.ok((attempts(result)[0]!.evidence!.inFlightXhrAtSubmit ?? 0) >= 1, scenario);
    });
  }
});

test("cancellation 24 (test 23): a site that needs change events on every text field accepts the engine's fill", async () => {
  await run({ scenario: "needs_change" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.equal(stageOf(result), null);
  });
});

test("cancellation 25 (test 24): a handler that needs the event's submitter gets it from the real Submit click", async () => {
  await run({ scenario: "requires_submitter" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    const e = attempts(result)[0]!.evidence!;
    assert.equal(e.submitterPresent, true);
    assert.equal(e.submitterMatchesClickedControl, true);
  });
});

test("cancellation 26 (test 25): a decoy button with Submit wording is not the activated control", async () => {
  await run({ scenario: "wrong_control" }, ({ result, businessHits }) => {
    assert.equal(businessHits, 1);
    assert.match(result.formPostSubmitDiagnostics!.submitControlIdentity, /type="submit"/);
    assert.equal(attempts(result)[0]!.evidence!.submitterMatchesClickedControl, true);
  });
});

test("cancellation 27 (tests 26, 27, 28): after the site replaces the form, the second attempt re-reads the live form, refills what was lost and is classified on its own evidence", async () => {
  await run({ scenario: "reset_once", civility: "proxy" }, ({ result, businessHits, civilityValue, submitCount }) => {
    const all = attempts(result);
    assert.equal(all.length, 2);
    assert.equal(submitCount, 2);
    assert.equal(all[0]!.cancellationStage, "form_reset_before_dispatch");
    assert.equal(all[0]!.evidence!.formReplacedOrDetached, true);
    const civilityId = all[0]!.preSubmitSnapshot!.find((c) => c.proxyRole === "proxied_select")!.fieldId;
    const refresh = all[1]!.stateRefreshBeforeAttempt!;
    assert.equal(refresh.fieldsRetagged, true);
    assert.ok(refresh.staleRequiredFieldIds.includes(civilityId), `stale: ${refresh.staleRequiredFieldIds.join(",")}`);
    assert.deepEqual([...refresh.refilledFieldIds].sort(), [...refresh.staleRequiredFieldIds].sort());
    assert.equal(all[1]!.cancellationStage, null);
    assert.equal(all[1]!.evidence!.formReplacedOrDetached, false);
    assert.equal(all[1]!.evidence!.submitterMatchesClickedControl, true);
    assert.equal(businessHits, 1);
    assert.equal(civilityValue, "1");
    assert.equal(result.formFillOutcome, "submitted");
    const diffs = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.snapshotDifferences;
    assert.ok(diffs.some((d) => d.comparison === "attempt1_before_submit_vs_attempt1_after_cancellation" && d.property === "committed"));
    assert.equal(result.formPostSubmitDiagnostics!.submitAttemptSummary.totalSubmitAttempts, 2);
  });
});

test("cancellation 28 (test 29): once a business request has started, no second Submit is attempted", async () => {
  await run(
    { scenario: "ok_xhr_no_confirm", consents: "1" },
    ({ result, businessHits }) => {
      assert.equal(businessHits, 1);
      assert.equal(attempts(result).length, 1);
      assert.equal(result.formPostSubmitDiagnostics!.submitAttemptSummary.totalSubmitAttempts, 1);
      assert.equal(stageOf(result), null);
    },
    { flag: true },
  );
});

test("cancellation 29 (test 32): diagnostics never carry the typed test data", async () => {
  await run({ civility: "proxy", ack: "required_js", scenario: "ok_xhr" }, ({ result }) => {
    const text = JSON.stringify(result.formPostSubmitDiagnostics?.submitCancellationDiagnostics) + JSON.stringify(result.formDiscoveryDiagnostics?.proxiedSelectDiagnostics);
    const fixed = FIXED_FIELDS as unknown as Record<string, string>;
    for (const value of [fixed.firstName, fixed.lastName, fixed.email, marketDataFor("FR").postcode, "M.", "Mme"]) {
      assert.ok(value && !text.includes(`"${value}"`), `diagnostics leak ${value}`);
    }
    assert.ok(!text.includes(fixed.email!));
  });
});

test("cancellation 30: both snapshots of an attempt exist and the post-cancellation snapshot is read from the live form", async () => {
  await run({ scenario: "custom_message", civility: "proxy" }, ({ result }) => {
    const a = attempts(result)[0]!;
    assert.ok(a.preSubmitSnapshot && a.preSubmitSnapshot.length > 0);
    assert.ok(a.postCancellationSnapshot && a.postCancellationSnapshot.length > 0);
    const civ = a.preSubmitSnapshot!.find((c) => c.proxyRole === "proxied_select");
    assert.equal(civ?.committed, true);
    assert.equal(civ?.requiredClientMetadata, true);
    assert.equal(civ?.visible, false);
    assert.ok(a.preSubmitSnapshot!.some((c) => c.proxyRole === "select_proxy"));
  });
});

test("cancellation 31: on the authorised opt-in fallback, each attempt is classified from its own probe record", async () => {
  await run(
    { scenario: "requires_optin", consents: "1" },
    ({ result, businessHits, submitCount }) => {
      const all = attempts(result);
      assert.equal(all.length, 2);
      assert.equal(submitCount, 2);
      assert.equal(all[0]!.cancellationStage, "submit_handler_prevented_default");
      assert.equal(all[0]!.evidence!.dispatchInvocations.length, 0);
      assert.equal(all[1]!.cancellationStage, null);
      assert.equal(all[1]!.evidence!.businessDispatchInvoked, true);
      assert.deepEqual(all[1]!.stateRefreshBeforeAttempt!.staleRequiredFieldIds, []);
      assert.equal(businessHits, 1);
      const diffs = result.formPostSubmitDiagnostics!.submitCancellationDiagnostics!.snapshotDifferences;
      assert.ok(diffs.some((d) => d.comparison === "attempt1_before_submit_vs_attempt2_before_submit" && d.property === "checkedCategory"));
    },
    { flag: true },
  );
});
