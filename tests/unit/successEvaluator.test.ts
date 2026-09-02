import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { evaluateSuccessCriteria, getMissingRequiredCriteriaIds } from "../../src/core/successEvaluator.js";
import { gatherSemanticPageSignals, scoreSemanticPageMatch } from "../../src/core/semanticPageMatch.js";
import type {
  SemanticCriterionVerifier,
  SemanticVerificationInput,
  SemanticVerificationOutcome,
} from "../../src/reasoning/semanticCriterionVerifier.js";
import type { SuccessCriterion } from "../../src/types/task-request.js";

/**
 * Direct, fast coverage of src/core/successEvaluator.ts against a real Playwright page (no
 * static server, no full navigate/observe/decide/act loop, no reasoning provider) --
 * scenarios that only need "does this criterion evaluate correctly against this page state
 * and this objective" are cheaper and more precise here than driving the whole engine.
 * Each test launches and closes its own browser, matching this repo's existing test style.
 */
async function withPage<T>(html: string, run: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await run(page);
  } finally {
    await page.close();
    await browser.close();
  }
}

function page_(body: string, title = "Fixture"): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

async function isSatisfied(
  html: string,
  objective: string,
  criterion: SuccessCriterion,
): Promise<boolean> {
  return withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective);
    return satisfied.includes(criterion.id);
  });
}

// ---------------------------------------------------------------------------------------
// semantic_page_match: successful destination detection, one scenario per supported
// journeyType. journeyType itself is never read by evaluateSuccessCriteria (it isn't a
// parameter) -- these objectives are the kind of free text a caller would realistically
// pair with that journeyType hint, chosen without any brand, market, language, CTA text,
// hostname, or CSS selector.
// ---------------------------------------------------------------------------------------

