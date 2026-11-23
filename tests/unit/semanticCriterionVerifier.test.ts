import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClaudeSemanticCriterionVerifier,
  DEFAULT_SEMANTIC_MIN_CONFIDENCE,
  type SemanticVerificationInput,
} from "../../src/reasoning/semanticCriterionVerifier.js";
import type { ClaudeReasoningConfig } from "../../src/reasoning/config.js";
import { FakeReasoningModelClient, errorStep, resultStep } from "./fakes/fakeReasoningModelClient.js";

const TEST_CONFIG: ClaudeReasoningConfig = {
  apiKey: "test-fake-key-never-a-real-credential",
  model: "claude-sonnet-5",
  maxOutputTokens: 512,
  timeoutMs: 5000,
  maxRetries: 1,
  minConfidence: 0.5,
};

function buildInput(overrides: Partial<SemanticVerificationInput> = {}): SemanticVerificationInput {
  return {
    objective: "Reach the vehicle configurator.",
    criterionDescription: "Vehicle configuration controls are visible.",
    pageEvidence: { title: "Configurateur", headings: ["Configurez votre voiture"], interactiveText: ["Choisir"] },
    ...overrides,
  };
}

test("a satisfied, high-confidence verdict with evidence is accepted", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Configurateur / Choisir." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, true);
  assert.equal(outcome.confidence, 0.9);
  assert.equal(client.requests.length, 1);
  const diagnostics = verifier.getUsageDiagnostics();
  assert.equal(diagnostics.callCount, 1);
  assert.equal(diagnostics.satisfiedCount, 1);
  assert.equal(diagnostics.cacheHitCount, 0);
});

test("a not-satisfied verdict is rejected", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.95, evidence: "No matching evidence on this page." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(verifier.getUsageDiagnostics().rejectedCount, 1);
});

test("a satisfied verdict below the confidence gate is not accepted (never a single unsupported assertion)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: DEFAULT_SEMANTIC_MIN_CONFIDENCE - 0.01, evidence: "Weak match." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
});

test("a satisfied verdict with empty evidence is not accepted, even at high confidence", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.99, evidence: "" })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false, "an unsupported assertion (no cited evidence) must never satisfy the criterion");
});

test("an explicit minConfidence override is honoured", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.6, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client, minConfidence: 0.55 });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, true);
});

test("malformed (null) model output fails closed after retrying once, never satisfied", async () => {
  const client = new FakeReasoningModelClient([resultStep(null), resultStep(null)]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(client.requests.length, 2, "expected exactly one retry (2 attempts total), matching the hard-capped retry policy");
});

test("a provider error fails closed after retrying once, never satisfied", async () => {
  const client = new FakeReasoningModelClient([errorStep("timeout"), errorStep("timeout")]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const outcome = await verifier.verify(buildInput());

  assert.equal(outcome.satisfied, false);
  assert.equal(client.requests.length, 2);
});

test("identical (objective, criterion, page evidence) is cached: a second verify() call makes no new model call", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const input = buildInput();
  const first = await verifier.verify(input);
  const second = await verifier.verify({ ...input });

  assert.equal(client.requests.length, 1, "the second call must be served from cache, not a new model call");
  assert.deepEqual(second, first);
  const diagnostics = verifier.getUsageDiagnostics();
  assert.equal(diagnostics.callCount, 1);
  assert.equal(diagnostics.cacheHitCount, 1);
});

test("different page evidence for the same objective/criterion is verified independently (no cache collision)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "Unrelated page." }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Matching page." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const first = await verifier.verify(buildInput({ pageEvidence: { title: "Home", headings: [], interactiveText: [] } }));
  const second = await verifier.verify(
    buildInput({ pageEvidence: { title: "Configurateur", headings: ["Configurez"], interactiveText: ["Choisir"] } }),
  );

  assert.equal(first.satisfied, false);
  assert.equal(second.satisfied, true);
  assert.equal(client.requests.length, 2);
});

