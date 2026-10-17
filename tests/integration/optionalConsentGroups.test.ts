import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { startStaticServer } from "../helpers/staticServer.js";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

async function runFixture(fixture: string): Promise<{ result: Awaited<ReturnType<typeof executeFillForm>>; checked: Record<string, string | null>; page: Page; done: () => Promise<void> }> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${baseUrl}/${fixture}`);
  const result = await executeFillForm({
    page,
    action: { type: "fill_form" },
    captures: {},
    stepIndex: 1,
    captureModules: [],
    submissionObservationConfig: { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 5_000, pollIntervalMs: 100 },
  });
  const checked = await page.evaluate(() => {
    const out: Record<string, string | null> = {};
    Array.from(document.querySelectorAll('input[type="radio"]')).forEach((el) => {
      const radio = el as HTMLInputElement;
      if (!(radio.name in out)) out[radio.name] = null;
      if (radio.checked) out[radio.name] = radio.id;
    });
    return out;
  });
  return {
    result,
    checked,
    page,
    done: async () => {
      await browser.close();
      await close();
    },
  };
}

test("consent: optional marketing, profiling and partner groups are each declined, in any language, from question text or group-name tokens alone", async () => {
  const { result, checked, done } = await runFixture("lead-form-consent-purposes.html");
  try {
    const byGroup = new Map(result.formConsentDiagnostics?.consentGroupDiagnostics.map((g) => [g.groupId, g]));
    assert.equal(byGroup.get("grpA")?.purpose, "optional_marketing");
    assert.equal(byGroup.get("grpB")?.purpose, "optional_profiling");
    assert.equal(byGroup.get("grpC")?.purpose, "optional_third_party");
    assert.equal(checked.grpA, "grpA-no");
    assert.equal(checked.grpB, "grpB-no");
    assert.equal(checked.grpC, "grpC-no");

    const tokenMarketing = byGroup.get("consent_flag_mrkt_prfl");
    const tokenPartner = byGroup.get("consent_flag_thirdparty");
    assert.equal(tokenMarketing?.questionFound, false, "no question text exists for this group");
    assert.match(tokenMarketing?.purposeEvidence ?? "", /name_token/);
    assert.ok(["optional_profiling", "optional_marketing"].includes(tokenMarketing?.purpose ?? ""));
    assert.equal(tokenPartner?.purpose, "optional_third_party");
    assert.equal(checked.consent_flag_mrkt_prfl, "tokA-no");
    assert.equal(checked.consent_flag_thirdparty, "tokB-no");

    for (const id of ["grpA", "grpB", "grpC", "consent_flag_mrkt_prfl", "consent_flag_thirdparty"]) {
      const g = byGroup.get(id);
      assert.equal(g?.interaction, "selected_decline", id);
      assert.equal(g?.checkedStateVerified, true, id);
      assert.equal(g?.checkedAfter, "negative", id);
    }
    assert.equal(result.success, true);
  } finally {
    await done();
  }
});

test("consent: required processing is accepted because the form marks it required, separately from the optional groups", async () => {
  const { result, checked, done } = await runFixture("lead-form-consent-purposes.html");
  try {
    const required = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "grpReq");
    assert.equal(required?.purpose, "required_privacy_processing");
    assert.equal(required?.requiredEvidence, "attribute");
    assert.equal(required?.interaction, "accepted_required");
    assert.equal(checked.grpReq, "grpReq-yes");
    assert.deepEqual(result.formConsentDiagnostics?.unresolvedRequiredConsentGroups, []);
  } finally {
    await done();
  }
});

test("consent: an ambiguous group and a bundled terms-plus-newsletter group are left untouched", async () => {
  const { result, checked, done } = await runFixture("lead-form-consent-purposes.html");
  try {
    const byGroup = new Map(result.formConsentDiagnostics?.consentGroupDiagnostics.map((g) => [g.groupId, g]));
    for (const id of ["grpAmb", "grpBundled"]) {
      assert.equal(byGroup.get(id)?.purpose, "ambiguous", id);
      assert.equal(byGroup.get(id)?.interaction, "left_untouched", id);
      assert.equal(byGroup.get(id)?.checkedStateVerified, null, id);
      assert.equal(checked[id], null, id);
    }
    assert.match(byGroup.get("grpBundled")?.purposeEvidence ?? "", /bundled/);
  } finally {
    await done();
  }
});

test("consent: a hidden responsive duplicate of a question is never interacted with; only the visible copy is answered", async () => {
  const { result, checked, done } = await runFixture("lead-form-consent-purposes.html");
  try {
    const group = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "grpD");
    assert.equal(group?.optionCount, 4);
    assert.equal(group?.visibleOptionCount, 2);
    assert.equal(group?.hiddenDuplicateCount, 2);
    assert.equal(checked.grpD, "grpD-no");
  } finally {
    await done();
  }
});

test("consent: a decline rendered as checked by default is explicitly clicked to commit it, and a pre-selected accept on an optional purpose is flipped", async () => {
  const { result, page, done } = await runFixture("lead-form-consent-preselected.html");
  try {
    const byGroup = new Map(result.formConsentDiagnostics?.consentGroupDiagnostics.map((g) => [g.groupId, g]));
    assert.equal(byGroup.get("news")?.checkedBefore, "negative");
    assert.equal(byGroup.get("news")?.interaction, "committed_preselected_decline");
    assert.equal(byGroup.get("prof")?.checkedBefore, "positive");
    assert.equal(byGroup.get("prof")?.interaction, "flipped_preselected_accept_to_decline");
    assert.equal(byGroup.get("prof")?.checkedAfter, "negative");
    assert.equal(result.success, true, "the widget only accepted answers it saw clicked");
    assert.deepEqual(await page.evaluate(() => (window as unknown as { __answers: unknown }).__answers), { news: "no", prof: "no" });
  } finally {
    await done();
  }
});

test("consent: a group revealed by an earlier answer is found on rescan and classified by purpose", async () => {
  const { result, checked, done } = await runFixture("lead-form-consent-groups-conditional.html");
  try {
    const revealed = result.formConsentDiagnostics?.consentGroupDiagnostics.find((g) => g.groupId === "consentC");
    assert.ok((result.formConsentDiagnostics?.conditionalConsentGroupsRevealed ?? 0) >= 1);
    assert.equal(revealed?.purpose, "optional_third_party");
    assert.equal(revealed?.interaction, "selected_decline");
    assert.equal(checked.consentC, "consentC-no");
  } finally {
    await done();
  }
});

test("consent: diagnostics never return the question text or option labels", async () => {
  const { result, done } = await runFixture("lead-form-consent-purposes.html");
  try {
    const serialized = JSON.stringify(result.formConsentDiagnostics);
    for (const fragment of ["Souhaitez-vous", "Dürfen", "Share my details", "politique de confidentialité", "colour", "\"Oui\"", "\"Non\""]) {
      assert.equal(serialized.includes(fragment), false, fragment);
    }
    assert.equal(serialized.includes("questionText"), false);
  } finally {
    await done();
  }
});

test("consent: the new consent diagnostics validate against the response schema's actionResult", async () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  const schema = JSON.parse(await readFile(join(__dirname, "..", "..", "schemas", "task-response.schema.json"), "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/actionResult` });
  for (const fixture of ["lead-form-consent-purposes.html", "lead-form-consent-preselected.html"]) {
    const { result, done } = await runFixture(fixture);
    try {
      const wire = JSON.parse(JSON.stringify({ ...result, interactionOutcome: "IN_PAGE_STATE_CHANGE" }));
      assert.equal(validate(wire), true, `${fixture}: ${ajv.errorsText(validate.errors)}`);
    } finally {
      await done();
    }
  }
});
