import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page, type Route } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { DEFAULT_SUBMISSION_OBSERVATION_CONFIG, type SubmissionObservationConfig } from "../../src/actions/submissionObserver.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const FAST: SubmissionObservationConfig = { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 3_000, pollIntervalMs: 100 };
const OPTIONAL = ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY"];

interface RunOptions {
  radio?: string;
  site?: string;
  confirmDelay?: number;
  track?: boolean;
  flag?: boolean;
  config?: SubmissionObservationConfig;
  businessDelayMs?: number;
}

interface RunOutcome {
  result: Awaited<ReturnType<typeof executeFillForm>>;
  page: Page;
  businessHits: number;
  submitCount: number;
  answers: Record<string, string | null>;
  typedValues: string[];
}

async function run<T>(options: RunOptions, check: (outcome: RunOutcome) => Promise<T> | T): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    let businessHits = 0;
    await page.route("**/api/lead", async (route: Route) => {
      businessHits += 1;
      if (options.businessDelayMs) await new Promise((resolve) => setTimeout(resolve, options.businessDelayMs));
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {});
    });
    await page.route(/example-(analytics|adnetwork)\.test/, (route) => route.fulfill({ status: 200, body: "" }));
    const query = new URLSearchParams({
      radio: options.radio ?? "native",
      site: options.site ?? "requires_optin",
      confirmDelay: String(options.confirmDelay ?? 300),
      track: options.track ? "1" : "0",
    });
    await page.goto(`${baseUrl}/lead-form-consent-retry.html?${query.toString()}`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      submissionObservationConfig: options.config ?? FAST,
      optionalConsentOptInFallbackForTest: options.flag,
    });
    const state = await page.evaluate(() => {
      const answers: Record<string, string | null> = {};
      Array.from(document.querySelectorAll('input[type="radio"]')).forEach((el) => {
        const radio = el as HTMLInputElement;
        if (!(radio.name in answers)) answers[radio.name] = null;
        if (radio.checked) answers[radio.name] = radio.value;
      });
      const typedValues = Array.from(document.querySelectorAll('input[type="text"], input[type="email"]')).map((el) => (el as HTMLInputElement).value).filter(Boolean);
      return { answers, typedValues, submitCount: (window as unknown as { __submitCount: number }).__submitCount };
    });
    return await check({ result, page, businessHits, submitCount: state.submitCount, answers: state.answers, typedValues: state.typedValues });
  } finally {
    await browser?.close();
    await close();
  }
}

function optionalGroups(result: RunOutcome["result"]) {
  return (result.formConsentDiagnostics?.consentGroupDiagnostics ?? []).filter((g) => OPTIONAL.includes(g.groupId));
}

test("custom radio 1: a plain native radio's No is verified through native checked state", async () => {
  await run({ radio: "native", site: "delayed_confirm" }, ({ result, answers }) => {
    for (const group of optionalGroups(result)) {
      assert.equal(group.checkedStateVerified, true, group.groupId);
      assert.equal(group.activation?.intendedAnswer, "decline");
      assert.equal(group.activation?.attempts[0]?.clickedElementType, "native_input");
      assert.equal(group.activation?.verificationResult, "verified");
      assert.ok(group.activation?.verificationMethods.includes("native_checked"));
      assert.ok(group.activation?.verificationMethods.includes("radio_name_selected_value"));
      assert.equal(group.activation?.intendedOptionCheckedBefore, false);
      assert.equal(group.activation?.intendedOptionCheckedAfter, true);
    }
    assert.equal(answers.PRIVACY_FLAG_MRKT, "0");
    assert.equal(answers.PRIVACY_FLAG_THIRDPARTY, "0");
    assert.equal(result.formConsentDiagnostics?.optionalDeclineNotCommittedGroups.length, 0);
  });
});

