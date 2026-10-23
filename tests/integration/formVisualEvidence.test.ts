import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { VISUAL_EVIDENCE_MAX_SHOTS } from "../../src/diagnostics/visualEvidence.js";
import type { ActionExecutorResult } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const DEALERS_XML =
  '<?xml version="1.0" encoding="UTF-8"?><dealers><dealer><name>Garage Alpha Riverside</name><id>DLR-778899</id></dealer></dealers>';

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function run(fixture: string, env: Record<string, string | undefined>, setup?: (page: Page) => Promise<void>) {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    if (setup) await setup(page);
    await page.goto(`${baseUrl}/${fixture}`);
    const result = await withEnv(env, () => executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "visual" }));
    const confirmClicks = await page.evaluate(() => (window as unknown as { __confirmClicks?: number }).__confirmClicks ?? null);
    return { result, confirmClicks };
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

async function assertActionResultValid(result: ActionExecutorResult): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/actionResult`);
  assert.ok(validate);
  assert.ok(validate({ ...result, interactionOutcome: "IN_PAGE_STATE_CHANGE" }), ajv.errorsText(validate.errors));
}

function assertJpeg(dataBase64: string): void {
  const bytes = Buffer.from(dataBase64, "base64");
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
}

test("visual evidence: off unless FORM_VISUAL_EVIDENCE=1", async () => {
  const { result } = await run("lead-form-dealer-xml-lookup.html", { FORM_VISUAL_EVIDENCE: undefined }, (page) =>
    page.route("**/api/dealers/search*", (route) => route.fulfill({ status: 200, contentType: "text/xml", body: DEALERS_XML })),
  );
  assert.equal(result.formVisualEvidence, undefined);
});

test("visual evidence: a resolved lookup and a Submit are photographed at each transition, bounded, schema-valid and with the same outcome as without capture", async () => {
  const setup = (page: Page) => page.route("**/api/dealers/search*", (route) => route.fulfill({ status: 200, contentType: "text/xml", body: DEALERS_XML }));
  const { result } = await run("lead-form-dealer-xml-lookup.html", { FORM_VISUAL_EVIDENCE: "1", FORM_DISCOVERY_DIAGNOSTIC: "1" }, setup);
  const { result: baseline } = await run("lead-form-dealer-xml-lookup.html", { FORM_VISUAL_EVIDENCE: undefined, FORM_DISCOVERY_DIAGNOSTIC: "1" }, setup);
  assert.equal(result.formFillOutcome, baseline.formFillOutcome);
  assert.equal(result.success, true);
  const evidence = result.formVisualEvidence;
  assert.ok(evidence);
  const stages = evidence.shots.map((s) => s.stage);
  assert.ok(stages.includes("lookup_after_input"));
  assert.ok(stages.includes("lookup_outcome"));
  assert.ok(stages.includes("submit_before_click"));
  assert.ok(stages.includes("submit_outcome"));
  assert.equal(evidence.shots.find((s) => s.stage === "submit_outcome")?.submitAttempt, 1);
  assert.ok(evidence.shots.length <= VISUAL_EVIDENCE_MAX_SHOTS);
  for (const shot of evidence.shots) {
    assertJpeg(shot.dataBase64);
    assert.ok(shot.byteLength > 0 && shot.byteLength < 400_000);
  }
  await assertActionResultValid(result);
});

test("visual evidence: a search/OK control that appears only after typing is photographed when it becomes usable, and after the late watch -- never clicked", async () => {
  const { result, confirmClicks } = await run("lead-form-dealer-confirm-control.html", { FORM_VISUAL_EVIDENCE: "1", FORM_DISCOVERY_DIAGNOSTIC: "1" });
  const stages = result.formVisualEvidence?.shots.map((s) => s.stage) ?? [];
  assert.ok(stages.includes("lookup_control_became_actionable"));
  assert.ok(stages.includes("lookup_outcome"));
  assert.ok(stages.includes("lookup_after_late_observation"));
  assert.equal(confirmClicks, 0);
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false);
});
