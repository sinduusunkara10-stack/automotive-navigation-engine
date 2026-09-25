import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyTier, isStructuralOnlyTier, TIER_CONFIDENCE_MULTIPLIER } from "../../src/core/journeyMemory/tiering.js";

test("classifyTier: same registrable domain + same market is tier1", () => {
  const tier = classifyTier({
    candidateDomain: "example-automotive-oem.com",
    currentDomain: "example-automotive-oem.com",
    candidateMarket: "uk",
    currentMarket: "UK",
  });
  assert.equal(tier, "tier1");
});

test("classifyTier: same domain, different market is tier2", () => {
  const tier = classifyTier({
    candidateDomain: "example-automotive-oem.com",
    currentDomain: "www.example-automotive-oem.com",
    candidateMarket: "uk",
    currentMarket: "de",
  });
  assert.equal(tier, "tier2");
});

test("classifyTier: different domain, same market is tier3", () => {
  const tier = classifyTier({
    candidateDomain: "example-competitor-oem.com",
    currentDomain: "example-automotive-oem.com",
    candidateMarket: "uk",
    currentMarket: "uk",
  });
  assert.equal(tier, "tier3");
});

test("classifyTier: different domain, different market is tier4 (last resort)", () => {
  const tier = classifyTier({
    candidateDomain: "example-competitor-oem.com",
    currentDomain: "example-automotive-oem.com",
    candidateMarket: "uk",
    currentMarket: "de",
  });
  assert.equal(tier, "tier4");
});

test("classifyTier: exact registrable-domain match is a hard boundary -- market/locale never fuzzy-matches domain", () => {
  const tier = classifyTier({
    candidateDomain: "totally-different-oem.example",
    currentDomain: "example-automotive-oem.com",
    candidateMarket: "uk",
    currentMarket: "de",
  });
  assert.equal(tier, "tier4");
});

test("tier confidence multipliers decrease strictly from tier1 to tier4", () => {
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier1 > TIER_CONFIDENCE_MULTIPLIER.tier2);
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier2 > TIER_CONFIDENCE_MULTIPLIER.tier3);
  assert.ok(TIER_CONFIDENCE_MULTIPLIER.tier3 > TIER_CONFIDENCE_MULTIPLIER.tier4);
});

test("isStructuralOnlyTier is true for every tier except tier1", () => {
  assert.equal(isStructuralOnlyTier("tier1"), false);
  assert.equal(isStructuralOnlyTier("tier2"), true);
  assert.equal(isStructuralOnlyTier("tier3"), true);
  assert.equal(isStructuralOnlyTier("tier4"), true);
});