test("custom radio 2: No is committed through the label when the native input is off-screen, and through the component wrapper when there is no label", async () => {
  await run({ radio: "offscreen_label", site: "delayed_confirm" }, ({ result, answers }) => {
    for (const group of optionalGroups(result)) {
      assert.equal(group.visibleOptionCount, 2, "the label keeps an off-screen input's option visible");
      assert.notEqual(group.activation?.attempts[0]?.clickedElementType, "native_input", "an off-screen input never takes a pointer click");
      assert.equal(group.activation?.clickedElementType, "label");
      assert.equal(group.activation?.verificationResult, "verified");
    }
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["0", "0"]);
  });
  await run({ radio: "wrapper_only", site: "delayed_confirm" }, ({ result, answers }) => {
    for (const group of optionalGroups(result)) {
      assert.equal(group.activation?.clickedElementType, "wrapper");
      assert.equal(group.activation?.verificationResult, "verified");
      assert.ok(group.activation?.verificationMethods.includes("native_checked"));
      assert.ok(group.activation?.verificationMethods.includes("selected_class"));
    }
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["0", "0"]);
  });
});

test("custom radio 3: No that the framework writes back only after a delay is verified after reconciliation, on the first activation", async () => {
  await run({ radio: "reconcile", site: "delayed_confirm" }, ({ result, answers }) => {
    for (const group of optionalGroups(result)) {
      assert.equal(group.activation?.attempts.length, 1, group.groupId);
      assert.equal(group.activation?.verificationResult, "verified");
      assert.equal(group.checkedAfter, "negative");
    }
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["0", "0"]);
  });
});

test("custom radio 4: a No that never commits is tagged consent_decline_not_committed after every activation route, never reported as declined", async () => {
  await run({ radio: "stuck_decline", site: "delayed_confirm" }, ({ result, answers }) => {
    for (const group of optionalGroups(result)) {
      assert.equal(group.checkedStateVerified, false);
      assert.equal(group.outcomeTag, "consent_decline_not_committed");
      assert.equal(group.activation?.verificationResult, "not_committed");
      assert.deepEqual(
        group.activation?.attempts.map((a) => a.clickedElementType),
        ["native_input", "label", "keyboard", "programmatic"],
      );
    }
    assert.deepEqual(result.formConsentDiagnostics?.optionalDeclineNotCommittedGroups.sort(), [...OPTIONAL].sort());
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], [null, null]);
    assert.equal(result.formPostSubmitDiagnostics?.submitAttemptSummary.firstAttemptConsentCommitted, false);
  });
});

test("attempt 5: the first attempt with No succeeds on a same-page confirmation that only appears after 30 s of silence", { timeout: 120_000 }, async () => {
  await run({ site: "delayed_confirm", confirmDelay: 30_000, config: DEFAULT_SUBMISSION_OBSERVATION_CONFIG }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.equal(observation?.minimumObservationMs, 50_000);
    assert.equal(observation?.pollIntervalMs, 500);
    assert.ok((observation?.confirmationDetectedAtMs ?? 0) >= 29_000, `confirmation at ${observation?.confirmationDetectedAtMs}`);
    assert.equal(summary?.firstAttemptOutcome, "succeeded");
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(summary?.totalSubmitAttempts, 1);
    assert.equal(submitCount, 1);
  });
});

test("attempt 6: with the flag on, a silent first attempt confirmed at ~56 s is detected and the fallback is never used", { timeout: 150_000 }, async () => {
  await run({ site: "delayed_confirm", confirmDelay: 56_000, flag: true, config: DEFAULT_SUBMISSION_OBSERVATION_CONFIG }, ({ result, submitCount, answers }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, true);
    assert.ok((summary?.confirmationDetectedAtMs ?? 0) >= 55_000, `confirmation at ${summary?.confirmationDetectedAtMs}`);
    assert.equal(summary?.firstAttemptOutcome, "succeeded");
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(summary?.fallbackEligibilityChecks, null);
    assert.equal(summary?.totalSubmitAttempts, 1);
    assert.equal(submitCount, 1);
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["0", "0"]);
  });
});

test("attempt 7: a first attempt that started a business request and confirms later is never retried", async () => {
  await run({ site: "request_then_delayed_confirm", confirmDelay: 1_800, flag: true }, ({ result, businessHits, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, true);
    assert.equal(summary?.firstAttemptBusinessRequestDetected, true);
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(businessHits, 1);
    assert.equal(submitCount, 1);
  });
});

