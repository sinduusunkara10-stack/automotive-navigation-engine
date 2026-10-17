import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Route } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { SubmissionObservationConfig } from "../../src/actions/submissionObserver.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const FAST: SubmissionObservationConfig = { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 6_000, pollIntervalMs: 100 };

interface ScenarioOptions {
  scenario: string;
  delay?: number;
  businessStatus?: number;
  businessDelayMs?: number;
  config?: SubmissionObservationConfig | "defaults";
}

async function withScenario<T>(options: ScenarioOptions, run: (page: Page, result: Awaited<ReturnType<typeof executeFillForm>>) => Promise<T> | T): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route("**/api/lead", async (route: Route) => {
      if (options.businessDelayMs) await new Promise((resolve) => setTimeout(resolve, options.businessDelayMs));
      await route.fulfill({ status: options.businessStatus ?? 200, contentType: "application/json", body: "{}" }).catch(() => {});
    });
    await page.route(/example-(analytics|adnetwork)\.test/, (route) => route.fulfill({ status: 200, body: "" }));
    const query = new URLSearchParams({ scenario: options.scenario, delay: String(options.delay ?? 0) });
    await page.goto(`${baseUrl}/lead-form-post-submit-scenarios.html?${query.toString()}`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      submissionObservationConfig: options.config === "defaults" ? undefined : (options.config ?? FAST),
    });
    return await run(page, result);
  } finally {
    await browser?.close();
    await close();
  }
}

test("post-submit: a quick on-page confirmation succeeds and stops early, far before the default base window", async () => {
  const started = Date.now();
  await withScenario({ scenario: "quick", config: "defaults" }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.equal(observation?.terminalState, "succeeded");
    assert.ok(observation?.successSignals.includes("confirmation_message"));
    assert.equal(observation?.baseWindowMs, 10_000, "production defaults were used");
    assert.ok((observation?.totalObservationMs ?? Infinity) < 3_000, `stopped early, took ${observation?.totalObservationMs} ms`);
    assert.equal(observation?.extensionCount, 0);
  });
  assert.ok(Date.now() - started < 20_000);
});

test("post-submit: a same-page confirmation that appears only after more than 60 s is still observed, because a loading indicator and a disabled submit justify each extension", { timeout: 120_000 }, async () => {
  await withScenario({ scenario: "spinner_then_confirmation", delay: 62_000, config: "defaults" }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");
    assert.equal(observation?.terminalState, "succeeded");
    assert.ok((observation?.confirmationDetectedAtMs ?? 0) >= 60_000, `confirmation at ${observation?.confirmationDetectedAtMs} ms`);
    assert.ok((observation?.totalObservationMs ?? Infinity) < observation!.hardCapMs);
    assert.ok((observation?.extensionCount ?? 0) >= 5);
    assert.ok(observation?.extensionReasons.every((reasons) => reasons.includes("loading_indicator_active") || reasons.includes("submit_control_disabled")));
  });
});

test("post-submit: a business request still in flight past the base window extends observation until it answers and the confirmation follows", async () => {
  await withScenario({ scenario: "request_in_flight", businessDelayMs: 3_000 }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.ok(observation?.extensionReasons.some((reasons) => reasons.includes("business_request_in_flight")));
    assert.equal(observation?.businessRequest?.method, "POST");
    assert.equal(observation?.businessRequest?.status, 200);
    assert.ok((observation?.businessRequestFinishedAtMs ?? 0) >= 2_500);
    assert.ok((observation?.confirmationDetectedAtMs ?? 0) >= (observation?.businessRequestFinishedAtMs ?? 0) - 50);
  });
});

test("post-submit: the business request completes first and the DOM confirmation follows later while the page still shows progress", async () => {
  await withScenario({ scenario: "request_then_delayed_dom", delay: 3_000 }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.equal(observation?.businessRequest?.outcome, "completed");
    assert.ok((observation?.businessRequestFinishedAtMs ?? Infinity) < 1_500);
    assert.ok((observation?.confirmationDetectedAtMs ?? 0) >= 2_500);
    assert.ok((observation?.extensionCount ?? 0) >= 1);
  });
});

test("post-submit: the same URL with the whole form replaced after an accepted business response counts as success, with no confirmation vocabulary at all", async () => {
  await withScenario({ scenario: "form_replaced" }, (page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.ok(page.url().includes("lead-form-post-submit-scenarios.html"));
    assert.deepEqual(observation?.successSignals, ["form_replaced_after_accepted_business_response"]);
    assert.equal(observation?.formStillPresentAtEnd, false);
  });
});

