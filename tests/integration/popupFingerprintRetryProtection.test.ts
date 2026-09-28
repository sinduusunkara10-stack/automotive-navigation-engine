import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { adoptOrCapturePopup } from "../../src/capture-modules/popupCapture.js";
import { computeCandidateSurfaceFingerprint } from "../../src/core/surfaceFingerprint.js";
import { RunState } from "../../src/core/state.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Popup fingerprinting and retry protection (surface-adoption corrective work): the confirmed
 * production failure kept reopening and rescoring the exact same rejected popup until
 * stale_target_recovery_exhausted. This is the fix: the same candidate (same triggering click
 * reopening the same host+path) is recognized on a repeat encounter and its cached outcome is
 * reused rather than rescored -- see core/surfaceFingerprint.ts and
 * RunState.getPopupFingerprintOutcome/recordPopupFingerprintOutcome.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";
const TRIGGERING_ACTION_FINGERPRINT = 'click::button::"View Offer"';

async function openPopupTo(page: Page, url: string): Promise<Page> {
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.evaluate((u) => window.open(u, "_blank"), url),
  ]);
  return popup;
}

test("a repeated encounter of the same fingerprint reuses the cached rejection instead of rescoring", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const opener = await browser.newPage();
  const state = new RunState();
  try {
    await opener.goto(`${baseUrl}/surface-adopt-source-blank.html`);

    const surfaceAdoption = {
      enabled: true,
      domainPolicy: "require_allowed_domain" as const,
      allowedDomains: ["127.0.0.1"],
      adoptedSurfaceCount: 0,
      maxAdoptedSurfacesPerRun: 5,
      relevanceObjectiveTexts: [OBJECTIVE],
      triggeringActionFingerprint: TRIGGERING_ACTION_FINGERPRINT,
      popupFingerprintLookup: (fingerprint: string) => state.getPopupFingerprintOutcome(fingerprint),
      recordPopupFingerprintOutcome: (fingerprint: string, tier: "adopt" | "reject" | "ambiguous", score: number) =>
        state.recordPopupFingerprintOutcome(fingerprint, tier, score),
    };

    const firstPopup = await openPopupTo(opener, `${baseUrl}/surface-relevance-survey.html`);
    const first = await adoptOrCapturePopup({ popup: firstPopup, captures: {}, stepIndex: 0, captureModules: [], surfaceAdoption });
    assert.equal(first.adoptionRejectedReason, "relevance_rejected");
    assert.equal(first.fingerprintPreviouslySeen, false, "the first encounter has no prior cached outcome");
    assert.equal(first.popupReconsiderationReason, undefined, "the first encounter always runs the real assessment");
    assert.ok(first.candidateSurfaceFingerprint);

    const secondPopup = await openPopupTo(opener, `${baseUrl}/surface-relevance-survey.html`);
    const second = await adoptOrCapturePopup({ popup: secondPopup, captures: {}, stepIndex: 1, captureModules: [], surfaceAdoption });
    assert.equal(second.adoptionRejectedReason, "relevance_rejected");
    assert.equal(second.fingerprintPreviouslySeen, true, "the same candidate was already scored once this run");
    assert.equal(
      second.popupReconsiderationReason,
      "cached_no_new_evidence",
      "a repeat of the same fingerprint must reuse the cached outcome rather than rescoring",
    );
    assert.equal(second.candidateSurfaceFingerprint, first.candidateSurfaceFingerprint);
  } finally {
    await opener.close();
    await browser.close();
    await close();
  }
});

test("computeCandidateSurfaceFingerprint excludes query parameters and is stable for the same host+path+triggering click", () => {
  const a = computeCandidateSurfaceFingerprint({
    candidateUrl: "https://example-competitor-oem.test/offers/summary?sessionToken=abc123&customerEmail=x@example.com",
    triggeringActionFingerprint: TRIGGERING_ACTION_FINGERPRINT,
  });
  const b = computeCandidateSurfaceFingerprint({
    candidateUrl: "https://example-competitor-oem.test/offers/summary?sessionToken=zzz999",
    triggeringActionFingerprint: TRIGGERING_ACTION_FINGERPRINT,
  });
  assert.equal(a, b, "the same host+path+triggering click must fingerprint identically regardless of query parameters");
  assert.ok(!a?.includes("sessionToken"));
  assert.ok(!a?.includes("customerEmail"));

  const differentPath = computeCandidateSurfaceFingerprint({
    candidateUrl: "https://example-competitor-oem.test/offers/other-page",
    triggeringActionFingerprint: TRIGGERING_ACTION_FINGERPRINT,
  });
  assert.notEqual(a, differentPath);
});