test("attempt 8: a business request whose outcome is unknown (still pending, or accepted with no confirmation) is never resubmitted", async () => {
  await run({ site: "request_no_ui", flag: true, businessDelayMs: 8_000 }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptOutcome, "business_request_pending");
    assert.equal(summary?.fallbackEligibilityChecks?.noBusinessRequestPending, false);
    assert.equal(summary?.fallbackEligibilityChecks?.noBusinessRequestStarted, false);
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(submitCount, 1);
  });
  await run({ site: "request_no_ui", flag: true }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptOutcome, "business_request_accepted_unconfirmed");
    assert.equal(summary?.fallbackEligibilityChecks?.noBusinessAcceptance, false);
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(submitCount, 1);
  });
});

test("attempt 9: a first attempt cancelled before any business request passes every fallback guard except the disabled flag", async () => {
  await run({ site: "requires_optin" }, ({ result }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptOutcome, "cancelled_before_business_request");
    assert.equal(summary?.firstAttemptConsentMode, "decline");
    const failed = Object.entries(summary?.fallbackEligibilityChecks ?? {}).filter(([, ok]) => !ok).map(([name]) => name);
    assert.deepEqual(failed, ["fallbackFlagEnabled"]);
    assert.equal(summary?.fallbackEligible, false);
  });
});

test("attempt 10: with the flag false, an optional consent is never switched to Yes and Submit is clicked once", async () => {
  await run({ site: "requires_optin", flag: false }, ({ result, answers, submitCount, businessHits }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, false);
    assert.equal(summary?.fallbackFlagEnabled, false);
    assert.equal(summary?.fallbackUsed, false);
    assert.deepEqual(summary?.fallbackConsentGroups, []);
    assert.equal(summary?.totalSubmitAttempts, 1);
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["0", "0"]);
    assert.equal(submitCount, 1);
    assert.equal(businessHits, 0);
  });
});

test("attempt 11 and 17: with the flag true, one opt-in attempt follows, required processing is untouched, and the same-page confirmation without a URL change succeeds", async () => {
  await run({ site: "requires_optin", flag: true }, ({ result, answers, submitCount, businessHits, page }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, true);
    assert.ok(page.url().includes("lead-form-consent-retry.html"), "no URL change");
    assert.equal(summary?.fallbackUsed, true);
    assert.equal(summary?.fallbackOutcomeTag, "test_only_optional_consent_fallback");
    assert.equal(summary?.firstAttemptConsentMode, "decline");
    assert.equal(summary?.firstAttemptOutcome, "cancelled_before_business_request");
    assert.equal(summary?.secondAttemptConsentMode, "opt_in_test_only");
    assert.equal(summary?.secondAttemptOutcome, "succeeded");
    assert.equal(summary?.secondAttemptBusinessRequestDetected, true);
    assert.equal(summary?.totalSubmitAttempts, 2);
    assert.deepEqual(summary?.fallbackConsentGroups.map((g) => g.groupId).sort(), [...OPTIONAL].sort());
    assert.ok(summary?.fallbackConsentGroups.every((g) => g.verified && g.checkedAfter === "positive"));
    assert.ok(summary?.firstAttemptObservation, "the first attempt's own observation is kept");
    assert.equal(answers.processing, "1");
    assert.deepEqual([answers.PRIVACY_FLAG_MRKT, answers.PRIVACY_FLAG_THIRDPARTY], ["1", "1"]);
    assert.equal(submitCount, 2);
    assert.equal(businessHits, 1);
    assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals.includes("url_change"), false);
  });
});

test("attempt 4 + fallback: a No that never commits is classified consent_state_not_committed and the verified opt-in follows", async () => {
  await run({ radio: "stuck_decline", site: "requires_optin", flag: true }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptOutcome, "consent_state_not_committed");
    assert.equal(summary?.fallbackUsed, true);
    assert.equal(result.success, true);
    assert.equal(submitCount, 2);
  });
});

test("attempt 12: a Yes that never reads back as selected blocks the second Submit", async () => {
  await run({ radio: "stuck_accept", site: "requires_optin", flag: true }, ({ result, submitCount, businessHits }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.fallbackEligible, true);
    assert.equal(summary?.fallbackUsed, false);
    assert.match(summary?.fallbackDecision ?? "", /did not read back as accepted/);
    assert.ok(summary?.fallbackConsentGroups.every((g) => !g.verified && g.activation?.verificationResult !== "verified"));
    assert.equal(summary?.totalSubmitAttempts, 1);
    assert.equal(submitCount, 1);
    assert.equal(businessHits, 0);
  });
});