test("semantic_page_match: configurator_entry -- detects a reached configurator page from objective + page text alone", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_(
    "<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>" +
      '<a href="#trim">Select trim level</a><a href="#colour">Choose exterior colour</a>',
    "Configure Your Vehicle",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: model_discovery -- detects a full model lineup listing", async () => {
  const objective =
    "Browse the full model lineup and stop once a page listing available vehicle models is shown.";
  const criterion: SuccessCriterion = {
    id: "reached-model-lineup",
    type: "semantic_page_match",
    description: "A page listing available vehicle models is shown.",
  };
  const html = page_(
    "<h1>Explore Our Vehicle Models</h1><h2>Browse The Full Lineup Available</h2>" +
      '<a href="#compare">Compare models</a>',
    "All Models",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: dealer_locator -- detects a nearby dealer listing", async () => {
  const objective = "Find the dealer locator and stop once a list of nearby dealers is displayed.";
  const criterion: SuccessCriterion = {
    id: "reached-dealer-locator",
    type: "semantic_page_match",
    description: "Nearby dealers are shown in a list or map.",
  };
  const html = page_(
    "<h1>Dealer Locator</h1><h2>Nearby Dealers Shown On Map</h2>" + '<a href="#search">Search dealers near me</a>',
    "Find a Dealer",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: test_drive -- detects a test-drive booking page", async () => {
  const objective =
    "Reach the test drive booking page and stop once a form to book a test drive is available.";
  const criterion: SuccessCriterion = {
    id: "reached-test-drive-booking",
    type: "semantic_page_match",
    description: "A form to book a test drive is shown.",
  };
  const html = page_(
    "<h1>Test Drive Booking</h1><h2>Schedule And Book Your Test Drive — Now Shown And Available</h2>" +
      '<a href="#book">Book a test drive</a>',
    "Book a Test Drive",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: offers -- detects a current offers/incentives listing", async () => {
  const objective = "Reach the current offers and incentives page and stop once vehicle offers are listed.";
  const criterion: SuccessCriterion = {
    id: "reached-offers",
    type: "semantic_page_match",
    description: "Available vehicle offers and incentives are shown on this page.",
  };
  const html = page_(
    "<h1>Vehicle Offers &amp; Incentives</h1><h2>Current Offers Available Now — Shown Below</h2>" +
      '<a href="#offers">View offers</a>',
    "Current Offers",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

// ---------------------------------------------------------------------------------------
// semantic_page_match: the required non-happy-path scenarios.
// ---------------------------------------------------------------------------------------

test("semantic_page_match: a visually similar but incorrect page does not falsely satisfy the criterion", async () => {
  // Same objective as the configurator_entry scenario above, landed on a page that is
  // topically related (still about vehicles) but is the model-lineup page, not the
  // configurator -- only one incidental word ("vehicle") overlaps.
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_(
    "<h1>Explore Our Vehicle Models</h1><h2>Browse The Full Lineup Available</h2>",
    "All Models",
  );
  assert.equal(await isSatisfied(html, objective, criterion), false);
});

test("semantic_page_match: a page with no relevant evidence at all does not satisfy the criterion", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>About Our Company</h1><h2>Contact Us</h2>", "About");
  assert.equal(await isSatisfied(html, objective, criterion), false);
});

test("semantic_page_match: matching evidence still satisfies the criterion even alongside unrelated/conflicting page content", async () => {
  // The criterion is a positive, generic text-overlap signal -- it does not attempt to
  // detect "blocking" states (session-timeout banners, cookie walls, error messages) by
  // matching against a list of error phrases, because any such list would itself become
  // exactly the kind of ad hoc, non-generic vocabulary CLAUDE.md's non-negotiable design
  // rule forbids. A page carrying both the real target state and unrelated content is
  // expected to satisfy the criterion on the strength of the matching evidence.
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_(
    "<h1>Session Expired — Please Sign In Again</h1>" +
      "<h2>Vehicle Configurator</h2><h3>Configuration Controls Visible</h3>",
    "Configure Your Vehicle",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: an objective in a different language than the page does not falsely satisfy the criterion", async () => {
  // Known, documented limitation (docs/n8n-integration.md "Generic success criteria"):
  // this is literal-vocabulary overlap, not translation. An English objective against a
  // page whose text is entirely in French must not produce a false positive.
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_(
    "<h1>Configurateur Vehicule</h1><h2>Options De Configuration Visibles</h2>",
    "Configurez Votre Vehicule",
  );
  assert.equal(await isSatisfied(html, objective, criterion), false);
});

test("semantic_page_match: an objective authored in the page's own language does satisfy the criterion", async () => {
  // Same French page as above, but with an objective/description an operator targeting a
  // French-language site would realistically write in French -- shows the mechanism works
  // once the objective and page share vocabulary, regardless of which language that is.
  const objective = "Configurateur vehicule: arreter une fois les options de configuration visibles.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Options de configuration du vehicule visibles.",
  };
  const html = page_(
    "<h1>Configurateur Vehicule</h1><h2>Options De Configuration Visibles</h2>",
    "Configurez Votre Vehicule",
  );
  assert.equal(await isSatisfied(html, objective, criterion), true);
});

test("semantic_page_match: config.minScore can be tightened or loosened per criterion", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const html = page_(
    "<h1>Explore Our Vehicle Models</h1><h2>Browse The Full Lineup Available</h2>",
    "All Models",
  );
  const strict: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
    config: { minScore: 0.9 },
  };
  const loose: SuccessCriterion = { ...strict, config: { minScore: 0.05 } };
  assert.equal(await isSatisfied(html, objective, strict), false);
  assert.equal(await isSatisfied(html, objective, loose), true);
});

// ---------------------------------------------------------------------------------------
// Regression: the pre-existing criterion types are unaffected by the new objective
// parameter or the new criterion type sitting alongside them.
// ---------------------------------------------------------------------------------------

test("url_pattern: unaffected by an unrelated objective (existing behaviour preserved)", async () => {
  await withPage(page_("<h1>Success</h1>", "Success"), async (page) => {
    const criterion: SuccessCriterion = {
      id: "on-success-url",
      type: "url_pattern",
      description: "The current page is about:blank.",
      config: { pattern: "about:blank" },
    };
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      "This objective text shares no vocabulary with the criterion at all.",
    );
    assert.ok(satisfied.includes("on-success-url"));
  });
});

test("element_present: unaffected by an unrelated objective (existing behaviour preserved)", async () => {
  await withPage(
    page_('<p data-testid="success-marker">You have reached the success state.</p>', "Success"),
    async (page) => {
      const criterion: SuccessCriterion = {
        id: "success-marker-present",
        type: "element_present",
        description: "The success marker element is present.",
        config: { selector: '[data-testid="success-marker"]' },
      };
      const satisfied = await evaluateSuccessCriteria(
        page,
        [criterion],
        "This objective text shares no vocabulary with the criterion at all.",
      );
      assert.ok(satisfied.includes("success-marker-present"));
    },
  );
});

test("element_present: absent selector is correctly not satisfied", async () => {
  await withPage(page_("<h1>Nothing here</h1>", "Empty"), async (page) => {
    const criterion: SuccessCriterion = {
      id: "success-marker-present",
      type: "element_present",
      description: "The success marker element is present.",
      config: { selector: '[data-testid="success-marker"]' },
    };
    const satisfied = await evaluateSuccessCriteria(page, [criterion], "objective");
    assert.ok(!satisfied.includes("success-marker-present"));
  });
});

// ---------------------------------------------------------------------------------------
// getMissingRequiredCriteriaIds: the gate src/core/loop.ts consults before honouring
// stop_success. Pure logic, no page needed.
// ---------------------------------------------------------------------------------------

test("getMissingRequiredCriteriaIds: an omitted `required` defaults to required (matches the schema's declared default)", () => {
  const criteria: SuccessCriterion[] = [{ id: "a", type: "url_pattern", description: "d" }];
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set()), ["a"]);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a"])), []);
});