test("post-submit: a pre-rendered hidden confirmation container that becomes visible is detected", async () => {
  await withScenario({ scenario: "hidden_container" }, (_page, result) => {
    assert.equal(result.success, true);
    assert.ok(result.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals.includes("confirmation_message"));
  });
});

test("post-submit: a confirmation rendered in a portal dialog is detected", async () => {
  await withScenario({ scenario: "modal" }, (_page, result) => {
    const signals = result.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals ?? [];
    assert.equal(result.success, true);
    assert.ok(signals.includes("success_status_surface") || signals.includes("confirmation_message"));
  });
});

test("post-submit: a confirmation rendered in a same-origin iframe is detected", async () => {
  await withScenario({ scenario: "iframe" }, (_page, result) => {
    assert.equal(result.success, true);
    assert.ok(result.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals.includes("confirmation_message"));
  });
});

test("post-submit: a virtual-page success event in the dataLayer counts as success", async () => {
  await withScenario({ scenario: "virtual_page" }, (_page, result) => {
    assert.equal(result.success, true);
    assert.deepEqual(result.formPostSubmitDiagnostics?.postSubmitObservation?.successSignals, ["virtual_page_success_event"]);
  });
});

test("post-submit: tracking POSTs fired before the business POST are excluded and the business request is the one correlated", async () => {
  await withScenario({ scenario: "tracking_then_business" }, (_page, result) => {
    const diagnostics = result.formPostSubmitDiagnostics;
    const observation = diagnostics?.postSubmitObservation;
    assert.equal(result.success, true);
    assert.equal(observation?.businessRequestCount, 1);
    assert.match(observation?.businessRequest?.endpointPattern ?? "", /\/api\/lead$/);
    assert.ok((observation?.excludedTrackingOrThirdPartyRequestCount ?? 0) >= 2);
    const trackingStart = Math.min(
      ...(diagnostics?.submissionNetworkRequests ?? []).filter((r) => /example-(analytics|adnetwork)/.test(r.endpointPattern)).map((r) => r.startedAtMs),
    );
    assert.ok(Number.isFinite(trackingStart), "tracking requests were captured as evidence");
  });
});

test("post-submit: tracking alone never counts as a submission request", async () => {
  await withScenario({ scenario: "tracking_only" }, (_page, result) => {
    const diagnostics = result.formPostSubmitDiagnostics;
    assert.equal(result.success, false);
    assert.equal(diagnostics?.submissionRequestStarted, false);
    assert.equal(diagnostics?.submissionServerResponseCategory, "no_request");
    assert.equal(diagnostics?.postSubmitObservation?.businessRequestDetected, false);
    assert.ok((diagnostics?.postSubmitObservation?.excludedTrackingOrThirdPartyRequestCount ?? 0) >= 2);
    assert.equal(diagnostics?.submissionOutcome, "cancelled_before_request");
  });
});

test("post-submit: an accepted business POST with no UI confirmation is unconfirmed, never success, and is never resubmitted", async () => {
  await withScenario({ scenario: "accepted_no_ui" }, (_page, result) => {
    const diagnostics = result.formPostSubmitDiagnostics;
    assert.equal(result.success, false);
    assert.equal(diagnostics?.submissionServerResponseCategory, "accepted");
    assert.equal(diagnostics?.submissionOutcome, "unconfirmed");
    assert.equal(diagnostics?.postSubmitObservation?.terminalState, "unknown_outcome");
    assert.match(diagnostics?.retryDecision ?? "", /could duplicate the lead|no invalid field/);
  });
});

test("post-submit: a business validation rejection shown on the page is validation_failed", async () => {
  await withScenario({ scenario: "validation_error" }, (_page, result) => {
    const diagnostics = result.formPostSubmitDiagnostics;
    assert.equal(result.success, false);
    assert.equal(diagnostics?.postSubmitObservation?.terminalState, "validation_failed");
    assert.equal(diagnostics?.submissionOutcome, "validation_failed");
  });
});

test("post-submit: a 422 business response is server_rejected and a 500 is server_error", async () => {
  await withScenario({ scenario: "server_reject", businessStatus: 422 }, (_page, result) => {
    assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.terminalState, "server_rejected");
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "server_rejected");
  });
  await withScenario({ scenario: "server_reject", businessStatus: 500 }, (_page, result) => {
    assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.terminalState, "server_error");
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "server_error");
  });
});

test("post-submit: an anti-bot or rate-limit response (429/403) is blocked_or_challenged", async () => {
  for (const status of [429, 403]) {
    await withScenario({ scenario: "server_reject", businessStatus: status }, (_page, result) => {
      assert.equal(result.formPostSubmitDiagnostics?.postSubmitObservation?.terminalState, "blocked_or_challenged");
      assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "blocked_or_rate_limited");
    });
  }
});

