import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

test("fill_form: fills required fields, skips hidden/optional/prefilled, and succeeds via a URL change", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-url-success.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "url_change");
    assert.equal(result.formMarketDetected, "UK");
    assert.equal(result.formLanguageDetected, "en");
    assert.ok(result.resultingUrl?.includes("lead-form-thank-you.html"));

    const url = new URL(result.resultingUrl!);
    assert.equal(url.searchParams.get("firstName"), "Test");
    assert.equal(url.searchParams.get("lastName"), "Test");
    assert.equal(url.searchParams.get("email"), "test@test.com");
    assert.equal(url.searchParams.get("mobile"), "+44 7700 900123");
    assert.equal(url.searchParams.get("postcode"), "SW1A 1AA");
    // Optional comments field left blank, honeypot never filled, optional consent left unchecked.
    assert.equal(url.searchParams.get("comments"), "");
    assert.equal(url.searchParams.get("website"), "");
    assert.equal(url.searchParams.get("stayInTouch"), null);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: detects success via an on-screen confirmation message when the URL never changes", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-message-success.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, true);
    assert.equal(result.formFillOutcome, "submitted");
    assert.equal(result.formSuccessDetection, "on_screen_message");
    assert.equal(result.formLanguageDetected, "fr");
    assert.equal(result.formMarketDetected, "FR");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: a detected CAPTCHA stops the run without filling or submitting anything", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-captcha.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "blocked_captcha");

    const values = await page.evaluate(() => ({
      firstName: (document.getElementById("first-name") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
    }));
    assert.deepEqual(values, { firstName: "", email: "" });
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("fill_form: an unresolvable required field triggers retries up to the bound, then reports form_validation_failed", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-validation-failure.html`);
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
    });

    assert.equal(result.success, false);
    assert.equal(result.formFillOutcome, "form_validation_failed");
    assert.equal(result.formRetriesUsed, 2);
    assert.ok(result.formValidationMissingFields && result.formValidationMissingFields.length > 0);

    const values = await page.evaluate(() => ({
      firstName: (document.getElementById("first-name") as HTMLInputElement).value,
      email: (document.getElementById("email") as HTMLInputElement).value,
    }));
    assert.equal(values.firstName, "Test");
    assert.equal(values.email, "test@test.com");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
