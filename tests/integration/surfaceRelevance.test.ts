import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { assessSurfaceRelevance, RELEVANCE_ADOPT_THRESHOLD } from "../../src/core/surfaceRelevance.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Surface-relevance corrective work, PR 3: direct integration coverage of
 * assessSurfaceRelevance's full three-tier orchestration against a real Playwright Page --
 * high-relevance adopt, low-relevance reject, the ambiguous band (both fail-closed-without-a-
 * resolver and resolved-via-a-verified-model-assist-resolver), and the not-yet-usable-document
 * bounded resettle path. Wiring-level coverage (this gate actually gating a real popup inside
 * click.ts/popupCapture.ts, and never consuming the adoption budget when it rejects) is in
 * tests/integration/surfaceAdoption.test.ts's own PR-3-boundary additions.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";

test("high relevance, usable document: adopt tier, no resettle needed", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-finance.html`);
    const assessment = await assessSurfaceRelevance({ page, objectiveTexts: [OBJECTIVE] });
    assert.equal(assessment.relevant, true);
    assert.equal(assessment.tier, "adopt");
    assert.ok(assessment.score >= 0.35, `expected score >= 0.35, got ${assessment.score}`);
    assert.equal(assessment.resettled, false);
    assert.equal(assessment.resolvedViaModelAssist, false);
    assert.equal(assessment.uncertain, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("low relevance, usable document: reject tier, no resettle needed", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-survey.html`);
    const assessment = await assessSurfaceRelevance({ page, objectiveTexts: [OBJECTIVE] });
    assert.equal(assessment.relevant, false);
    assert.equal(assessment.tier, "reject");
    assert.ok(assessment.score <= 0.08, `expected score <= 0.08, got ${assessment.score}`);
    assert.equal(assessment.resettled, false);
    assert.equal(assessment.uncertain, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("ambiguous band, no resolver supplied: bounded resettle runs once, then fails closed on adoption (uncertain: true)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-ambiguous.html`);
    const assessment = await assessSurfaceRelevance({ page, objectiveTexts: [OBJECTIVE] });
    assert.ok(
      assessment.score > 0.08 && assessment.score < 0.35,
      `expected an ambiguous-band score, got ${assessment.score}`,
    );
    assert.equal(assessment.tier, "ambiguous");
    assert.equal(assessment.resettled, true, "the one bounded resettle-and-rescore pass should have run");
    assert.equal(assessment.relevant, false, "never adopt on an unresolved ambiguous result -- fail closed");
    assert.equal(assessment.resolvedViaModelAssist, false);
    assert.equal(assessment.uncertain, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("ambiguous band, resolver returns a confident, evidence-citing 'relevant' resolution: adopted via verified model-assist", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-ambiguous.html`);
    const assessment = await assessSurfaceRelevance({
      page,
      objectiveTexts: [OBJECTIVE],
      ambiguityResolver: {
        resolve: async () => ({
          relevant: true,
          rationale: "The page's own heading 'Vehicle Details' plausibly continues the vehicle configuration journey.",
          confidence: 0.9,
        }),
      },
    });
    assert.equal(assessment.tier, "ambiguous");
    assert.equal(assessment.relevant, true);
    assert.equal(assessment.resolvedViaModelAssist, true);
    assert.equal(assessment.uncertain, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("ambiguous band, resolver returns a low-confidence resolution: still fails closed (never trusted below the confidence bar)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-ambiguous.html`);
    const assessment = await assessSurfaceRelevance({
      page,
      objectiveTexts: [OBJECTIVE],
      ambiguityResolver: {
        resolve: async () => ({
          relevant: true,
          rationale: "The heading 'Vehicle Details' might be related.",
          confidence: 0.4,
        }),
      },
    });
    assert.equal(assessment.relevant, false);
    assert.equal(assessment.resolvedViaModelAssist, false);
    assert.equal(assessment.uncertain, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("not-yet-usable document (genuinely blank at first read) is bounded-resettled, not instantly rejected -- once real matching content appears, it adopts", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-delayed-finance.html`);
    const assessment = await assessSurfaceRelevance({ page, objectiveTexts: [OBJECTIVE] });
    assert.equal(assessment.tier, "adopt");
    assert.equal(assessment.relevant, true);
    assert.equal(assessment.resettled, true, "the blank-at-first-read candidate should have gone through the resettle path");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// Regression: a confirmed production failure (relevanceScore ~0.0357, tier "reject") rejected
// a popup that was in fact the correct next-milestone destination, because core/loop.ts folded
// the objective and every success-criterion description -- most of them about earlier,
// unrelated steps -- into one blended anchor string before scoring. objectiveTokenCoverage
// divides by the anchor's own distinct-token count, so a long multi-step objective's later
// milestone (here, the finance step) could never clear the adopt threshold: the tokens from
// every *other* step it doesn't also restate count against it. assessSurfaceRelevance now
// scores each candidate anchor independently and takes the best match (mirrors
// core/successEvaluator.ts's own per-criterion anchorText, "not the blended one").
test("a candidate matching only one of several unrelated milestone descriptions is scored by its best-matching anchor, not diluted by the others", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-finance.html`);
    const unrelatedEarlierMilestones = [
      "Start from the product overview page and select a model to view.",
      "Click configure to open the configuration funnel for the selected model.",
      "Click continue to advance the configuration to the next step.",
      "Stop once a request has been submitted through the contact form.",
    ];
    // Sanity check: blended into one string the old way, this anchor set drowns out the one
    // relevant milestone and must NOT clear the adopt threshold -- otherwise this test would
    // not actually be exercising the dilution bug.
    const blendedScore = (
      await assessSurfaceRelevance({
        page,
        objectiveTexts: [[...unrelatedEarlierMilestones, OBJECTIVE].join(" ")],
      })
    ).score;
    assert.ok(blendedScore < RELEVANCE_ADOPT_THRESHOLD, `expected the blended anchor to score below adopt, got ${blendedScore}`);

    const assessment = await assessSurfaceRelevance({
      page,
      objectiveTexts: [...unrelatedEarlierMilestones, OBJECTIVE],
    });
    assert.equal(assessment.relevant, true);
    assert.equal(assessment.tier, "adopt");
    assert.ok(assessment.score >= RELEVANCE_ADOPT_THRESHOLD, `expected score >= adopt threshold, got ${assessment.score}`);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("an anchor list that is genuinely all noise still rejects (the fix does not make the gate more permissive)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-survey.html`);
    const assessment = await assessSurfaceRelevance({
      page,
      objectiveTexts: [
        "Open the vehicle configurator and select a trim option.",
        "Advance the configuration to the next funnel screen.",
        OBJECTIVE,
      ],
    });
    assert.equal(assessment.relevant, false);
    assert.equal(assessment.tier, "reject");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
