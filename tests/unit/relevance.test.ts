import { test } from "node:test";
import assert from "node:assert/strict";

import { objectiveRelevanceScore, rankByObjectiveRelevance } from "../../src/discovery/relevance.js";

test("scores zero when there is no word overlap", () => {
  assert.equal(objectiveRelevanceScore("reach the configurator", "About our company"), 0);
});

test("scores above zero when a candidate shares a word with the objective", () => {
  assert.ok(objectiveRelevanceScore("reach the configurator and build a car", "Start configurator") > 0);
});

test("stopwords do not count as overlap", () => {
  // "the" and "a" are shared but are stopwords; no other word overlaps.
  assert.equal(objectiveRelevanceScore("reach the configurator", "a the of"), 0);
});

test("empty objective or candidate text scores zero", () => {
  assert.equal(objectiveRelevanceScore("", "Start configurator"), 0);
  assert.equal(objectiveRelevanceScore("reach the configurator", ""), 0);
});

test("rankByObjectiveRelevance returns only positive-scoring items, ranked highest first, capped at limit", () => {
  const items = [
    { text: "About us" },
    { text: "Start the configurator now" },
    { text: "Configurator build summary" },
    { text: "Careers" },
  ];
  const ranked = rankByObjectiveRelevance(items, "complete the configurator build", (item) => item.text, 2);
  assert.equal(ranked.length, 2);
  assert.ok(ranked.every((item) => item.text.toLowerCase().includes("configurator")));
});