test("getMissingRequiredCriteriaIds: multiple required criteria are each tracked independently", () => {
  const criteria: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d", required: true },
    { id: "b", type: "element_present", description: "d", required: true },
    { id: "c", type: "element_present", description: "d", required: true },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a"])), ["b", "c"]);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a", "b"])), ["c"]);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a", "b", "c"])), []);
});

test("getMissingRequiredCriteriaIds: an unsatisfied optional criterion is never reported as missing", () => {
  const criteria: SuccessCriterion[] = [
    { id: "required-one", type: "url_pattern", description: "d", required: true },
    { id: "optional-one", type: "element_present", description: "d", required: false },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["required-one"])), []);
});

test("getMissingRequiredCriteriaIds: a task with no required criteria always returns empty, regardless of what's satisfied", () => {
  const criteria: SuccessCriterion[] = [
    { id: "optional-one", type: "url_pattern", description: "d", required: false },
    { id: "optional-two", type: "element_present", description: "d", required: false },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set()), []);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["optional-one"])), []);
});

// ---------------------------------------------------------------------------------------
// semantic_page_match: exact boundary behaviour of the minScore comparison (>=), since
// the enforcement gate's correctness depends on satisfied/unsatisfied being decided
// precisely at the configured threshold, not just "roughly around" it.
// ---------------------------------------------------------------------------------------

test("semantic_page_match: a score below minScore does not satisfy the criterion", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const html = page_(
    "<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>",
    "Configure Your Vehicle",
  );
  await withPage(html, async (page) => {
    const signals = await gatherSemanticPageSignals(page);
    const { overall } = scoreSemanticPageMatch(objective, signals, ["title", "headings", "interactiveElements"]);
    const criterion: SuccessCriterion = {
      id: "reached-configurator",
      type: "semantic_page_match",
      description: "",
      config: { minScore: overall + 0.05 },
    };
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective);
    assert.ok(!satisfied.includes("reached-configurator"));
  });
});

test("semantic_page_match: a score exactly at minScore satisfies the criterion (>= is inclusive)", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const html = page_(
    "<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>",
    "Configure Your Vehicle",
  );
  await withPage(html, async (page) => {
    const signals = await gatherSemanticPageSignals(page);
    const { overall } = scoreSemanticPageMatch(objective, signals, ["title", "headings", "interactiveElements"]);
    assert.ok(overall > 0, "fixture must produce a nonzero score for this boundary test to be meaningful");
    const criterion: SuccessCriterion = {
      id: "reached-configurator",
      type: "semantic_page_match",
      description: "",
      config: { minScore: overall },
    };
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective);
    assert.ok(satisfied.includes("reached-configurator"));
  });
});

test("semantic_page_match: a score above minScore satisfies the criterion", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const html = page_(
    "<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>",
    "Configure Your Vehicle",
  );
  await withPage(html, async (page) => {
    const signals = await gatherSemanticPageSignals(page);
    const { overall } = scoreSemanticPageMatch(objective, signals, ["title", "headings", "interactiveElements"]);
    const criterion: SuccessCriterion = {
      id: "reached-configurator",
      type: "semantic_page_match",
      description: "",
      config: { minScore: overall - 0.05 },
    };
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective);
    assert.ok(satisfied.includes("reached-configurator"));
  });
});

// ---------------------------------------------------------------------------------------
// Optional semanticVerifier escalation: evaluateSuccessCriteria/evaluateSemanticPageMatch
// only ever consult a supplied verifier as a *fallback*, and only for semantic_page_match,
// and only when the deterministic lexical score already fell short of minScore. This is
// what fixes the cross-language defect while keeping every other path (including
// same-language semantic_page_match, url_pattern, element_present) byte-for-byte
// unchanged when no verifier is supplied -- see the language-in-common tests above, which
// remain accurate documentation of the deterministic-only evaluator with no verifier.
// ---------------------------------------------------------------------------------------

