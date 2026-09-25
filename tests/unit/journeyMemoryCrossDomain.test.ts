import { test } from "node:test";
import assert from "node:assert/strict";

import { abstractSegmentForCrossDomain, isCrossDomainTier } from "../../src/core/journeyMemory/abstraction.js";
import {
  scoreJourneyMemoryCandidate,
  JOURNEY_MEMORY_ACCEPT_THRESHOLD,
  JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD,
} from "../../src/core/journeyMemory/scoring.js";
import { TIER_CONFIDENCE_MULTIPLIER } from "../../src/core/journeyMemory/tiering.js";
import type { ForwardMemorySegment } from "../../src/types/journeyMemory.js";

/**
 * Issue 2 (Tier3/4 cross-domain behaviour, binding acceptance-issue contract): unit proof
 * that (a) literal content (raw path, CTA/accessible-name text, brand/product tokens) from
 * an out-of-domain candidate never survives into what scoring returns as candidate.segment,
 * (b) purely structural/generic content does survive and can still be accepted, and (c)
 * Tier3/4 require a strictly stricter rawScore than Tier1/2, with monotonically decreasing
 * confidence by tier for an equivalent underlying match.
 */

function literalForwardSegment(overrides: Partial<ForwardMemorySegment> = {}): ForwardMemorySegment {
  return {
    kind: "forward",
    id: "fwd:test:1",
    schemaVersion: "1.0.0",
    sourcePage: {
      registrableDomain: "example-competitor-oem.com",
      normalizedPath: "/configure/mustang-gt/{id}",
      semanticSignature: "mustang gt configure trim select",
    },
    action: { actionType: "click", semanticLabel: "button::Configure Your Mustang GT" },
    destinationPage: {
      registrableDomain: "example-competitor-oem.com",
      normalizedPath: "/configure/mustang-gt/summary",
      semanticSignature: "mustang summary confirm price",
    },
    verifiedMilestoneIntent: "Complete the Mustang GT configurator",
    outcome: "success",
    confidence: 0.9,
    evidenceTier: "tier1",
    routePosition: 0,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-1", registrableDomain: "example-competitor-oem.com", market: "us" },
    ...overrides,
  };
}

test("isCrossDomainTier: only tier1 is same-domain (false); tier2/3/4 are cross-domain (true)", () => {
  assert.equal(isCrossDomainTier("tier1"), false);
  assert.equal(isCrossDomainTier("tier2"), true);
  assert.equal(isCrossDomainTier("tier3"), true);
  assert.equal(isCrossDomainTier("tier4"), true);
});

test("abstractSegmentForCrossDomain strips literal path/CTA/product-name content", () => {
  const segment = literalForwardSegment();
  const abstracted = abstractSegmentForCrossDomain(segment);
  assert.ok(abstracted.kind === "forward");

  const serialized = JSON.stringify(abstracted);
  for (const literal of ["mustang", "gt", "configure your mustang", "/configure/mustang-gt", "Mustang GT"]) {
    assert.ok(
      !serialized.toLowerCase().includes(literal.toLowerCase()),
      `expected abstracted segment to never contain literal "${literal}"; got: ${serialized}`,
    );
  }
  // Structural content (generic vocabulary) survives.
  assert.ok(abstracted.action.semanticLabel.includes("button"));
  assert.ok(abstracted.sourcePage.semanticSignature.includes("configure") || abstracted.sourcePage.semanticSignature.includes("select"));
  assert.match(abstracted.sourcePage.normalizedPath, /^depth:\d+(:has-id)?$/);
  assert.equal(abstracted.sourcePage.extractedFields, undefined);
});

test("abstractSegmentForCrossDomain never used for tier1 -- scoring returns the untouched literal segment for a same-domain candidate", () => {
  const segment = literalForwardSegment();
  const scored = scoreJourneyMemoryCandidate(segment, {
    objectiveText: "Complete the Mustang GT configurator",
    milestoneIntent: "Complete the Mustang GT configurator",
    currentSemanticSignature: "mustang gt configure trim select",
    currentDomain: "example-competitor-oem.com",
    currentMarket: "us",
  });
  assert.equal(scored.tier, "tier1");
  assert.ok(scored.segment.kind === "forward");
  assert.equal(scored.segment.action.semanticLabel, "button::Configure Your Mustang GT");
});

