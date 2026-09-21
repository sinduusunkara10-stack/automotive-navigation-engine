import { test } from "node:test";
import assert from "node:assert/strict";

import {
  RELEVANCE_ADOPT_THRESHOLD,
  RELEVANCE_REJECT_THRESHOLD,
  resolveAmbiguousSurfaceRelevance,
  type SurfaceRelevanceAmbiguityContext,
  type SurfaceRelevanceAmbiguityResolution,
  type SurfaceRelevanceAmbiguityResolver,
} from "../../src/core/surfaceRelevance.js";

/**
 * Surface-relevance corrective work, PR 3: unit coverage for the parts of
 * src/core/surfaceRelevance.ts that don't require a real Playwright Page --
 * resolveAmbiguousSurfaceRelevance's independent-verification behaviour, mirroring
 * tests/unit/consentClassifier.test.ts's own coverage of resolveAmbiguousConsentSurface.
 * assessSurfaceRelevance's full three-tier orchestration (which does need a live Page, via
 * gatherSemanticPageSignals) is covered in tests/integration/surfaceRelevance.test.ts instead.
 */

const baseContext: SurfaceRelevanceAmbiguityContext = {
  objectiveText: "Complete the vehicle finance application on the partner's finance page.",
  title: "Finance Application",
  headings: ["Finance Application", "Apply for financing"],
  interactiveText: ["Start application", "Apply Now"],
  deterministicScore: 0.15,
};

function resolverReturning(resolution: SurfaceRelevanceAmbiguityResolution): SurfaceRelevanceAmbiguityResolver {
  return { resolve: async () => resolution };
}

test("RELEVANCE_ADOPT_THRESHOLD and RELEVANCE_REJECT_THRESHOLD are the approved initial calibration values (Option A)", () => {
  assert.equal(RELEVANCE_ADOPT_THRESHOLD, 0.35);
  assert.equal(RELEVANCE_REJECT_THRESHOLD, 0.08);
});

test("a confident resolution whose rationale cites real evidence from the observed surface is trusted", async () => {
  const resolver = resolverReturning({
    relevant: true,
    rationale: "The page's own heading 'Finance Application' matches the stated objective.",
    confidence: 0.9,
  });
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.deepEqual(result, {
    relevant: true,
    rationale: "The page's own heading 'Finance Application' matches the stated objective.",
  });
});

test("fails closed (undefined) when confidence is below the minimum bar", async () => {
  const resolver = resolverReturning({
    relevant: true,
    rationale: "The heading 'Finance Application' matches.",
    confidence: 0.5,
  });
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.equal(result, undefined);
});

test("fails closed (undefined) when the rationale is empty", async () => {
  const resolver = resolverReturning({ relevant: true, rationale: "   ", confidence: 0.95 });
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.equal(result, undefined);
});

test("fails closed (undefined) when the rationale cites nothing actually present in the observed evidence (never trusted blindly)", async () => {
  const resolver = resolverReturning({
    relevant: true,
    rationale: "This looks like a genuine checkout confirmation screen with a receipt number.",
    confidence: 0.95,
  });
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.equal(result, undefined);
});

test("fails closed (undefined) when the resolver call itself throws", async () => {
  const resolver: SurfaceRelevanceAmbiguityResolver = {
    resolve: async () => {
      throw new Error("boom");
    },
  };
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.equal(result, undefined);
});

test("a verified resolution can report the surface as not relevant, not just adopt-biased", async () => {
  const resolver = resolverReturning({
    relevant: false,
    rationale: "The interactive control 'Apply Now' is the only genuine content, but it's an unrelated newsletter signup, not financing.",
    confidence: 0.85,
  });
  const result = await resolveAmbiguousSurfaceRelevance(baseContext, resolver);
  assert.deepEqual(result, {
    relevant: false,
    rationale:
      "The interactive control 'Apply Now' is the only genuine content, but it's an unrelated newsletter signup, not financing.",
  });
});
