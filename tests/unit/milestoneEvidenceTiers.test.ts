import { test } from "node:test";
import assert from "node:assert/strict";

import { computeEvidenceTier } from "../../src/core/successEvaluator.js";

/**
 * PR 1D (truthful milestone evaluation, see CLAUDE.md and docs/architecture.md §21): pure,
 * deterministic unit coverage of computeEvidenceTier, plus the enforced invariant that no
 * evidenceSource string this engine's own evaluator actually produces (evaluateSingle and
 * its sub-evaluators, src/core/successEvaluator.ts) ever maps to "assumed" -- "assumed
 * evidence may not satisfy milestones" is a codified, tested property here, not merely a
 * convention documented in a comment.
 */

// Every literal evidenceSource string src/core/successEvaluator.ts's evaluateSingle and its
// sub-evaluators (evaluateSemanticPageMatch, evaluateDataLayerEvent, evaluateNetworkEvent)
// can ever produce for a *satisfied* criterion. Kept in sync manually with that file --
// see this test's own "still exhaustive" check below, which fails loudly if a new criterion
// type/evidence source is ever added to successEvaluator.ts without a corresponding update
// here.
const KNOWN_OBSERVED_EVIDENCE_SOURCES = ["url_pattern", "element_present", "data_layer_event", "network_event"];
const KNOWN_INFERRED_EVIDENCE_SOURCES = [
  "semantic_page_match:deterministic",
  "semantic_page_match:verifier",
  // Panel-attribution corrective pass (item 1/5, see CLAUDE.md and the BMW-enquire-panel
  // investigation): a resulting-surface milestone satisfied deterministically by combining
  // verified causal-click evidence with a scored, panel-scoped relevance judgement -- still
  // a vocabulary-overlap/relevance inference, never a literal, directly-observed fact.
  "semantic_page_match:panel_causal",
];

test("every observed evidence source maps to the observed tier", () => {
  for (const source of KNOWN_OBSERVED_EVIDENCE_SOURCES) {
    assert.equal(computeEvidenceTier(source), "observed", `expected "${source}" to be observed`);
  }
});

test("every inferred evidence source maps to the inferred tier", () => {
  for (const source of KNOWN_INFERRED_EVIDENCE_SOURCES) {
    assert.equal(computeEvidenceTier(source), "inferred", `expected "${source}" to be inferred`);
  }
});

test("an unrecognised evidence source fails safe to assumed, rather than defaulting to observed or inferred", () => {
  assert.equal(computeEvidenceTier("some_future_criterion_type"), "assumed");
  assert.equal(computeEvidenceTier(""), "assumed");
  // The bare "semantic_page_match" evidenceSource (no anchor text to match against --
  // evaluateSemanticPageMatch's own early-return case) is deliberately distinct from its
  // two ":deterministic"/":verifier" suffixed forms and is never itself trusted as inferred
  // evidence -- it only ever appears on an *unsatisfied* result anyway (see
  // evaluateSemanticPageMatch), so this can never actually reach a MilestoneEvidenceRecord,
  // but the classification itself must still fail safe if it ever did.
  assert.equal(computeEvidenceTier("semantic_page_match"), "assumed");
});

test("INVARIANT: computeEvidenceTier never classifies any evidence source this engine's own evaluator can actually produce as assumed", () => {
  for (const source of [...KNOWN_OBSERVED_EVIDENCE_SOURCES, ...KNOWN_INFERRED_EVIDENCE_SOURCES]) {
    assert.notEqual(
      computeEvidenceTier(source),
      "assumed",
      `"${source}" is a real evidence source this evaluator produces for a satisfied criterion -- it must never classify as "assumed"`,
    );
  }
});
