import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { adoptOrCapturePopup } from "../../src/capture-modules/popupCapture.js";
import { assessSurfaceRelevance } from "../../src/core/surfaceRelevance.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Surface-relevance corrective work, PR 4 widening (your reject-tier challenge, 2026-09-21):
 * a realistic, vendor-generic cookie-consent banner (zero vehicle/journey vocabulary, no
 * lucky title-tag overlap with the objective) scores 0 and lands core/surfaceRelevance.ts's
 * own three-tier assessment in "reject", not "ambiguous". Before this widening,
 * capture-modules/popupCapture.ts's own consent-only-candidate trigger was
 * `tier === "ambiguous" && uncertain`, so a genuine journey tab hidden behind exactly this
 * kind of banner was discarded as relevance_rejected before consent recovery ever ran. The
 * trigger is now `!relevanceAssessment.relevant`, which covers "reject" as well as
 * "ambiguous" -- see popupCapture.ts's own updated doc comments for why this adds no new
 * detection logic (assessConsentSurface, unchanged, already gates the actual interaction) and
 * preserves the fail-closed safety property (the reassessment after the one bounded click is
 * what decides adoption, never the trigger condition itself).
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";

test("reproduction: a realistic, non-vehicle-worded consent banner classifies as tier 'reject' (not 'ambiguous'), which is exactly why the old ambiguous-only trigger missed it", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-reject-tier.html`);
    const assessment = await assessSurfaceRelevance({ page, objectiveText: OBJECTIVE });
    assert.equal(assessment.score, 0);
    assert.equal(assessment.tier, "reject");
    assert.equal(assessment.uncertain, false);
    assert.equal(assessment.relevant, false);

    // The old trigger was `tier === "ambiguous" && uncertain` -- tier is "reject" here (just
    // asserted above), so that condition was false on this real-world-shaped candidate, which
    // is exactly what let it slip through undetected before this widening.
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("corrected behaviour: a new tab opens with a generic title and only a consent banner visible -- consent is accepted, the revealed content is rescored, and the tab is adopted", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-reject-tier.html`);
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: {},
      stepIndex: 0,
      captureModules: [],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "require_allowed_domain",
        allowedDomains: ["127.0.0.1"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveText: OBJECTIVE,
        consentInteractionPolicy: "accept_optional",
      },
    });

    // The initial score is still 0/"reject" -- proven by the reproduction test above. What
    // changed is that the candidate no longer gets discarded on that first score alone.
    assert.equal(result.consentOnlyCandidateHandling?.consentSurfaceDetected, true);
    assert.equal(result.consentOnlyCandidateHandling?.actionAttempted, true);
    assert.equal(result.consentOnlyCandidateHandling?.actionSucceeded, true);
    assert.equal(result.consentOnlyCandidateHandling?.reassessment?.tier, "adopt");
    assert.equal(result.consentOnlyCandidateHandling?.reassessment?.relevant, true);

    assert.equal(result.relevanceAssessment?.tier, "adopt");
    assert.equal(result.relevanceAssessment?.relevant, true);
    assert.ok(result.adoptedPage, "expected the candidate to be adopted once the real content was revealed and rescored");
    assert.equal(result.adoptionRejectedReason, undefined);

    const revealedTitle = await page.title();
    assert.equal(revealedTitle, "Vehicle Finance Application");
  } finally {
    await browser.close();
    await close();
  }
});

test("safety preserved: an irrelevant popup that also carries a genuine consent banner is still rejected after consent is accepted and the revealed content is rescored", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-consent-reject-tier-irrelevant.html`);
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: {},
      stepIndex: 0,
      captureModules: [],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "require_allowed_domain",
        allowedDomains: ["127.0.0.1"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveText: OBJECTIVE,
        consentInteractionPolicy: "accept_optional",
      },
    });

    // Consent was still accepted (exactly one attempt) -- widening the trigger does not skip
    // the interaction for an irrelevant popup, it only decides whether the interaction is
    // *tried*. What must never happen is adoption.
    assert.equal(result.consentOnlyCandidateHandling?.consentSurfaceDetected, true);
    assert.equal(result.consentOnlyCandidateHandling?.actionAttempted, true);
    assert.equal(result.consentOnlyCandidateHandling?.actionSucceeded, true);
    assert.equal(result.consentOnlyCandidateHandling?.reassessment?.relevant, false);

    assert.equal(result.adoptedPage, undefined, "an irrelevant candidate must never be adopted, even after a successful consent interaction");
    assert.equal(result.adoptionRejectedReason, "relevance_rejected");
    assert.equal(result.relevanceAssessment?.relevant, false);
  } finally {
    await browser.close();
    await close();
  }
});