test("the prompt sent to the model never includes an action, URL, or selector vocabulary -- only objective/criterion/page-evidence text", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsedUser).sort(), ["criterionDescription", "objective", "pageEvidence"]);
});

// ---------------------------------------------------------------------------------------
// Widened evidence (ariaState/progressText on pageEvidence, optional lastActionEvidence):
// every field here is optional and additive -- the tests above (built via buildInput()'s
// defaults, which never set any of these) prove the payload shape is unchanged when they
// are absent. These prove they're included, verbatim, when present, and participate in the
// cache key so no two distinct pieces of evidence are ever conflated.
// ---------------------------------------------------------------------------------------

test("ariaState and progressText, when present on pageEvidence, are included in the prompt sent to the model", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({
      pageEvidence: {
        title: "Recapitulatif",
        headings: ["Configuration terminee"],
        interactiveText: ["Continuer"],
        ariaState: ["Continuer (aria-current=step)"],
        progressText: ["Step 4 of 4"],
      },
    }),
  );

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as { pageEvidence: Record<string, unknown> };
  assert.deepEqual(parsedUser.pageEvidence.ariaState, ["Continuer (aria-current=step)"]);
  assert.deepEqual(parsedUser.pageEvidence.progressIndicatorText, ["Step 4 of 4"]);
});

test("lastActionEvidence, when present, is included in the prompt sent to the model", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({ lastActionEvidence: { ctaText: "Continuer", accessibleName: "Continuer vers le recapitulatif", elementType: "button" } }),
  );

  const request = client.requests[0];
  assert.ok(request);
  const parsedUser = JSON.parse(request.userPrompt) as Record<string, unknown>;
  assert.deepEqual(parsedUser.lastActionEvidence, {
    ctaText: "Continuer",
    accessibleName: "Continuer vers le recapitulatif",
    elementType: "button",
  });
});

test("two calls with identical objective/criterion/pageEvidence but different lastActionEvidence are cached independently (no collision)", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "Wrong control was clicked." }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Completion control was clicked." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const first = await verifier.verify(buildInput({ lastActionEvidence: { ctaText: "Voir les offres" } }));
  const second = await verifier.verify(buildInput({ lastActionEvidence: { ctaText: "Continuer" } }));

  assert.equal(first.satisfied, false);
  assert.equal(second.satisfied, true);
  assert.equal(client.requests.length, 2, "different lastActionEvidence must not be served from the same cache entry");
});

// Item 4 (cache staleness fix, see CLAUDE.md and the BMW-enquire-panel investigation §9B):
// direct regression coverage on ClaudeSemanticCriterionVerifier's own buildCacheKey/cache
// behaviour, isolated from the rest of the engine (no Page, no RunState) -- the same
// content-identical-but-different-run-state shape the investigation found colliding.
test("item 4: identical page evidence with a different runStateMarker (surface generation/step) is verified independently, not served from a stale cache entry", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: false, confidence: 0.9, evidence: "No panel evidence yet -- nothing clicked." }),
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Panel evidence now present after the click." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  // Content-identical pageEvidence on both calls -- the exact shape that let a post-close
  // recheck's reverted DOM collide with a pre-click cache entry in the reported failure.
  const first = await verifier.verify(buildInput({ runStateMarker: { surfaceGeneration: 0, stepIndex: 2 } }));
  const second = await verifier.verify(buildInput({ runStateMarker: { surfaceGeneration: 1, stepIndex: 4 } }));

  assert.equal(first.satisfied, false);
  assert.equal(second.satisfied, true);
  assert.equal(
    client.requests.length,
    2,
    "a different runStateMarker must always be treated as independent evidence, never a stale cache hit",
  );
});