function fakeVerifier(
  handler: (input: SemanticVerificationInput) => SemanticVerificationOutcome,
): SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } {
  const calls: SemanticVerificationInput[] = [];
  return {
    calls,
    async verify(input) {
      calls.push(input);
      return handler(input);
    },
  };
}

test("semanticVerifier is never consulted once the deterministic lexical score already clears minScore", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_(
    "<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>" +
      '<a href="#trim">Select trim level</a><a href="#colour">Choose exterior colour</a>',
    "Configure Your Vehicle",
  );
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 1, evidence: "should never be called" }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
  assert.equal(verifier.calls.length, 0, "the deterministic score alone already satisfied the criterion");
});

test("semanticVerifier is consulted, and its satisfied verdict is honoured, once the deterministic score falls short (the multilingual fix)", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  // French page: the deterministic English-vocabulary evaluator scores this at (or near)
  // zero -- see the "different language" test above for the no-verifier baseline.
  const html = page_(
    "<h1>Configurateur de véhicule</h1><h2>Options de configuration visibles</h2>",
    "Configurez votre véhicule",
  );
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.9, evidence: "Configurateur / Options de configuration." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0]?.objective, objective);
  assert.equal(verifier.calls[0]?.criterionDescription, criterion.description);
});

test("semanticVerifier is consulted, and its not-satisfied verdict is honoured, for an unrelated page in a different language", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>À propos de notre entreprise</h1><h2>Contactez-nous</h2>", "À propos");
  const verifier = fakeVerifier(() => ({ satisfied: false, confidence: 0.95, evidence: "No configurator evidence on this page." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(!satisfied.includes("reached-configurator"));
  });
  assert.equal(verifier.calls.length, 1);
});

// ---------------------------------------------------------------------------------------
// Arbitrary objective-language / page-language pairs (task requirement: handle arbitrary
// language pairs, not a fixed list) -- each uses a fake verifier standing in for a real
// multilingual model call, since evaluateSuccessCriteria never itself contains any
// per-language logic or dictionary; the verifier is the only place language pairing is
// actually resolved, and it treats every pair identically regardless of which languages
// are involved.
// ---------------------------------------------------------------------------------------

test("French objective with an English page is satisfied via semanticVerifier", async () => {
  const objective = "Atteindre le configurateur de véhicule et s'arrêter une fois les options visibles.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Les options de configuration du véhicule sont visibles.",
  };
  const html = page_("<h1>Vehicle Configurator</h1><h2>Configuration Options Visible</h2>", "Configure Your Vehicle");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.9, evidence: "Vehicle Configurator / Configuration Options." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
});

test("English objective with an Italian page is satisfied via semanticVerifier", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>Configuratore ufficiale</h1><h2>Configura la tua auto</h2>", "Configuratore di veicoli");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.88, evidence: "Configuratore ufficiale / Configura la tua auto." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
});

test("German objective with a Spanish page is satisfied via semanticVerifier", async () => {
  const objective = "Erreiche den Fahrzeugkonfigurator und stoppe, sobald die Konfigurationsoptionen sichtbar sind.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Die Konfigurationsoptionen des Fahrzeugs sind sichtbar.",
  };
  const html = page_("<h1>Configurador oficial</h1><h2>Configura tu coche</h2>", "Configurador de vehiculos");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.87, evidence: "Configurador oficial / Configura tu coche." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
});

test("non-Latin-script page (Japanese) with an English objective is satisfied via semanticVerifier", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>公式コンフィギュレーター</h1><h2>車両を設定する</h2>", "コンフィギュレーター");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.85, evidence: "公式コンフィギュレーター / 車両を設定する." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier);
    assert.ok(satisfied.includes("reached-configurator"));
  });
  // The deterministic evaluator's own tokenizer only matches [a-z0-9] runs (see
  // src/discovery/relevance.ts), so it cannot itself score non-Latin-script text -- this
  // confirms the fallback (not the deterministic path) is what makes this case work.
  assert.equal(verifier.calls.length, 1);
});

