import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { dispatchAction } from "../../src/actions/index.js";
import { runTask } from "../../src/core/engine.js";
import { buildObservation, readElementState } from "../../src/observation/observationBuilder.js";
import { ClaudeReasoningProvider } from "../../src/reasoning/claudeReasoningProvider.js";
import type { ClaudeDecisionPayload } from "../../src/reasoning/claudeDecisionSchema.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { ActionResult } from "../../src/types/task-response.js";
import { FakeReasoningModelClient, resultStep } from "../unit/fakes/fakeReasoningModelClient.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

// A generic web-component lead form (tests/fixtures/shadow-dom-lead-form.html): every control,
// label, validation message, dealer result and the confirmation live in one open shadow root.
// `dom=light` renders the identical form in the light DOM, so both go through one engine path.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

type LeadPost = Record<string, string>;

async function withFixture<T>(query: string, fn: (page: Page, baseUrl: string) => Promise<T>): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(`${baseUrl}/shadow-dom-lead-form.html${query ? `?${query}` : ""}`);
    return await fn(page, baseUrl);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

function fill(page: Page, extra: Partial<Parameters<typeof executeFillForm>[0]> = {}): Promise<ActionResult> {
  return executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], ...extra }) as Promise<ActionResult>;
}

function leadPosts(page: Page): Promise<LeadPost[]> {
  return page.evaluate(() => (window as unknown as { __leadPosts: LeadPost[] }).__leadPosts);
}

function shadowText(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector("lead-request-app")?.shadowRoot as ShadowRoot | null)?.textContent ?? "");
}

test("shadow DOM: Playwright CSS locators pierce the open root, while document-level queries and body text do not", async () => {
  await withFixture("", async (page) => {
    const pageSide = await page.evaluate(() => ({
      forms: document.querySelectorAll("form").length,
      inputs: document.querySelectorAll("input").length,
      emailById: document.getElementById("email") !== null,
      labelFor: document.querySelector('label[for="email"]') !== null,
      bodyHasFormText: document.body.innerText.includes("Request a test drive"),
    }));
    assert.deepEqual(pageSide, { forms: 0, inputs: 0, emailById: false, labelFor: false, bodyHasFormText: false });

    assert.equal(await page.locator("form").count(), 1);
    assert.equal(await page.locator('form input[name="email"]').count(), 1);
    assert.equal(await page.locator('label[for="email"]').count(), 1);
    assert.equal(await page.getByLabel("Email*").count(), 1);
    assert.equal(await page.getByRole("button", { name: "Send request" }).count(), 1);
    await page.locator('input[name="email"]').fill("probe@example.com");
    assert.equal(await page.locator('input[name="email"]').inputValue(), "probe@example.com");
  });
});

test("shadow DOM: observation lists the form's controls with ids the click path can revalidate, and hit-tests them in their own tree", async () => {
  await withFixture("", async (page) => {
    const observation = await buildObservation(page);
    const names = observation.interactiveElements.map((e) => e.accessibleName);
    assert.ok(names.includes("Models"), "light-DOM chrome is still observed");
    for (const name of ["Send request", "Find dealers"]) {
      const el = observation.interactiveElements.find((e) => e.accessibleName === name);
      assert.ok(el, `${name} reaches the observation`);
      assert.equal(el.covered, undefined, `${name} is not reported covered by its own shadow host`);
      const state = await readElementState(page, el.id);
      assert.equal(state.attached, true);
      assert.equal(state.actionable, true);
    }
    assert.equal(observation.elementDiscoveryDiagnostics?.shadowHostCount, 1);

    // A light-DOM overlay over a shadow control is still reported as covering it.
    await page.evaluate(() => {
      const veil = document.createElement("div");
      veil.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.3)";
      veil.textContent = "Please wait";
      document.body.appendChild(veil);
    });
    const veiled = await buildObservation(page);
    assert.equal(veiled.interactiveElements.find((e) => e.accessibleName === "Send request")?.covered, true);
  });
});