test("item 4: the SAME runStateMarker with identical page evidence still hits cache (the existing repeated-decision optimisation is preserved)", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Match." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const marker = { surfaceGeneration: 1, stepIndex: 4 };
  const first = await verifier.verify(buildInput({ runStateMarker: marker }));
  const second = await verifier.verify(buildInput({ runStateMarker: { ...marker } }));

  assert.equal(first.satisfied, true);
  assert.equal(second.satisfied, true);
  assert.equal(client.requests.length, 1, "an unchanged runStateMarker plus unchanged evidence must still be a cache hit");
  assert.equal(verifier.getUsageDiagnostics().cacheHitCount, 1);
});

test("item 4: panelEvidence, when present, is included in the prompt sent to the model and participates in the cache key", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Causally-linked panel present." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({
      panelEvidence: {
        identity: "dialog|Offer details",
        role: "dialog",
        headings: ["Offer details"],
        interactiveText: ["Request a Quote", "Close"],
        documentUsable: true,
        relevanceTier: "adopt",
        relevanceScore: 0.6,
        causallyLinked: true,
        causingControlLabel: "View Offer Details",
      },
    }),
  );

  const sentPrompt = JSON.parse(client.requests[0]!.userPrompt) as { panelEvidence?: { identity: string } };
  assert.equal(sentPrompt.panelEvidence?.identity, "dialog|Offer details");
});

// ---------------------------------------------------------------------------------------
// Cross-language panel verification fix (adopted-context panel-evidence corrective pass):
// a causally-linked, usable panel's own relevanceTier is only a same-language lexical-
// overlap score -- it must never be instructed as a hard veto, since that defeats the whole
// point of asking a meaning-based verifier about a panel whose content is in a different
// language than the criterion. The system prompt must still keep every fail-closed
// requirement (causallyLinked, documentUsable, genuine correspondence) that stops a bare
// click/tag from passing a panel-state criterion on its own.
// ---------------------------------------------------------------------------------------

test("cross-language panel fix: the system prompt never instructs a hard veto on reject/ambiguous relevanceTier", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Panel confirmed." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const systemPrompt = client.requests[0]!.system;
  assert.doesNotMatch(
    systemPrompt,
    /require the panel's own "relevanceTier" to not be "reject"/,
    "the prompt must no longer hard-veto a panel criterion purely on a same-language lexical relevanceTier score",
  );
  assert.match(systemPrompt, /different language/i, "the prompt must explain relevanceTier is not reliable across languages");
});

test("cross-language panel fix: the system prompt still requires causallyLinked, documentUsable, and genuine correspondence to fail closed", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "Panel confirmed." })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const systemPrompt = client.requests[0]!.system;
  assert.match(systemPrompt, /"causallyLinked" is false/);
  assert.match(systemPrompt, /"documentUsable" is false/);
  assert.match(
    systemPrompt,
    /verified click or a tracking tag firing is never by itself/,
    "a click/tag alone must still never be instructed as sufficient to pass a panel-state criterion",
  );
});

// ---------------------------------------------------------------------------------------
// criterionId diagnostics (additive, no behaviour change): lets a caller attribute a run's
// verifier decisions log to specific criteria (e.g. step-1 vs step-2) without inferring it
// from call order or evidence text. Never read by buildPrompt/buildCacheKey -- two different
// criteria with identical objective/criterionDescription/pageEvidence still legitimately
// share a cache entry.
// ---------------------------------------------------------------------------------------

test("criterionId is attributed per decision-log entry, including on a cache hit", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Configurateur / Choisir." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput({ criterionId: "step-1" }));
  // Identical objective/criterionDescription/pageEvidence -- same cache key -- but a
  // different criterionId, as two distinct milestones describing the same page state would.
  await verifier.verify(buildInput({ criterionId: "step-2" }));

  const decisions = verifier.getUsageDiagnostics().decisions;
  assert.ok(decisions);
  assert.equal(decisions!.length, 2);
  assert.equal(decisions![0]!.criterionId, "step-1");
  assert.equal(decisions![0]!.outcome, "satisfied");
  assert.equal(decisions![1]!.criterionId, "step-2");
  assert.equal(decisions![1]!.outcome, "cache_hit");
  // Only one real model call was made -- criterionId must not affect the cache key.
  assert.equal(client.requests.length, 1);
});

