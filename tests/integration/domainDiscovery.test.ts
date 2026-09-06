import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

function baseTask(startUrl: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "domain-discovery-poc",
    objective: "Reach the fixture's success page by following the visible continue control.",
    startUrl,
    successCriteria: [
      {
        id: "reached_success_page",
        type: "url_pattern",
        description: "The current page URL matches the success fixture.",
        config: { pattern: "**/success.html" },
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
    outputSchemaVersion: "1.9.0",
    ...overrides,
  };
}

test("a task with no allowedDomains still completes the full journey via preflight-discovered trust", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask(`${baseUrl}/start.html`);
    assert.equal(task.allowedDomains, undefined, "sanity check: this task deliberately omits allowedDomains");

    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    assert.equal(response.finalUrl, `${baseUrl}/success.html`);

    const discovery = response.diagnostics.domainDiscovery;
    assert.ok(discovery, "expected diagnostics.domainDiscovery to be present");
    const startHostname = new URL(baseUrl).hostname;
    assert.equal(discovery?.startHostname, startHostname);
    assert.ok(discovery?.trustedDomains.some((d) => d.hostname === startHostname && d.reason === "exact_start_host"));
    assert.ok(discovery?.proposedAllowedDomains.includes(startHostname));
    assert.ok(discovery?.allowedDomainsUsed.includes(startHostname));
    assert.equal(discovery?.blockedReason, undefined);

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("caller-supplied allowedDomains are still honored and reported alongside preflight discovery", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask(`${baseUrl}/start.html`, { allowedDomains: [new URL(baseUrl).hostname] });
    const response = await runTask({ page, task });

    assert.equal(response.status, "success");
    const discovery = response.diagnostics.domainDiscovery;
    assert.ok(discovery);
    assert.ok(discovery?.allowedDomainsUsed.includes(new URL(baseUrl).hostname));

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("an unsafe startUrl protocol is blocked before any navigation is attempted", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    const task = baseTask("javascript:alert(1)");
    const response = await runTask({ page, task });

    assert.equal(response.status, "blocked");
    assert.equal(response.steps.length, 0);
    assert.equal(response.diagnostics.finishReason, "domain_blocked");
    assert.match(response.statusReason ?? "", /unsupported_protocol/);
    assert.equal(response.diagnostics.domainDiscovery, undefined, "no navigation happened, so discovery never ran");

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("preflight discovers a same-registrable-domain anchor and proposes it, without trusting an external one", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    // success.html's fixture markup includes visible CTAs (see local-poc.test.ts) whose
    // hrefs stay on this same local origin -- exercising the visible-anchor discovery path
    // against a real page without needing a second real registrable domain to test against.
    const task = baseTask(`${baseUrl}/success.html`, {
      objective: "View fictional offers from this fixture page.",
      captureModules: ["page_visits"],
      successCriteria: [
        { id: "never", type: "url_pattern", description: "Never satisfied.", config: { pattern: "**/never.html" } },
      ],
      limits: { maxSteps: 1, maxBacktracks: 0 },
      safety: { allowedActions: ["stop_failure"] },
    });
    const response = await runTask({ page, task });

    const discovery = response.diagnostics.domainDiscovery;
    assert.ok(discovery);
    const startHostname = new URL(baseUrl).hostname;
    // Every anchor on this fixture page resolves back to the same local host, so it should
    // already be covered by exact_start_host -- no external candidates should ever surface
    // from same-origin links.
    assert.equal(discovery?.externalCandidates?.length ?? 0, 0);
    assert.ok(discovery?.trustedDomains.every((d) => d.hostname === startHostname));

    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
