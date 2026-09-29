import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { adoptOrCapturePopup } from "../../src/capture-modules/popupCapture.js";
import { RunState } from "../../src/core/state.js";
import { startStaticServer } from "../helpers/staticServer.js";

/**
 * Final safety confirmation (owner-mandated corrective pass, follow-up to PR #71): direct proof
 * that the three-tier decision model never lets Claude override deterministic safety, that
 * deterministic tiers never pay for a Claude call, that the ambiguous band calls Claude at most
 * once per unchanged fingerprint, and that rich analytics evidence alone can never cause
 * adoption -- relevance and domain policy are the only inputs the decision reads.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";
const TRIGGERING_ACTION_FINGERPRINT = 'click::button::"View Offer"';

function countingResolver(verdict: { relevant: boolean; confidence: number; rationale: string }) {
  const calls: unknown[] = [];
  return {
    calls,
    resolver: {
      resolve: async (context: unknown) => {
        calls.push(context);
        return verdict;
      },
    },
  };
}

test("strong deterministic adopt never calls the Tier-3 resolver", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-finance.html`);
    const { calls, resolver } = countingResolver({ relevant: true, confidence: 0.95, rationale: "n/a" });
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
        relevanceObjectiveTexts: [OBJECTIVE],
        relevanceAmbiguityResolver: resolver,
      },
    });
    assert.ok(result.adoptedPage, "expected the strong-evidence candidate to adopt deterministically");
    assert.equal(calls.length, 0, "a deterministic adopt must never invoke the Claude ambiguity resolver");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("clear deterministic reject never calls the Tier-3 resolver", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-survey.html`);
    const { calls, resolver } = countingResolver({ relevant: true, confidence: 0.95, rationale: "n/a" });
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
        relevanceObjectiveTexts: [OBJECTIVE],
        relevanceAmbiguityResolver: resolver,
      },
    });
    assert.equal(result.adoptedPage, undefined, "expected the clearly-irrelevant candidate to reject deterministically");
    assert.equal(calls.length, 0, "a deterministic reject must never invoke the Claude ambiguity resolver, even though a resolver was supplied");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("ambiguous band: ONE Claude call is made, and a repeated encounter of the same fingerprint reuses the cached verdict rather than calling again", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const opener = await browser.newPage();
  const state = new RunState();
  try {
    await opener.goto(`${baseUrl}/surface-adopt-source-blank.html`);
    const { calls, resolver } = countingResolver({
      relevant: true,
      confidence: 0.9,
      rationale: "The heading 'Vehicle Details' plausibly continues the journey.",
    });

    const surfaceAdoption = {
      enabled: true,
      domainPolicy: "require_allowed_domain" as const,
      allowedDomains: ["127.0.0.1"],
      adoptedSurfaceCount: 0,
      maxAdoptedSurfacesPerRun: 5,
      relevanceObjectiveTexts: [OBJECTIVE],
      relevanceAmbiguityResolver: resolver,
      triggeringActionFingerprint: TRIGGERING_ACTION_FINGERPRINT,
      popupFingerprintLookup: (fingerprint: string) => state.getPopupFingerprintOutcome(fingerprint),
      recordPopupFingerprintOutcome: (fingerprint: string, tier: "adopt" | "reject" | "ambiguous", score: number) =>
        state.recordPopupFingerprintOutcome(fingerprint, tier, score),
    };

    const [firstPopup] = await Promise.all([
      opener.waitForEvent("popup"),
      opener.evaluate((u) => window.open(u, "_blank"), `${baseUrl}/surface-relevance-ambiguous.html`),
    ]);
    const first = await adoptOrCapturePopup({ popup: firstPopup, captures: {}, stepIndex: 0, captureModules: [], surfaceAdoption });
    assert.equal(first.adoptedPage?.url() ? true : false, true, "the ambiguous candidate should be adopted once Claude resolves it");
    assert.equal(calls.length, 1, "exactly one Claude call for the first, genuinely ambiguous encounter");

    const [secondPopup] = await Promise.all([
      opener.waitForEvent("popup"),
      opener.evaluate((u) => window.open(u, "_blank"), `${baseUrl}/surface-relevance-ambiguous.html`),
    ]);
    const second = await adoptOrCapturePopup({ popup: secondPopup, captures: {}, stepIndex: 1, captureModules: [], surfaceAdoption });
    assert.equal(second.popupReconsiderationReason, "cached_no_new_evidence");
    assert.equal(calls.length, 1, "a repeated encounter of the same fingerprint must reuse the cached verdict, not call Claude again");
  } finally {
    await opener.close();
    await browser.close();
    await close();
  }
});

test("domain policy overrides a confident Claude 'adopt': an ambiguous candidate Claude approves is still rejected on an untrusted domain under require_allowed_domain", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-ambiguous.html`);
    const { calls, resolver } = countingResolver({
      relevant: true,
      confidence: 0.97,
      rationale: "The page's own heading 'Vehicle Details' plausibly continues the vehicle configuration journey.",
    });
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
        relevanceObjectiveTexts: [OBJECTIVE],
        relevanceAmbiguityResolver: resolver,
      },
    });
    assert.equal(calls.length, 1, "Claude is still consulted for the genuinely ambiguous relevance question");
    assert.equal(result.relevanceAssessment?.relevant, true, "relevance itself was resolved 'relevant' by Claude");
    assert.equal(result.adoptedPage, undefined, "adoption must never be committed once the domain gate fails, regardless of Claude's relevance verdict");
    assert.equal(result.adoptionRejectedReason, "domain_rejected");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("analytics alone cannot cause adoption: a popup pre-loaded with strong GA4/dataLayer evidence is still relevance-rejected when its content is irrelevant", async () => {
  const { baseUrl, close } = await startStaticServer(new URL("../fixtures", import.meta.url).pathname);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/surface-relevance-survey.html`);
    const richAnalyticsCaptures = {
      ga4_network_events: [
        {
          stepIndex: 0,
          requestUrl: "https://www.google-analytics.com/g/collect?en=config_finished&vehicle_model=Electric+SUV",
          timestamp: new Date().toISOString(),
          method: "GET",
          params: { en: "config_finished", vehicle_model: "Electric SUV", price: "42000" },
          source: "popup_context" as const,
        },
      ],
      data_layer_evidence: [
        {
          stepIndex: 0,
          url: `${baseUrl}/surface-relevance-survey.html`,
          timestamp: new Date().toISOString(),
          raw: [{ event: "view_cart", vehicle_model: "Electric SUV" }],
          source: "popup_context" as const,
        },
      ],
    };
    const result = await adoptOrCapturePopup({
      popup: page,
      captures: richAnalyticsCaptures,
      stepIndex: 0,
      captureModules: ["ga4_network_events", "data_layer_evidence"],
      surfaceAdoption: {
        enabled: true,
        domainPolicy: "require_allowed_domain",
        allowedDomains: ["127.0.0.1"],
        adoptedSurfaceCount: 0,
        maxAdoptedSurfacesPerRun: 5,
        relevanceObjectiveTexts: [OBJECTIVE],
      },
    });
    assert.equal(result.adoptedPage, undefined, "strong pre-existing analytics evidence must never substitute for relevant page content");
    assert.equal(result.adoptionRejectedReason, "relevance_rejected");
    assert.equal(result.relevanceAssessment?.relevant, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