test("shadow DOM: a click on a shadow control that reveals more shadow controls is classified as an in-page state change, as in light DOM", async () => {
  for (const shadow of [false, true]) {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html><html lang="en"><body><header><a href="#home">Home</a></header><div id="host"></div><script>
        const host = document.getElementById("host");
        const root = ${shadow ? 'host.attachShadow({ mode: "open" })' : "host"};
        root.innerHTML = '<h2>Choose</h2><button id="go">Configure</button><div id="more"></div>';
        root.querySelector("#go").addEventListener("click", () => {
          root.querySelector("#more").innerHTML = "<button>Petrol</button><button>Diesel</button><button>Electric</button>";
        });
      </script></body></html>`);
      const observation = await buildObservation(page);
      const target = observation.interactiveElements.find((e) => e.accessibleName === "Configure");
      assert.ok(target);
      const result = await dispatchAction({ page, action: { type: "click", target: target.id }, captures: {}, stepIndex: 1, captureModules: [], allowedDomains: [], actionNavigationTimeoutMs: 5000 });
      assert.equal(result.success, true);
      assert.equal(result.interactionOutcome, "IN_PAGE_STATE_CHANGE", shadow ? "shadow" : "light");
    } finally {
      await page.close();
      await browser.close();
    }
  }
});

test("shadow DOM: fill_form discovers, fills and submits the complete form, and detects the confirmation rendered in the shadow root", async () => {
  await withFixture("", async (page) => {
    const result = await fill(page);
    assert.equal(result.success, true, result.error);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "on_screen_message");
    assert.equal(result.formRetriesUsed, 0);

    const discovery = result.formDiscoveryDiagnostics;
    assert.ok(discovery);
    assert.equal(discovery.formsOnPage, 1);
    assert.deepEqual(discovery.unmappedRequiredFieldIds, []);
    assert.equal(discovery.requiredFieldsFilled, discovery.requiredFieldsDetected);
    const byLabel = new Map(discovery.fieldDiagnostics.map((f) => [f.label, f]));
    for (const [label, matched] of [
      ["First name*", "firstName"],
      ["Last name*", "lastName"],
      ["Email*", "email"],
      ["Mobile*", "mobilePhone"],
      ["Postcode*", "dealerSearch"],
    ] as const) {
      assert.equal(byLabel.get(label)?.matchedField, matched, label);
      assert.equal(byLabel.get(label)?.requiredEvidence, "attribute", label);
      assert.equal(byLabel.get(label)?.filled, true, label);
    }
    assert.equal(byLabel.get("Model of interest*")?.decision, "choose_first_valid_option");
    assert.equal(byLabel.get("I have read and accept the privacy policy*")?.decision, "tick_checkbox");
    assert.equal(byLabel.get("Address")?.decision, "skip");

    assert.ok(discovery.proxiedSelectDiagnostics?.some((p) => p.nativeValueCommitted), "the proxied title select was committed");

    const dealer = result.formDealerSearchDiagnostics;
    assert.equal(dealer?.dealerLookupFieldDetected, true);
    assert.equal(dealer?.dealerLookupControlDetected, true);
    assert.equal(dealer?.dealerLookupTriggered, true);
    assert.equal(dealer?.dealerResultsDetected, true);
    assert.equal(dealer?.dealerLookupOutcome, "dealer_selected");
    assert.equal(dealer?.dealerValueVerified, true);

    const consent = result.formConsentDiagnostics;
    assert.equal(consent?.consentGroupRejections.length, 0);
    const marketing = consent?.consentGroupDiagnostics.find((g) => g.groupId === "marketingOptIn");
    assert.equal(marketing?.purpose, "optional_marketing");
    assert.equal(marketing?.interaction, "selected_decline");
    assert.equal(marketing?.resolved, true);

    assert.equal(result.formPostSubmitDiagnostics?.submitCanceled, false);
    assert.equal(result.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");

    const posts = await leadPosts(page);
    assert.equal(posts.length, 1);
    assert.deepEqual(
      { ...posts[0], dealerPostcode: undefined },
      {
        title: "mr",
        firstName: "Test",
        lastName: "Test",
        email: "test@test.com",
        phone: "+447700900123",
        address: "",
        model: "hatch",
        dealerPostcode: undefined,
        dealerId: "D-1",
        marketingOptIn: "no",
        privacyAccepted: "on",
      },
    );
    assert.match(await shadowText(page), /Thank you, your request has been received/);
  });
});

test("shadow DOM: the same fixture gives the same fill_form outcome rendered in light DOM and in an open shadow root", async () => {
  const outcome = (r: ActionResult) => ({
    success: r.success,
    formFillOutcome: r.formFillOutcome,
    formSuccessDetection: r.formSuccessDetection,
    formFieldsFilled: r.formFieldsFilled,
    formRetriesUsed: r.formRetriesUsed,
    required: [r.formDiscoveryDiagnostics?.requiredFieldsDetected, r.formDiscoveryDiagnostics?.requiredFieldsFilled],
    decisions: r.formDiscoveryDiagnostics?.fieldDiagnostics.map((f) => [f.label, f.decision, f.filled]),
    dealer: r.formDealerSearchDiagnostics?.dealerLookupOutcome,
    consent: r.formConsentDiagnostics?.consentGroupDiagnostics.map((g) => [g.groupId, g.interaction, g.resolved]),
    submissionOutcome: r.formPostSubmitDiagnostics?.submissionOutcome,
  });
  for (const scenario of ["", "scenario=reject_email"]) {
    const light = await withFixture(["dom=light", scenario].filter(Boolean).join("&"), async (page) => ({ r: outcome(await fill(page)), posts: await leadPosts(page) }));
    const shadow = await withFixture(scenario, async (page) => ({ r: outcome(await fill(page)), posts: await leadPosts(page) }));
    assert.deepEqual(shadow, light, scenario || "default");
  }
});

test("shadow DOM: a site validator rejecting a shadow field is detected as a validation failure with the field and its message, never as success", async () => {
  await withFixture("scenario=reject_email", async (page) => {
    const result = await fill(page);
    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formSuccessDetection, undefined);
    assert.ok((result.formRetriesUsed ?? 0) >= 1, "the bounded re-fill-and-resubmit ran");
    const emailField = result.formDiscoveryDiagnostics?.fieldDiagnostics.find((f) => f.label === "Email*");
    assert.ok(emailField);
    assert.deepEqual(result.formValidationMissingFields, [emailField.id]);
    const post = result.formPostSubmitDiagnostics;
    assert.equal(post?.submitCanceled, true);
    assert.equal(post?.validationCauseObserved, true);
    assert.deepEqual(post?.ariaInvalidFieldIds, [emailField.id]);
    assert.ok(post?.postSubmitValidationMessages.includes("Please enter a valid email address"));
    assert.equal(post?.submissionOutcome, "validation_failed");
    assert.deepEqual(await leadPosts(page), []);
  });
});

test("shadow DOM: a CAPTCHA inside the shadow root stops fill_form before any field is filled", async () => {
  await withFixture("scenario=captcha", async (page) => {
    const result = await fill(page);
    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "blocked_captcha");
    const email = await page.locator('input[name="email"]').inputValue();
    assert.equal(email, "");
    assert.deepEqual(await leadPosts(page), []);
  });
});

test("shadow DOM: a required field with no keyword mapping is handed to the unmapped-field resolver and filled like a light-DOM one", async () => {
  await withFixture("address=required", async (page) => {
    const asked: string[] = [];
    const result = await fill(page, {
      unmappedFieldResolver: {
        async resolve(fields) {
          asked.push(...fields.map((f) => f.label ?? ""));
          return fields.map((f) => ({ fieldId: f.id, value: "1 Test Street" }));
        },
      },
    });
    assert.deepEqual(asked, ["Address*"]);
    assert.equal(result.success, true, result.error);
    assert.equal(result.formClaudeCallUsed, true);
    assert.equal((await leadPosts(page))[0]?.address, "1 Test Street");
  });
});

const FILL_FORM: ClaudeDecisionPayload = {
  action: "fill_form",
  reason: "The page shows a test-drive request form with a Send request button.",
  confidence: 0.9,
  consentControlIntent: "not_consent_related",
};
const STOP_SUCCESS: ClaudeDecisionPayload = {
  action: "stop_success",
  reason: "The confirmation is shown.",
  confidence: 0.9,
  consentControlIntent: "not_consent_related",
};

function shadowFormTask(baseUrl: string, query: string): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "shadow-dom-lead-form",
    objective: "Request a test drive through the lead form.",
    startUrl: `${baseUrl}/shadow-dom-lead-form.html${query ? `?${query}` : ""}`,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "confirmation_shown",
        type: "element_present",
        description: "The request confirmation is shown.",
        config: { selector: '[role="status"]:has-text("Thank you, your request has been received")' },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 3, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "fill_form", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    outputSchemaVersion: "1.53.0",
  };
}

async function runShadowJourney(query: string, steps: ClaudeDecisionPayload[]) {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    const client = new FakeReasoningModelClient(steps.map((s) => resultStep(s)));
    const reasoning = new ClaudeReasoningProvider({
      config: { apiKey: "test-fake-key-never-a-real-credential", model: "test-model", maxOutputTokens: 512, timeoutMs: 5000, maxRetries: 0, minConfidence: 0.5 },
      modelClient: client,
    });
    const result = await runTask({ page, task: shadowFormTask(baseUrl, query), reasoning });
    return { result, client, posts: await leadPosts(page) };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

test("shadow DOM end-to-end: the reasoning layer is shown the shadow form's controls, chooses fill_form, and the engine fills, submits and confirms success", async () => {
  const { result, client, posts } = await runShadowJourney("", [FILL_FORM, STOP_SUCCESS]);
  const firstPrompt = client.requests[0]?.userPrompt ?? "";
  assert.match(firstPrompt, /Send request/);
  assert.match(firstPrompt, /Find dealers/);

  const fillStep = result.steps.find((s) => s.selectedAction.type === "fill_form");
  assert.ok(fillStep, "fill_form was dispatched");
  const fillResult = fillStep.actionResult;
  assert.equal(fillResult.success, true, fillResult.error);
  assert.equal(fillResult.formFillOutcome, "submitted");
  assert.equal(fillResult.formSuccessDetection, "on_screen_message");
  assert.equal(fillResult.formPostSubmitDiagnostics?.submissionOutcome, "succeeded");
  assert.equal(posts.length, 1);
  assert.equal(posts[0]?.phone, "+447700900123");
  assert.equal(result.status, "success");

  const schemaValidation = await validateAgainstTaskResponseSchema(result);
  assert.ok(schemaValidation.valid, schemaValidation.errorsText);
});

test("shadow DOM end-to-end: a rejected shadow field fails the fill_form step as a validation failure and the run never reports success", async () => {
  const { result, posts } = await runShadowJourney("scenario=reject_email", [FILL_FORM, { ...STOP_SUCCESS, action: "stop_failure", reason: "The form was rejected." }]);
  const fillStep = result.steps.find((s) => s.selectedAction.type === "fill_form");
  assert.ok(fillStep);
  assert.equal(fillStep.actionResult.success, false);
  assert.equal(fillStep.actionResult.formFillOutcome, "form_validation_failed");
  assert.notEqual(result.status, "success");
  assert.deepEqual(posts, []);
  const schemaValidation = await validateAgainstTaskResponseSchema(result);
  assert.ok(schemaValidation.valid, schemaValidation.errorsText);
});
