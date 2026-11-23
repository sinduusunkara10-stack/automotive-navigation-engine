import { test } from "node:test";
import assert from "node:assert/strict";

import { selectSemanticCandidateElements } from "../../src/core/semanticPageMatch.js";
import type { InteractiveElement } from "../../src/types/task-response.js";

/**
 * Pure unit coverage of selectSemanticCandidateElements (PR A, see CLAUDE.md and the
 * Peugeot 208 milestone-verifier investigation) -- no Playwright, no network: every
 * scenario is a hand-built InteractiveElement[] exercising the filtering/ranking/bounding
 * rules documented on that function itself.
 */
function el(overrides: Partial<InteractiveElement> & { id: string; role: string; accessibleName: string }): InteractiveElement {
  return overrides;
}

test("a generic-label element is selected via destinationUrl evidence when title/headings/text carry no matching token", () => {
  const anchorText = "The Peugeot electric vehicles page is loaded and the PEUGEOT 208 vehicle card is visible.";
  const elements: InteractiveElement[] = [
    el({
      id: "el-388",
      role: "a",
      accessibleName: "en savoir plus",
      destinationUrl: "https://www.peugeot.fr/nos-vehicules/208/electrique.html",
    }),
    el({ id: "el-1", role: "a", accessibleName: "Contactez-nous", destinationUrl: "https://www.peugeot.fr/contact.html" }),
  ];

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.equal(candidates.length, 1, "only the element whose destinationUrl shares a target token is relevant");
  assert.equal(candidates[0]?.accessibleName, "en savoir plus");
  assert.ok(candidates[0]?.destinationUrl?.includes("208"), "destinationUrl evidence is preserved, not dropped");
});

test("multiple genuine elements supporting the same target both survive -- never deduplicated to one entry per target", () => {
  const anchorText = "Reach the 208 configurator.";
  const elements: InteractiveElement[] = [
    el({ id: "el-1", role: "a", accessibleName: "Learn more", destinationUrl: "https://example.com/model/208" }),
    el({ id: "el-2", role: "a", accessibleName: "Configure", destinationUrl: "https://example.com/selector/configurable/208-5-portes/" }),
  ];

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.equal(candidates.length, 2, "both elements supporting the same 208 target are kept");
});

test("relevant candidates pointing at different plausible targets are both carried through selection (resolution is the verifier's job)", () => {
  const anchorText = "Reach either the 208 page or the 308 page.";
  const elements: InteractiveElement[] = [
    el({ id: "el-1", role: "a", accessibleName: "208 details", destinationUrl: "https://example.com/model/208" }),
    el({ id: "el-2", role: "a", accessibleName: "308 details", destinationUrl: "https://example.com/model/308" }),
  ];

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.equal(candidates.length, 2, "selection never resolves ambiguity itself -- it only bounds the evidence pool");
});

test("a covered element is excluded even when its destinationUrl would otherwise strongly match", () => {
  const anchorText = "Reach the 208 configurator.";
  const elements: InteractiveElement[] = [
    el({ id: "el-1", role: "a", accessibleName: "Configure the 208", destinationUrl: "https://example.com/model/208", covered: true }),
  ];

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.equal(candidates.length, 0, "a covered element is structural evidence of being obscured, not genuine page evidence");
});

test("the candidate list stays bounded and keeps the highest-relevance elements when more candidates exist than the cap", () => {
  const anchorText = "Reach the 208 configurator.";
  const elements: InteractiveElement[] = [];
  // 20 strongly-relevant 208 elements (more than the ~12 cap) plus a handful of irrelevant ones.
  for (let i = 0; i < 20; i += 1) {
    elements.push(
      el({ id: `el-208-${i}`, role: "a", accessibleName: `Configure the 208 variant ${i}`, destinationUrl: `https://example.com/selector/208/${i}` }),
    );
  }
  for (let i = 0; i < 5; i += 1) {
    elements.push(el({ id: `el-noise-${i}`, role: "a", accessibleName: `Unrelated link ${i}`, destinationUrl: "https://example.com/about" }));
  }

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.ok(candidates.length <= 12, `expected at most 12 candidates, got ${candidates.length}`);
  assert.ok(candidates.length > 0, "the relevant 208 elements must survive, not be crowded out by irrelevant noise");
  assert.ok(
    candidates.every((c) => c.accessibleName.includes("208")),
    "every surviving candidate is one of the relevant 208 elements, never the unrelated noise",
  );
});

test("no candidateElements source yields no candidates -- the no-candidate regression baseline", () => {
  assert.deepEqual(selectSemanticCandidateElements("Reach the 208 configurator.", undefined), []);
  assert.deepEqual(selectSemanticCandidateElements("Reach the 208 configurator.", []), []);
});

test("each selected candidate's text fields are length-capped", () => {
  const anchorText = "Reach the 208 configurator.";
  const longName = `Configure the 208 ${"x".repeat(200)}`;
  const longUrl = `https://example.com/selector/208/${"y".repeat(200)}`;
  const elements: InteractiveElement[] = [el({ id: "el-1", role: "a", accessibleName: longName, destinationUrl: longUrl })];

  const candidates = selectSemanticCandidateElements(anchorText, elements);

  assert.equal(candidates.length, 1);
  assert.ok(candidates[0]!.accessibleName.length <= 60, `accessibleName length ${candidates[0]!.accessibleName.length} exceeds cap`);
  assert.ok((candidates[0]!.destinationUrl?.length ?? 0) <= 120, "destinationUrl length exceeds cap");
});
