import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createRequire } from "node:module";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");

// ajv and ajv-formats ship CJS builds whose ESM default-import types don't resolve
// cleanly under NodeNext interop; loading them via createRequire sidesteps that.
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

async function validateAgainstResponseSchema(response: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(response);
  assert.ok(valid, ajv.errorsText(validate.errors));
}

test("navigation engine observes, decides, acts, reaches success, and produces a schema-valid response", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-success",
      objective: "Reach the fixture's success page by following the visible continue control.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "reached_success_page",
          type: "url_pattern",
          description: "The current page URL matches the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
        },
      ],
      captureModules: [
        "page_visits",
        "page_metadata",
        "data_layer_evidence",
        "ga4_network_events",
        "screenshots",
        "finish_page_ctas",
      ],
      limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: {
        allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/success.html`);
    assert.ok(response.steps.length >= 2, "expected at least a click step and a stop step");
    assert.equal(response.steps[0]?.selectedAction.type, "click");
    assert.equal(response.steps[0]?.observation.interactiveElements[0]?.accessibleName, "Continue");
    assert.equal(response.steps[0]?.selectedAction.target, response.steps[0]?.observation.interactiveElements[0]?.id);
    assert.ok(response.captures.page_visits && response.captures.page_visits.length > 0);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.equal(response.diagnostics.finishReason, "stop_success_action");

    // dataLayer evidence must cover both pages of the journey: the fixture pushes its
    // own initial + subsequent events on each page, and evidence is preserved raw.
    const dataLayerCaptures = response.captures.data_layer_evidence ?? [];
    assert.ok(dataLayerCaptures.length >= 2, "expected dataLayer evidence from at least two steps");
    assert.ok(dataLayerCaptures.some((entry) => entry.url === `${baseUrl}/start.html`));
    const successDataLayer = dataLayerCaptures.find((entry) => entry.url === `${baseUrl}/success.html`);
    assert.ok(successDataLayer, "expected dataLayer evidence captured on the success page");
    assert.ok(successDataLayer.raw.some((entry) => entry.event === "page_view" && entry.page === "success"));
    assert.ok(successDataLayer.raw.some((entry) => entry.event === "journey_complete"));

    // Simulated GA4 collect requests fired by both fixture pages must be observed and
    // their raw fictional parameters preserved, with no unrelated traffic mixed in.
    const ga4Captures = response.captures.ga4_network_events ?? [];
    assert.ok(ga4Captures.length >= 2, "expected a GA4-style request from each fixture page");
    for (const event of ga4Captures) {
      assert.ok(event.requestUrl.includes("/g/collect"));
      assert.equal(event.params?.tid, "G-FICTIONALTEST1");
    }
    assert.ok(ga4Captures.some((event) => event.params?.en === "page_view"));
    assert.ok(ga4Captures.some((event) => event.params?.en === "journey_complete"));

    // Finish-page CTAs: multiple visible CTAs on the success page, generic element
    // evidence only (no automotive-specific classification).
    const ctaCaptures = response.captures.finish_page_ctas ?? [];
    assert.ok(ctaCaptures.length >= 3, "expected multiple visible CTAs on the finish page");
    assert.ok(ctaCaptures.every((cta) => cta.pageUrl === `${baseUrl}/success.html`));
    const offersLink = ctaCaptures.find((cta) => cta.text === "View fictional offers");
    assert.ok(offersLink);
    assert.equal(offersLink?.elementType, "a");
    assert.equal(offersLink?.url, `${baseUrl}/offers.html`);
    const contactLink = ctaCaptures.find((cta) => cta.text === "Contact us");
    assert.equal(contactLink?.accessibleName, "Contact a fictional dealer");
    const newsletterButton = ctaCaptures.find((cta) => cta.text === "Subscribe to updates");
    assert.equal(newsletterButton?.elementType, "button");

    // page_metadata is raw, website-derived evidence (title/description/lang), not an
    // engine classification.
    const pageMetadata = response.captures.page_metadata ?? [];
    assert.ok(pageMetadata.length > 0);
    assert.equal(pageMetadata[0]?.title, "Success");
    assert.equal(pageMetadata[0]?.lang, "en");
    assert.ok(pageMetadata[0]?.description?.includes("Fixture success page"));

    // Screenshots are saved as artefacts on disk; the response only carries a path
    // reference, never embedded image data.
    const screenshots = response.captures.screenshots ?? [];
    assert.ok(screenshots.length > 0);
    for (const screenshot of screenshots) {
      const fileStat = await stat(screenshot.ref);
      assert.ok(fileStat.isFile() && fileStat.size > 0, `expected a screenshot file at ${screenshot.ref}`);
    }

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("capture modules only run when the task requests them", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-selective-capture",
      objective: "Reach the fixture's success page by following the visible continue control.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "reached_success_page",
          type: "url_pattern",
          description: "The current page URL matches the success fixture.",
          config: { pattern: `${baseUrl}/success.html` },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
      safety: {
        allowedActions: ["click", "wait", "capture", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission: false,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry: false,
      },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    assert.ok(response.captures.page_visits && response.captures.page_visits.length > 0);
    assert.equal(response.captures.page_metadata, undefined);
    assert.equal(response.captures.data_layer_evidence, undefined);
    assert.equal(response.captures.ga4_network_events, undefined);
    assert.equal(response.captures.screenshots, undefined);
    assert.equal(response.captures.finish_page_ctas, undefined);

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("safety layer blocks a task whose startUrl falls outside allowedDomains", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-blocked",
      objective: "Attempt to run against a host outside the allow-list.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["example-not-this-host.invalid"],
      successCriteria: [
        { id: "never", type: "url_pattern", description: "Never satisfied.", config: { pattern: "**/never.html" } },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 5, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_blocked", "stop_failure"] },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 0);
    assert.equal(response.diagnostics.finishReason, "domain_blocked");

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("limits guard stops the run once maxSteps is reached without a success state", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task: TaskRequest = {
      schemaVersion: "1.0.0",
      taskId: "local-poc-max-steps",
      objective: "Reach an unreachable success state so the step ceiling is exercised.",
      startUrl: `${baseUrl}/start.html`,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "unreachable",
          type: "url_pattern",
          description: "A page that is never navigated to in this fixture.",
          config: { pattern: `${baseUrl}/unreachable.html` },
        },
      ],
      captureModules: ["page_visits"],
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["click", "stop_success", "stop_failure"] },
      outputSchemaVersion: "1.0.0",
    };

    const response = await runTask({ page, task });

    assert.equal(response.status, "max_steps_reached");
    assert.equal(response.steps.length, 2);
    assert.equal(response.steps[0]?.selectedAction.type, "click");
    assert.ok(response.steps[1]?.safetyFlags?.includes("max_steps"));

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
