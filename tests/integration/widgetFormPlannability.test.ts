import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { computeFormScore, FORM_SELECTION_ADOPT_THRESHOLD, selectBestForm, type FormJourneyContext } from "../../src/forms/formRelevance.js";
import type { ActionResult, FormScoringEvidence } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

// tests/fixtures/lead-form-widget-app.html is shaped like the form-platform widget in the
// 2026-10-27 live run evidence: 79 controls, 15 rendered and enabled, of which 8 are radios in four
// groups (private/business and three optional consents), plus a dealer-mode group whose native
// radios are not rendered but whose labels are. The per-field fill plan never completes a radio; the
// radio-group resolver does. Before the fix this form scored 5/15 and 0.39999999999999997 in both
// DOMs (model=preselected), exactly as the live run did, and was never filled.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const ENGLISH_STEPS: FormJourneyContext = {
  objective: "1. load the above start url\n2. fill out the details of the form\n3. submit the form\n4. stop and return",
  activeMilestoneTexts: ["fill out the details of the form", "submit the form", "stop and return"],
};

interface Run {
  result: ActionResult;
  evidence: FormScoringEvidence | undefined;
  posts: Record<string, string>[];
  searches: number;
}

async function fillWidget(query: string): Promise<Run> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  try {
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(`${baseUrl}/lead-form-widget-app.html?${query}`);
    const result = (await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], journeyContext: ENGLISH_STEPS })) as ActionResult;
    const counters = await page.evaluate(() => {
      const w = window as unknown as { __leadPosts: Record<string, string>[]; __searches: number };
      return { posts: w.__leadPosts, searches: w.__searches };
    });
    return { result, evidence: result.formDiscoveryDebug?.candidates[0]?.scoringEvidence, ...counters };
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
    await page.close();
    await browser.close();
    await close();
  }
}

test("form score: a weighted sum that is exactly the threshold is adopted, one just below is not", () => {
  const base = {
    journeyContext: {},
    textSignals: { pageTitle: "", pageHeadings: [], nearestHeadingText: "", submitButtonText: "", formAttributesText: "" },
    visibilitySignals: { visible: true, inChrome: false, areaRatio: 0.3, hasNearbyHeading: true, hasVisibleSubmitButton: true },
  };
  const atThreshold = computeFormScore({ ...base, userActionableControlCount: 15, plannableFieldCount: 5 });
  assert.equal(atThreshold.journeyRelevanceScore, 0);
  assert.equal(atThreshold.visibilityProminenceScore, 1);
  assert.equal(atThreshold.totalFormScore, FORM_SELECTION_ADOPT_THRESHOLD);
  assert.equal(selectBestForm([{ index: 0, score: atThreshold }]).belowConfidenceThreshold, false);

  const below = computeFormScore({ ...base, userActionableControlCount: 100, plannableFieldCount: 33 });
  assert.ok(below.totalFormScore < FORM_SELECTION_ADOPT_THRESHOLD);
  assert.equal(selectBestForm([{ index: 0, score: below }]).belowConfidenceThreshold, true);
});

for (const model of ["empty", "preselected"] as const) {
  test(`widget form (model ${model}): every required control is planned and the form is filled and submitted once, in light DOM and open shadow DOM`, async () => {
    const runs: Run[] = [];
    for (const dom of ["light", "shadow"]) runs.push(await fillWidget(`dom=${dom}&model=${model}`));
    const [light, shadow] = runs;
    assert.deepEqual(shadow!.evidence, light!.evidence);

    for (const run of runs) {
      const evidence = run.evidence!;
      assert.equal(evidence.discoveredControls, 79);
      assert.equal(evidence.userActionableControls, 12, "7 fields and 5 radio groups, each group counted once");
      const groups = evidence.controls!.filter((c) => c.unit === "radio_group");
      assert.deepEqual(
        groups.map((g) => [g.fieldIds.length, g.plannable, g.action]),
        [
          [2, true, "customer_qualification"],
          [2, true, "ambiguous"],
          [2, true, "optional_marketing"],
          [2, true, "optional_profiling"],
          [2, true, "optional_third_party"],
        ],
      );
      const byLabel = new Map(evidence.controls!.filter((c) => c.unit === "field").map((c) => [c.label, c]));
      for (const label of ["Prénom*", "Nom*", "E-mail*", "Téléphone*"]) {
        assert.equal(byLabel.get(label)?.plannable, true, label);
        assert.equal(byLabel.get(label)?.required, true, label);
      }
      assert.equal(evidence.controls!.filter((c) => c.action === "dealer_search").length, 1);
      if (model === "preselected") {
        assert.equal(evidence.controls!.filter((c) => c.handledBy === "fill_plan").length, 5, "the per-field plan alone covers the same 5 controls the live run reported");
      }
      assert.equal(byLabel.get("Sélectionnez le modèle souhaité: *")?.handledBy, model === "preselected" ? "already_filled" : "fill_plan");
      assert.ok(run.result.formDiscoveryDiagnostics!.totalFormScore >= FORM_SELECTION_ADOPT_THRESHOLD);

      assert.equal(run.result.formFillOutcome, "submitted", JSON.stringify(run.result.formDiscoveryDiagnostics));
      assert.equal(run.result.formDiscoveryDiagnostics!.requiredFieldsFilled, run.result.formDiscoveryDiagnostics!.requiredFieldsDetected);
      assert.ok(run.searches >= 1);
      assert.equal(run.posts.length, 1, "the final Submit sent the lead exactly once");
      const body = run.posts[0]!;
      for (const key of ["firstName", "lastName", "email", "phone", "model", "engine", "dealerId"]) assert.ok(body[key], key);
      assert.equal(body.customerType, "private");
      assert.deepEqual([body.consent_promo, body.consent_profile, body.consent_partners], ["0", "0", "0"]);
    }
  });
}
