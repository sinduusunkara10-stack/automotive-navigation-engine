import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { attemptConsentOnlyCandidateResolution } from "../../src/capture-modules/popupCapture.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Surface-relevance corrective work, PR 4 (consent-only-candidate handling, your decision 8):
 * direct coverage of attemptConsentOnlyCandidateResolution -- the one, deterministic,
 * policy-approved consent action against a not-yet-adopted candidate whose only content is a
 * genuine consent surface. Full wiring coverage (this mechanism actually being invoked, and
 * only when core/surfaceRelevance.ts's own result is exactly "ambiguous" + uncertain) is in
 * capture-modules/popupCapture.ts's own adoptOrCapturePopup, exercised implicitly by these
 * tests calling the exported mechanism with the same real page state adoptOrCapturePopup would
 * hand it.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";

test("accept_optional + a genuine consent-only candidate: exactly one accept action, then a correct reassessment once real content is revealed", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-only.html`);
    const outcome = await attemptConsentOnlyCandidateResolution({
      popup: page,
      objectiveText: OBJECTIVE,
      consentInteractionPolicy: "accept_optional",
    });
    assert.equal(outcome.consentSurfaceDetected, true);
    assert.equal(outcome.actionAttempted, true);
    assert.equal(outcome.actionSucceeded, true);
    assert.ok(outcome.reassessment, "expected a reassessment after the consent action succeeded");
    assert.equal(outcome.reassessment?.tier, "adopt");
    assert.equal(outcome.reassessment?.relevant, true);

    // Exactly one action: the banner is gone and the real content is what's left.
    const bannerGone = await page.evaluate(() => document.getElementById("banner") === null);
    assert.equal(bannerGone, true);
    await assert.rejects(page.locator("#reject-all").waitFor({ state: "attached", timeout: 200 }));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("any policy other than accept_optional: zero interaction attempted, banner left untouched", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-only.html`);
    const outcome = await attemptConsentOnlyCandidateResolution({
      popup: page,
      objectiveText: OBJECTIVE,
      consentInteractionPolicy: "reject_optional",
    });
    assert.equal(outcome.consentSurfaceDetected, true);
    assert.equal(outcome.actionAttempted, false);
    assert.equal(outcome.actionSucceeded, false);
    assert.equal(outcome.reassessment, undefined);

    const bannerStillPresent = await page.evaluate(() => document.getElementById("banner") !== null);
    assert.equal(bannerStillPresent, true, "zero interaction means the banner must be untouched");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("undefined consentInteractionPolicy (task never opted in): zero interaction attempted", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-only.html`);
    const outcome = await attemptConsentOnlyCandidateResolution({ popup: page, objectiveText: OBJECTIVE });
    assert.equal(outcome.actionAttempted, false);
    assert.equal(outcome.actionSucceeded, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("no genuine consent surface present: never invoked for an ordinary (non-consent) ambiguous candidate", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-ambiguous.html`);
    const outcome = await attemptConsentOnlyCandidateResolution({
      popup: page,
      objectiveText: OBJECTIVE,
      consentInteractionPolicy: "accept_optional",
    });
    assert.equal(outcome.consentSurfaceDetected, false);
    assert.equal(outcome.actionAttempted, false);
    assert.equal(outcome.actionSucceeded, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
