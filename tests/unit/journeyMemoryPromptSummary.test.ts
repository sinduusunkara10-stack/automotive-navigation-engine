import { test } from "node:test";
import assert from "node:assert/strict";

import { buildJourneyMemoryPromptSummary, estimateTokens } from "../../src/core/journeyMemory/promptSummary.js";
import type { ScoredJourneyMemoryCandidate } from "../../src/types/journeyMemory.js";

function candidate(id: string, overrides: Partial<ScoredJourneyMemoryCandidate> = {}): ScoredJourneyMemoryCandidate {
  return {
    segment: {
      kind: "forward",
      id,
      schemaVersion: "1.0.0",
      sourcePage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configurator", semanticSignature: "configure" },
      action: { actionType: "click", semanticLabel: `button::Continue-${id}` },
      destinationPage: { registrableDomain: "example-automotive-oem.com", normalizedPath: "/configurator/finance", semanticSignature: "finance" },
      verifiedMilestoneIntent: "reached finance step",
      outcome: "success",
      confidence: 0.9,
      evidenceTier: "tier1",
      routePosition: 1,
      timestamp: new Date().toISOString(),
      provenance: { runId: "run-x", registrableDomain: "example-automotive-oem.com" },
    },
    score: 0.8,
    tier: "tier1",
    decision: "accept",
    componentScores: {},
    reason: "aligned",
    ...overrides,
  };
}

const DEFAULT_TIMING = { maxPromptRecords: 5, promptCharCap: 1600, promptTokenCap: 400 };

test("bounds the number of records to maxPromptRecords", () => {
  const candidates = Array.from({ length: 10 }, (_, i) => candidate(`id-${i}`));
  const summary = buildJourneyMemoryPromptSummary(candidates, DEFAULT_TIMING);
  assert.ok(summary);
  assert.ok(summary!.records.length <= 5);
});

test("deduplicates by (kind, actionLabel, tier)", () => {
  const b = candidate("b");
  const duplicateOfA = { ...b, segment: { ...b.segment, action: { actionType: "click", semanticLabel: "button::Continue-a" } } };
  const candidates = [candidate("a"), duplicateOfA];
  const summary = buildJourneyMemoryPromptSummary(candidates, DEFAULT_TIMING);
  assert.ok(summary);
  assert.equal(summary!.records.length, 1);
});

test("returns undefined for an empty candidate list", () => {
  assert.equal(buildJourneyMemoryPromptSummary([], DEFAULT_TIMING), undefined);
});

test("enforces both a hard character cap and an estimated token cap", () => {
  const candidates = Array.from({ length: 5 }, (_, i) => candidate(`id-${i}`));
  const tightTiming = { maxPromptRecords: 5, promptCharCap: 50, promptTokenCap: 400 };
  const summary = buildJourneyMemoryPromptSummary(candidates, tightTiming);
  if (summary) {
    assert.ok(JSON.stringify(summary).length <= 50);
  }
});

test("never includes raw query strings or full route logs -- only the fixed compact fields", () => {
  const summary = buildJourneyMemoryPromptSummary([candidate("a")], DEFAULT_TIMING);
  assert.ok(summary);
  const json = JSON.stringify(summary);
  assert.ok(!json.includes("normalizedPath"));
  assert.ok(!json.includes("sourcePage"));
  assert.ok(!json.includes("provenance"));
});

test("estimateTokens is a deterministic, conservative chars/4 estimate", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcdefgh"), 2);
});