test("attempt 13: with production timings the silent first attempt is held to the 75 s cap and the second attempt is observed for at least 50 s", { timeout: 240_000 }, async () => {
  await run({ site: "never", flag: true, config: DEFAULT_SUBMISSION_OBSERVATION_CONFIG }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.fallbackUsed, true);
    assert.ok((summary?.firstAttemptObservationMs ?? 0) >= 75_000, `first ${summary?.firstAttemptObservationMs}`);
    assert.ok((summary?.secondAttemptObservationMs ?? 0) >= 50_000, `second ${summary?.secondAttemptObservationMs}`);
    assert.ok((summary?.secondAttemptObservationMs ?? Infinity) <= 75_000 + 2_000);
    assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.minimumObservationMs, 50_000);
    assert.equal(summary?.totalSubmitAttempts, 2);
    assert.equal(submitCount, 2);
  });
});

test("attempt 14: a second silent cancellation never leads to a third Submit", async () => {
  await run({ site: "never", flag: true }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, false);
    assert.equal(summary?.fallbackUsed, true);
    assert.equal(summary?.secondAttemptOutcome, "cancelled_before_business_request");
    assert.equal(summary?.totalSubmitAttempts, 2);
    assert.equal(submitCount, 2);
  });
});

test("attempt 15: tracking and advertising requests fired by Submit are never the business request", async () => {
  await run({ site: "requires_optin", flag: true, track: true }, ({ result, businessHits }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptBusinessRequestDetected, false);
    assert.ok((summary?.firstAttemptObservation?.excludedTrackingOrThirdPartyRequestCount ?? 0) >= 2);
    assert.equal(summary?.fallbackUsed, true);
    assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.businessRequest?.endpointPattern.includes("/api/lead"), true);
    assert.equal(businessHits, 1);
  });
});

test("attempt 16: a duplicate notice or an anti-bot challenge after the first Submit prevents the retry", async () => {
  await run({ site: "duplicate_notice", flag: true }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(result.success, false, "an \"already sent\" notice is never a confirmation");
    assert.equal(summary?.firstAttemptOutcome, "blocked_or_challenged");
    assert.equal(summary?.fallbackEligibilityChecks?.noChallengeDuplicateOrRateLimit, false);
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(submitCount, 1);
  });
  await run({ site: "challenge", flag: true }, ({ result, submitCount }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.equal(summary?.firstAttemptOutcome, "blocked_or_challenged");
    assert.equal(summary?.fallbackEligibilityChecks?.noChallengeDuplicateOrRateLimit, false);
    assert.equal(summary?.fallbackUsed, false);
    assert.equal(submitCount, 1);
  });
});

test("privacy 18: no typed value, dealer value, tracking identifier, option label or question text appears in the result", async () => {
  await run({ site: "requires_optin", flag: true, track: true }, ({ result, typedValues }) => {
    const serialized = JSON.stringify(result);
    assert.ok(typedValues.length >= 3);
    for (const value of typedValues) assert.equal(serialized.includes(value), false, "a typed value leaked");
    for (const fragment of ["DLR-445566", "GA1.2.99901234", "Souhaitez-vous", "Acceptez-vous", "politique de confidentialité", "\"Oui\"", "\"Non\"", "{\"lead\":true}"]) {
      assert.equal(serialized.includes(fragment), false, fragment);
    }
  });
});

test("schema: the new consent activation and submit-attempt diagnostics validate against the response schema's actionResult", async () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  const schema = JSON.parse(await readFile(join(__dirname, "..", "..", "schemas", "task-response.schema.json"), "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/actionResult` });
  for (const options of [{ site: "requires_optin", flag: true }, { radio: "stuck_decline", site: "delayed_confirm" }, { radio: "stuck_accept", site: "requires_optin", flag: true }]) {
    await run(options, ({ result }) => {
      const wire = JSON.parse(JSON.stringify({ ...result, interactionOutcome: "IN_PAGE_STATE_CHANGE" }));
      assert.equal(validate(wire), true, `${JSON.stringify(options)}: ${ajv.errorsText(validate.errors)}`);
    });
  }
});
