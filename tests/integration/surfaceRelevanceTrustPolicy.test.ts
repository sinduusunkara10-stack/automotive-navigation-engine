import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { adoptOrCapturePopup } from "../../src/capture-modules/popupCapture.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Surface-relevance corrective work, PR 5 (trust-policy integration, your decision 6): direct
 * coverage that relevance (core/surfaceRelevance.ts) and domain policy
 * (core/surfaceAdoption.ts's decideSurfaceAdoption, unchanged) are correctly ordered and never
 * conflated -- extend_trust_from_landing's own domain-trust extension is never applied to a
 * relevance-rejected candidate, and a relevant candidate on an untrusted domain under
 * require_allowed_domain is still rejected (for domain reasons, not relevance) -- relevance
 * passing alone never adopts.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";

test("extend_trust_from_landing: a relevant candidate outside allowedDomains is adopted, with extendedAllowedDomain naming its own hostname", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-finance.html`);
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: {},
      stepIndex: 0,
      captureModules: [],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "extend_trust_from_landing",
        allowedDomains: ["example-not-this-host.test"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveText: OBJECTIVE,
      },
    });
    assert.ok(result.adoptedPage, "expected the relevant candidate to be adopted");
    assert.equal(result.extendedAllowedDomain, "127.0.0.1");
    assert.equal(result.relevanceAssessment?.relevant, true);
  } finally {
    await browser.close();
    await close();
  }
});

test("extend_trust_from_landing: a relevance-rejected candidate never gets extendedAllowedDomain, even though its domain is untrusted (relevance and domain rejection are never conflated)", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-survey.html`);
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: {},
      stepIndex: 0,
      captureModules: [],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "extend_trust_from_landing",
        allowedDomains: ["example-not-this-host.test"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveText: OBJECTIVE,
      },
    });
    assert.equal(result.adoptedPage, undefined, "an irrelevant candidate must never be adopted, regardless of domain policy");
    assert.equal(result.adoptionRejectedReason, "relevance_rejected");
    assert.equal(result.extendedAllowedDomain, undefined);
    assert.equal(result.relevanceAssessment?.relevant, false);
  } finally {
    await browser.close();
    await close();
  }
});

test("require_allowed_domain: a relevant candidate on an untrusted domain is still rejected -- relevance passing alone never adopts", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-finance.html`);
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: {},
      stepIndex: 0,
      captureModules: [],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "require_allowed_domain",
        allowedDomains: ["example-not-this-host.test"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveText: OBJECTIVE,
      },
    });
    assert.equal(result.adoptedPage, undefined);
    // Not "relevance_rejected" -- the candidate cleared the relevance gate and was correctly
    // rejected for the *domain* reason instead, proving the two reasons are never conflated.
    assert.equal(result.adoptionRejectedReason, "domain_rejected");
    assert.equal(result.relevanceAssessment?.relevant, true);
  } finally {
    await browser.close();
    await close();
  }
});