test("url_pattern and element_present never consult semanticVerifier, even when one is supplied", async () => {
  await withPage(page_('<p data-testid="success-marker">Reached.</p>', "Success"), async (page) => {
    const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 1, evidence: "should never be called" }));
    const urlCriterion: SuccessCriterion = {
      id: "on-success-url",
      type: "url_pattern",
      description: "about:blank",
      config: { pattern: "about:blank" },
    };
    const elementCriterion: SuccessCriterion = {
      id: "success-marker-present",
      type: "element_present",
      description: "The success marker element is present.",
      config: { selector: '[data-testid="success-marker"]' },
    };
    await evaluateSuccessCriteria(page, [urlCriterion, elementCriterion], "objective", verifier);
    assert.equal(verifier.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------
// Already-satisfied short-circuit (evaluateSuccessCriteria's alreadySatisfiedCriteriaIds
// parameter, consulted by src/core/loop.ts via state.satisfiedCriteriaIds): a criterion
// whose id is already a member of that set is never re-evaluated at all -- of any type,
// not gated on the page or URL "not having changed". Ratchet semantics (nothing ever
// removes a member from satisfiedCriteriaIds -- see src/core/state.ts) make this a pure
// redundant-work elimination: the answer can no longer affect the run's outcome, so
// re-deriving it (most costly for semantic_page_match, which can mean a wasted model
// call every time an SPA re-renders incidental content after the criterion was already
// satisfied) is pure waste. See docs/n8n-integration.md "Repeated-decision and cost
// control".
// ---------------------------------------------------------------------------------------

test("an already-satisfied semantic_page_match criterion makes zero further semanticVerifier calls", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  // Page evidence that would normally force an escalation to the verifier (deterministic
  // score below minScore, cross-language) -- if the short-circuit didn't work, this test
  // would fail loudly on the thrown error below, not pass for an unrelated reason.
  const html = page_("<h1>Configurateur de véhicule</h1><h2>Options de configuration visibles</h2>", "Configurez");
  const verifier = fakeVerifier(() => {
    throw new Error("semanticVerifier.verify() must never be called for an already-satisfied criterion");
  });

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      objective,
      verifier,
      new Set(["reached-configurator"]),
    );
    assert.deepEqual(satisfied, []);
  });
});

test("an already-satisfied url_pattern criterion is never re-checked against the live page", async () => {
  await withPage(page_("<h1>Success</h1>", "Success"), async (page) => {
    let urlCalls = 0;
    const originalUrl = page.url.bind(page);
    page.url = () => {
      urlCalls += 1;
      return originalUrl();
    };
    const criterion: SuccessCriterion = {
      id: "on-success-url",
      type: "url_pattern",
      description: "A pattern that would never match this fixture, proving re-evaluation never happens.",
      config: { pattern: "https://this-will-never-match.invalid/**" },
    };

    await evaluateSuccessCriteria(page, [criterion], "objective", undefined, new Set(["on-success-url"]));

    assert.equal(urlCalls, 0, "page.url() must never be called for an already-satisfied url_pattern criterion");
  });
});

test("an already-satisfied element_present criterion is never re-queried against the live DOM", async () => {
  await withPage(page_("<h1>Success</h1>", "Success"), async (page) => {
    let locatorCalls = 0;
    const originalLocator = page.locator.bind(page);
    page.locator = ((selector: string) => {
      locatorCalls += 1;
      return originalLocator(selector);
    }) as typeof page.locator;
    const criterion: SuccessCriterion = {
      id: "success-marker-present",
      type: "element_present",
      description: "A selector that would never match this fixture, proving re-evaluation never happens.",
      config: { selector: '[data-testid="this-will-never-exist"]' },
    };

    await evaluateSuccessCriteria(page, [criterion], "objective", undefined, new Set(["success-marker-present"]));

    assert.equal(locatorCalls, 0, "page.locator() must never be called for an already-satisfied element_present criterion");
  });
});

test("a criterion satisfied earlier is skipped on a later call, while a still-unsatisfied criterion keeps being evaluated normally", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const alreadySatisfied: SuccessCriterion = {
    id: "already-satisfied",
    type: "url_pattern",
    description: "Already satisfied on an earlier step; must never be checked again.",
    config: { pattern: "https://this-will-never-match.invalid/**" },
  };
  const notYetSatisfied: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>", "Configure Your Vehicle");

  await withPage(html, async (page) => {
    let urlCalls = 0;
    const originalUrl = page.url.bind(page);
    page.url = () => {
      urlCalls += 1;
      return originalUrl();
    };

    const satisfied = await evaluateSuccessCriteria(
      page,
      [alreadySatisfied, notYetSatisfied],
      objective,
      undefined,
      new Set(["already-satisfied"]),
    );

    assert.deepEqual(satisfied, ["reached-configurator"]);
    assert.equal(urlCalls, 0, "the already-satisfied url_pattern criterion must never be re-checked");
  });
});