test("criterionId is omitted from a decision-log entry when the caller didn't supply one", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "Configurateur / Choisir." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const decisions = verifier.getUsageDiagnostics().decisions;
  assert.ok(decisions);
  assert.equal("criterionId" in decisions![0]!, false);
});

// ---------------------------------------------------------------------------------------
// PR A (evidence enrichment, see CLAUDE.md and the Peugeot 208 milestone-verifier
// investigation): bounded candidateElements evidence is forwarded into the prompt the model
// actually receives, the system prompt carries the rule for using it, and it is part of the
// cache key -- unlike criterionId, this evidence can legitimately change the verdict, so two
// calls that differ only in candidateElements must never share a cached decision.
// ---------------------------------------------------------------------------------------

test("candidateElements, when present, is forwarded into the user prompt payload", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "destinationUrl identifies the 208." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(
    buildInput({
      pageEvidence: {
        title: "Nos véhicules électriques",
        headings: ["Découvrez notre gamme électrique"],
        interactiveText: ["en savoir plus"],
        candidateElements: [
          { accessibleName: "en savoir plus", destinationUrl: "/nos-vehicules/208/electrique.html", role: "a" },
        ],
      },
    }),
  );

  assert.equal(client.requests.length, 1);
  const userPayload = JSON.parse(client.requests[0]!.userPrompt as string);
  assert.deepEqual(userPayload.pageEvidence.candidateElements, [
    { accessibleName: "en savoir plus", destinationUrl: "/nos-vehicules/208/electrique.html", role: "a" },
  ]);
});

test("the system prompt instructs the model on how (and how not) to use candidateElements", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "ok" })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput());

  const system = client.requests[0]!.system;
  assert.ok(system.includes("candidateElements"), "system prompt documents the candidateElements evidence shape");
  assert.ok(
    system.toLowerCase().includes("not sufficient evidence by itself"),
    "system prompt warns that a generic accessible label alone is not sufficient",
  );
  assert.ok(
    system.toLowerCase().includes("never prove that a click"),
    "system prompt bars candidateElements from proving click/navigation/later-state claims",
  );
});

test("an empty candidateElements array is never sent to the model (same as omitting it)", async () => {
  const client = new FakeReasoningModelClient([resultStep({ satisfied: true, confidence: 0.9, evidence: "ok" })]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  await verifier.verify(buildInput({ pageEvidence: { title: "T", headings: [], interactiveText: [], candidateElements: [] } }));

  const userPayload = JSON.parse(client.requests[0]!.userPrompt as string);
  assert.equal("candidateElements" in userPayload.pageEvidence, false);
});

test("two calls differing only in candidateElements never share a cached verdict", async () => {
  const client = new FakeReasoningModelClient([
    resultStep({ satisfied: true, confidence: 0.9, evidence: "First evidence set." }),
    resultStep({ satisfied: false, confidence: 0.9, evidence: "Second evidence set does not support it." }),
  ]);
  const verifier = new ClaudeSemanticCriterionVerifier({ config: TEST_CONFIG, modelClient: client });

  const base = { title: "T", headings: ["H"], interactiveText: ["I"] };
  const first = await verifier.verify(buildInput({ pageEvidence: { ...base, candidateElements: [{ accessibleName: "A", role: "a" }] } }));
  const second = await verifier.verify(buildInput({ pageEvidence: { ...base, candidateElements: [{ accessibleName: "B", role: "a" }] } }));

  assert.equal(client.requests.length, 2, "different candidateElements must each trigger a real model call, never a cache hit");
  assert.equal(first.satisfied, true);
  assert.equal(second.satisfied, false);
});
