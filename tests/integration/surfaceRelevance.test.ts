import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { assessSurfaceRelevance } from "../../src/core/surfaceRelevance.js";
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
    const assessment = await assessSurfaceRelevance({ page, objectiveText: OBJECTIVE });
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
    const assessment = await assessSurfaceRelevance({ page, objectiveText: OBJECTIVE });
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
    const assessment = await assessSurfaceRelevance({ page, objectiveText: OBJECTIVE });
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
      objectiveText: OBJECTIVE,
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
      objectiveText: OBJECTIVE,
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
    const assessment = await assessSurfaceRelevance({ page, objectiveText: OBJECTIVE });
    assert.equal(assessment.tier, "adopt");
    assert.equal(assessment.relevant, true);
    assert.equal(assessment.resettled, true, "the blank-at-first-read candidate should have gone through the resettle path");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
