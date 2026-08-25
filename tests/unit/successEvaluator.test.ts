import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { evaluateSuccessCriteria, getMissingRequiredCriteriaIds } from "../../src/core/successEvaluator.js";
import { gatherSemanticPageSignals, scoreSemanticPageMatch } from "../../src/core/semanticPageMatch.js";
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