test("scoring strips literal content for a tier3 candidate (different domain, same market) before returning it", () => {
  const segment = literalForwardSegment();
  const scored = scoreJourneyMemoryCandidate(segment, {
    objectiveText: "Complete the configurator and view the summary",
    milestoneIntent: "Complete the configurator",
    currentSemanticSignature: "configure select summary confirm",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "us",
  });
  assert.equal(scored.tier, "tier3");
  const serialized = JSON.stringify(scored.segment);
  assert.ok(!serialized.toLowerCase().includes("mustang"));
  assert.ok(!serialized.includes("/configure/mustang-gt"));
});

test("scoring strips literal content for a tier4 candidate (different domain, different market) too", () => {
  const segment = literalForwardSegment({ provenance: { runId: "run-1", registrableDomain: "example-competitor-oem.com", market: "de" } });
  const scored = scoreJourneyMemoryCandidate(segment, {
    objectiveText: "Complete the configurator",
    milestoneIntent: "Complete the configurator",
    currentSemanticSignature: "configure select",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "us",
  });
  assert.equal(scored.tier, "tier4");
  const serialized = JSON.stringify(scored.segment);
  assert.ok(!serialized.toLowerCase().includes("mustang"));
});

test("a purely abstract/structural tier3 candidate (no brand tokens at all) IS retrievable, scoreable, and can reach 'accept'", () => {
  const structuralSegment: ForwardMemorySegment = {
    kind: "forward",
    id: "fwd:structural:1",
    schemaVersion: "1.0.0",
    sourcePage: { registrableDomain: "other-site.example", normalizedPath: "/configure/{id}", semanticSignature: "configure select option" },
    action: { actionType: "click", semanticLabel: "button::configure select option" },
    destinationPage: { registrableDomain: "other-site.example", normalizedPath: "/configure/summary", semanticSignature: "summary confirm price" },
    verifiedMilestoneIntent: "configure summary confirm",
    outcome: "success",
    confidence: 0.95,
    evidenceTier: "tier1",
    routePosition: 0,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-2", registrableDomain: "other-site.example", market: "us" },
  };
  const scored = scoreJourneyMemoryCandidate(structuralSegment, {
    objectiveText: "configure select option and confirm the summary",
    milestoneIntent: "configure summary confirm",
    currentSemanticSignature: "configure select option summary confirm price",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "us",
  });
  assert.equal(scored.tier, "tier3");
  assert.equal(scored.decision, "accept", `expected a strong structural-only tier3 match to be accepted; got score ${scored.score}, reason: ${scored.reason}`);
});

test("tier3/4 require a strictly higher rawScore bar than tier1/2 (constant ordering)", () => {
  assert.ok(JOURNEY_MEMORY_CROSS_DOMAIN_ACCEPT_THRESHOLD > JOURNEY_MEMORY_ACCEPT_THRESHOLD);
});

test("confidence (tier multiplier) decreases monotonically tier1 > tier2 > tier3 > tier4", () => {
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier1 > TIER_CONFIDENCE_MULTIPLIER.tier2);
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier2 > TIER_CONFIDENCE_MULTIPLIER.tier3);
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier3 > TIER_CONFIDENCE_MULTIPLIER.tier4);
});

test("an accepted tier3 candidate's confidence is lower than an equivalent accepted tier1 candidate's", () => {
  const tier1Segment: ForwardMemorySegment = {
    kind: "forward",
    id: "fwd:t1:1",
    schemaVersion: "1.0.0",
    sourcePage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configure/{id}", semanticSignature: "configure select option" },
    action: { actionType: "click", semanticLabel: "button::configure select" },
    destinationPage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configure/summary", semanticSignature: "summary confirm price" },
    verifiedMilestoneIntent: "configure summary confirm",
    outcome: "success",
    confidence: 0.95,
    evidenceTier: "tier1",
    routePosition: 0,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-3", registrableDomain: "example-automotive-oem.com", market: "us" },
  };
  const tier3Segment: ForwardMemorySegment = { ...tier1Segment, id: "fwd:t3:1", provenance: { runId: "run-4", registrableDomain: "other-site.example", market: "us" } };

  const input = {
    objectiveText: "configure select option and confirm the summary",
    milestoneIntent: "configure summary confirm",
    currentSemanticSignature: "configure select option summary confirm price",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "us",
  };
  const scoredTier1 = scoreJourneyMemoryCandidate(tier1Segment, input);
  const scoredTier3 = scoreJourneyMemoryCandidate(tier3Segment, input);
  assert.equal(scoredTier1.tier, "tier1");
  assert.equal(scoredTier3.tier, "tier3");
  assert.ok(scoredTier1.score > scoredTier3.score, `expected tier1 score (${scoredTier1.score}) > tier3 score (${scoredTier3.score})`);
});
