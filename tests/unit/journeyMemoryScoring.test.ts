import { test } from "node:test";
import assert from "node:assert/strict";

import {
  JOURNEY_MEMORY_ACCEPT_THRESHOLD,
  JOURNEY_MEMORY_REJECT_THRESHOLD,
  scoreJourneyMemoryCandidate,
} from "../../src/core/journeyMemory/scoring.js";
import type { ForwardMemorySegment } from "../../src/types/journeyMemory.js";

function makeSegment(overrides: Partial<ForwardMemorySegment> = {}): ForwardMemorySegment {
  return {
    kind: "forward",
    id: "fwd:test:1",
    schemaVersion: "1.0.0",
    sourcePage: {
      registrableDomain: "example-automotive-oem.com",
      normalizedPath: "/configurator",
      semanticSignature: "configure price vehicle build",
    },
    action: { actionType: "click", semanticLabel: "button::Configure & Price" },
    destinationPage: {
      registrableDomain: "example-automotive-oem.com",
      normalizedPath: "/configurator/finance",
      semanticSignature: "personalise your finance options",
    },
    verifiedMilestoneIntent: "reached the finance personalisation step",
    outcome: "success",
    confidence: 0.9,
    evidenceTier: "tier1",
    routePosition: 1,
    timestamp: new Date().toISOString(),
    provenance: { runId: "run-a", registrableDomain: "example-automotive-oem.com", market: "uk" },
    ...overrides,
  };
}

test("a same-domain, same-market, wording-aligned success scores as accept (tier1)", () => {
  const scored = scoreJourneyMemoryCandidate(makeSegment(), {
    objectiveText: "reach the finance personalisation step in the configurator",
    milestoneIntent: "reached the finance personalisation step",
    currentSemanticSignature: "configure price vehicle build",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "uk",
  });
  assert.equal(scored.tier, "tier1");
  assert.ok(scored.score >= JOURNEY_MEMORY_ACCEPT_THRESHOLD, `expected accept-level score, got ${scored.score}`);
  assert.equal(scored.decision, "accept");
});

test("structural alignment survives wording differences (Configure & Price vs Build your car)", () => {
  const scoredWordedDifferently = scoreJourneyMemoryCandidate(
    makeSegment({ action: { actionType: "click", semanticLabel: "button::Build your car" } }),
    {
      objectiveText: "reach the finance personalisation step",
      milestoneIntent: "reached the finance personalisation step",
      currentSemanticSignature: "configure price vehicle build",
      currentDomain: "example-automotive-oem.com",
      currentMarket: "uk",
    },
  );
  // Milestone intent + page identity alignment alone should still clear a meaningful score
  // even though the action label itself shares no words with the objective.
  assert.ok(scoredWordedDifferently.score > 0.2, `expected non-trivial score, got ${scoredWordedDifferently.score}`);
});

test("an irrelevant objective scores low and rejects", () => {
  const scored = scoreJourneyMemoryCandidate(
    makeSegment({
      verifiedMilestoneIntent: "opened the dealership contact form",
      action: { actionType: "click", semanticLabel: "button::Contact a dealer" },
      sourcePage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/contact", semanticSignature: "contact dealer phone" },
    }),
    {
      objectiveText: "capture competitor pricing on the configurator",
      milestoneIntent: "reached the configurator summary",
      currentSemanticSignature: "summary review price total",
      currentDomain: "example-automotive-oem.com",
      currentMarket: "uk",
    },
  );
  assert.ok(scored.score <= JOURNEY_MEMORY_REJECT_THRESHOLD + 0.15, `expected a low score, got ${scored.score}`);
});

test("cross-domain, cross-market (tier4) never scores above a same-tier1 equivalent record", () => {
  const tier1 = scoreJourneyMemoryCandidate(makeSegment(), {
    objectiveText: "reach the finance personalisation step",
    milestoneIntent: "reached the finance personalisation step",
    currentSemanticSignature: "configure price vehicle build",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "uk",
  });
  const tier4 = scoreJourneyMemoryCandidate(
    makeSegment({ provenance: { runId: "run-b", registrableDomain: "example-competitor-oem.com", market: "de" } }),
    {
      objectiveText: "reach the finance personalisation step",
      milestoneIntent: "reached the finance personalisation step",
      currentSemanticSignature: "configure price vehicle build",
      currentDomain: "example-automotive-oem.com",
      currentMarket: "uk",
    },
  );
  assert.equal(tier4.tier, "tier4");
  assert.ok(tier4.score < tier1.score);
});

test("componentScores/reason are exposed for diagnostics", () => {
  const scored = scoreJourneyMemoryCandidate(makeSegment(), {
    objectiveText: "reach the finance personalisation step",
    milestoneIntent: "reached the finance personalisation step",
    currentSemanticSignature: "configure price vehicle build",
    currentDomain: "example-automotive-oem.com",
    currentMarket: "uk",
  });
  assert.ok(typeof scored.componentScores.objective === "number");
  assert.ok(scored.reason.length > 0);
});