test("post-submit: no business request after Submit stops at the base window, not the hard cap", async () => {
  await withScenario({ scenario: "nothing" }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(result.success, false);
    assert.equal(observation?.businessRequestDetected, false);
    assert.equal(observation?.extensionCount, 0);
    assert.ok((observation?.totalObservationMs ?? Infinity) < FAST.baseWindowMs + 1_000);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "cancelled_before_request");
  });
});

test("post-submit: the hard cap is reached only while progress keeps being observed", async () => {
  await withScenario({ scenario: "endless_spinner" }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(observation?.terminalState, "unknown_outcome");
    assert.match(observation?.terminalReason ?? "", /hard cap/);
    assert.ok((observation?.extensionCount ?? 0) >= 3);
    assert.ok((observation?.totalObservationMs ?? 0) >= FAST.hardCapMs - 200);
    assert.ok((observation?.totalObservationMs ?? Infinity) < FAST.hardCapMs + 2_000);
  });
  await withScenario({ scenario: "accepted_no_ui" }, (_page, result) => {
    const observation = result.formPostSubmitDiagnostics?.postSubmitObservation;
    assert.equal(observation?.extensionCount, 0, "nothing was in progress, so the window was never extended");
    assert.ok((observation?.totalObservationMs ?? Infinity) < FAST.hardCapMs);
  });
});

test("post-submit: diagnostics never carry hidden values, typed values, tracking identifiers or echoed personal data", async () => {
  await withScenario({ scenario: "echo_error" }, async (page, result) => {
    const serialized = JSON.stringify({
      post: result.formPostSubmitDiagnostics,
      consent: result.formConsentDiagnostics,
      dealer: result.formDealerSearchDiagnostics,
      trace: result.dealerLookupTrace,
    });
    const values = await page.evaluate(() =>
      Array.from(document.querySelectorAll("input")).map((el) => (el as HTMLInputElement).value).filter((v) => v.trim().length >= 4),
    );
    assert.ok(values.length >= 4, "the run did type values and the page does carry hidden values");
    for (const value of values) assert.equal(serialized.includes(value), false, `value leaked into diagnostics`);
    for (const fragment of ["DLR-778899", "GA1.2", "75008", "+33", "@"]) assert.equal(serialized.includes(fragment), false, `${fragment} leaked`);
    const hidden = result.formPostSubmitDiagnostics?.hiddenFieldEvidence ?? [];
    assert.ok(hidden.some((h) => h.purpose === "dealer_or_location_selection" && h.populatedAfter));
    assert.ok(hidden.some((h) => h.purpose === "tracking_or_session"));
    assert.ok(result.formPostSubmitDiagnostics?.postSubmitValidationMessages.some((m) => m.includes("{email}") && m.includes("{number}")));
  });
});

test("post-submit: a real fill_form action result with the new diagnostics validates against the response schema's actionResult", async () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  const schema = JSON.parse(await readFile(join(__dirname, "..", "..", "schemas", "task-response.schema.json"), "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/actionResult` });
  for (const scenario of ["accepted_no_ui", "echo_error", "quick"]) {
    await withScenario({ scenario }, (_page, result) => {
      const wire = JSON.parse(JSON.stringify({ ...result, interactionOutcome: "IN_PAGE_STATE_CHANGE" }));
      assert.equal(validate(wire), true, `${scenario}: ${ajv.errorsText(validate.errors)}`);
    });
  }
});

test("privacy: dealer result option labels (names, addresses) never appear anywhere in the action result, with or without the diagnostic flag", async () => {
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  try {
    for (const flag of ["1", undefined]) {
      if (flag === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
      else process.env.FORM_DISCOVERY_DIAGNOSTIC = flag;
      const { baseUrl, close } = await startStaticServer(fixturesDir);
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        await page.goto(`${baseUrl}/lead-form-dealer-trigger-parallel-wrapper.html`);
        const result = await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], submissionObservationConfig: FAST });
        const serialized = JSON.stringify(result);
        const optionLabels = await page.evaluate(() =>
          Array.from(document.querySelectorAll('input[type="radio"]')).map((el) => (el.closest("label")?.textContent ?? "").trim()).filter((t) => t.length > 3),
        );
        assert.ok(optionLabels.length >= 2);
        for (const label of optionLabels) assert.equal(serialized.includes(label), false, `option label leaked with flag=${flag}`);
        if (flag === "1") assert.ok(result.dealerLookupTrace, "the diagnostic trace was produced and audited");
      } finally {
        await browser.close();
        await close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
  }
});
