import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import {
  computeEstimatedCompletion,
  computeMilestoneRollup,
  evaluateSuccessCriteria,
  getMissingRequiredCriteriaIds,
  type MilestoneEvidenceContext,
  type PanelMatchContext,
} from "../../src/core/successEvaluator.js";
import type { MilestoneEvidenceRecord } from "../../src/types/task-response.js";
import { gatherSemanticPageSignals, scoreSemanticPageMatch } from "../../src/core/semanticPageMatch.js";
import type { PanelEvidence } from "../../src/core/panelEvidence.js";
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
// data_layer_event / network_event: previously always `false` (default case in
// evaluateSingle -- see docs/n8n-integration.md "Generic success criteria"), regardless of
// config. Regression coverage for making these two types actually evaluated, generically,
// against config.match (a plain key/value record, never a fixed event-name vocabulary).
// ---------------------------------------------------------------------------------------

function pageWithDataLayer(entries: Record<string, unknown>[], title = "Fixture"): string {
  return page_(`<script>window.dataLayer = ${JSON.stringify(entries)};</script><h1>Page</h1>`, title);
}

test("data_layer_event: satisfied when a live window.dataLayer entry matches every config.match key/value pair", async () => {
  const html = pageWithDataLayer([{ event: "page_view" }, { event: "config_finished", step: "basket" }]);
  const criterion: SuccessCriterion = {
    id: "config-finished-event",
    type: "data_layer_event",
    description: "The config_finished analytics event has fired.",
    config: { match: { event: "config_finished" } },
  };
  assert.equal(await isSatisfied(html, "objective", criterion), true);
});

test("data_layer_event: every key in config.match must match (AND across keys), not just one", async () => {
  const html = pageWithDataLayer([{ event: "config_finished", step: "trim" }]);
  const criterion: SuccessCriterion = {
    id: "config-finished-at-basket",
    type: "data_layer_event",
    description: "config_finished fired specifically at the basket step.",
    config: { match: { event: "config_finished", step: "basket" } },
  };
  assert.equal(await isSatisfied(html, "objective", criterion), false);
});

test("data_layer_event: no matching entry, no window.dataLayer at all, or no config.match all correctly fail closed", async () => {
  await withPage(pageWithDataLayer([{ event: "page_view" }]), async (page) => {
    const noMatch = await evaluateSuccessCriteria(page, [
      { id: "a", type: "data_layer_event", description: "d", config: { match: { event: "config_finished" } } },
    ], "objective");
    assert.deepEqual(noMatch, []);
  });
  await withPage(page_("<h1>No dataLayer on this page</h1>"), async (page) => {
    const noDataLayer = await evaluateSuccessCriteria(page, [
      { id: "b", type: "data_layer_event", description: "d", config: { match: { event: "config_finished" } } },
    ], "objective");
    assert.deepEqual(noDataLayer, []);
  });
  await withPage(pageWithDataLayer([{ event: "config_finished" }]), async (page) => {
    const noConfig = await evaluateSuccessCriteria(page, [
      { id: "c", type: "data_layer_event", description: "d" },
    ], "objective");
    assert.deepEqual(noConfig, []);
  });
});

test("data_layer_event: also matches against accumulated criteriaEvidence.dataLayerEntries, not only the live page (survives a dataLayer reset)", async () => {
  // Simulates the real production scenario this fix targets: the event was pushed to
  // dataLayer on an earlier page, then a full-document navigation to a new host reset
  // window.dataLayer to empty (see capture-modules/dataLayerDelta.ts's "replaced" case) --
  // the criterion must still be satisfiable from the run's own accumulated evidence.
  await withPage(pageWithDataLayer([{ event: "page_view" }]), async (page) => {
    const criterion: SuccessCriterion = {
      id: "config-finished-event",
      type: "data_layer_event",
      description: "The config_finished analytics event has fired at some point this run.",
      config: { match: { event: "config_finished" } },
    };
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      "objective",
      undefined,
      undefined,
      undefined,
      { dataLayerEntries: [{ event: "config_finished", step: "basket" }] },
    );
    assert.ok(satisfied.includes("config-finished-event"));
  });
});

test("network_event: satisfied when a criteriaEvidence.networkEvents entry's params match every config.match key/value pair", async () => {
  await withPage(page_("<h1>Page</h1>"), async (page) => {
    const criterion: SuccessCriterion = {
      id: "ga4-config-finished",
      type: "network_event",
      description: "A GA4 config_finished request was observed.",
      config: { match: { en: "config_finished" } },
    };
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      "objective",
      undefined,
      undefined,
      undefined,
      {
        networkEvents: [
          { stepIndex: 0, requestUrl: "https://example.com/g/collect", params: { en: "page_view" } },
          { stepIndex: 1, requestUrl: "https://example.com/g/collect", params: { en: "config_finished", dl: "https://example.com/basket" } },
        ],
      },
    );
    assert.ok(satisfied.includes("ga4-config-finished"));
  });
});

test("network_event: has no live-page fallback -- absent criteriaEvidence.networkEvents (ga4_network_events capture not requested) never satisfies the criterion, even if the event genuinely occurred", async () => {
  await withPage(page_("<h1>Page</h1>"), async (page) => {
    const criterion: SuccessCriterion = {
      id: "ga4-config-finished",
      type: "network_event",
      description: "A GA4 config_finished request was observed.",
      config: { match: { en: "config_finished" } },
    };
    const satisfied = await evaluateSuccessCriteria(page, [criterion], "objective");
    assert.deepEqual(satisfied, []);
  });
});

test("network_event: config.match can also target a top-level evidence field (e.g. requestUrl), not only params", async () => {
  await withPage(page_("<h1>Page</h1>"), async (page) => {
    const criterion: SuccessCriterion = {
      id: "collect-request-seen",
      type: "network_event",
      description: "A request to the collect endpoint was observed.",
      config: { match: { requestUrl: "https://example.com/g/collect" } },
    };
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      "objective",
      undefined,
      undefined,
      undefined,
      { networkEvents: [{ stepIndex: 0, requestUrl: "https://example.com/g/collect" }] },
    );
    assert.ok(satisfied.includes("collect-request-seen"));
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
// getMissingRequiredCriteriaIds: `group` -- alternative (OR) criteria. Directly targets the
// reported goal-recognition failure: "the objective is reached when CTA-clicked OR
// destination-page-reached OR analytics-event-observed" cannot be expressed as three
// independent `required: true` criteria (that is AND, not OR) -- see
// docs/n8n-integration.md "Alternative (OR) success criteria groups".
// ---------------------------------------------------------------------------------------

test("getMissingRequiredCriteriaIds: group -- satisfying ANY one member satisfies the whole group, regardless of the others", () => {
  const criteria: SuccessCriterion[] = [
    { id: "cta-clicked", type: "semantic_page_match", description: "d", group: "objective-reached" },
    { id: "basket-page-reached", type: "url_pattern", description: "d", group: "objective-reached" },
    { id: "config-finished-event", type: "data_layer_event", description: "d", group: "objective-reached" },
  ];
  // None satisfied: the whole group is missing (reported as every member, so a caller can
  // see exactly which alternatives remain unmet).
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set()), [
    "cta-clicked",
    "basket-page-reached",
    "config-finished-event",
  ]);
  // Any single member satisfied clears the entire group -- true OR semantics.
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["config-finished-event"])), []);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["basket-page-reached"])), []);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["cta-clicked"])), []);
});

test("getMissingRequiredCriteriaIds: group is required exactly when at least one member is (required-unless-false, applied at group level)", () => {
  const allOptional: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d", group: "g", required: false },
    { id: "b", type: "url_pattern", description: "d", group: "g", required: false },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(allOptional, new Set()), []);

  const oneRequired: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d", group: "g", required: false },
    { id: "b", type: "url_pattern", description: "d", group: "g", required: true },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(oneRequired, new Set()), ["a", "b"]);
  assert.deepEqual(getMissingRequiredCriteriaIds(oneRequired, new Set(["a"])), []);
});

test("getMissingRequiredCriteriaIds: an ungrouped criterion is its own singleton group -- omitting `group` everywhere reproduces the exact previous AND-of-all-required behaviour", () => {
  const criteria: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d", required: true },
    { id: "b", type: "element_present", description: "d", required: true },
  ];
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a"])), ["b"]);
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["a", "b"])), []);
});

test("getMissingRequiredCriteriaIds: an ungrouped required criterion alongside an OR-group are combined with AND -- the group is just one more (compound) requirement", () => {
  const criteria: SuccessCriterion[] = [
    { id: "domain-confirmed", type: "url_pattern", description: "d", required: true },
    { id: "cta-clicked", type: "semantic_page_match", description: "d", group: "objective-reached" },
    { id: "basket-page-reached", type: "url_pattern", description: "d", group: "objective-reached" },
  ];
  // The OR-group alone being satisfied is not enough; the standalone required criterion
  // still gates too.
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["cta-clicked"])), ["domain-confirmed"]);
  assert.deepEqual(
    getMissingRequiredCriteriaIds(criteria, new Set()),
    ["domain-confirmed", "cta-clicked", "basket-page-reached"],
  );
  assert.deepEqual(getMissingRequiredCriteriaIds(criteria, new Set(["domain-confirmed", "cta-clicked"])), []);
});

// ---------------------------------------------------------------------------------------
// computeEstimatedCompletion: REGRESSION (production incident) -- progress.estimatedCompletion
// was previously `satisfiedCriteriaIds.length === 0 ? 0 : 1`, a binary flag over *any*
// satisfied criterion regardless of required-ness. A reported run had an optional
// milestone criterion satisfied early (landing on the model page) while the sole required
// criterion (actually completing the configurator) was never satisfied -- the response
// reported estimatedCompletion: 1 on every step alongside objectiveAchieved: false and
// navigationSuccessful: false, a direct contradiction. estimatedCompletion must now only
// ever reach 1 when engineAssessment.objectiveAchieved's own required-criteria check
// (src/core/engine.ts, getMissingRequiredCriteriaIds) would also pass.
// ---------------------------------------------------------------------------------------

test("computeEstimatedCompletion: an optional milestone satisfied alone must never saturate completion to 1 while the required criterion remains unmet", () => {
  const criteria: SuccessCriterion[] = [
    { id: "configurator-entered", type: "semantic_page_match", description: "d", required: false },
    { id: "configuration-finished", type: "semantic_page_match", description: "d", required: true },
  ];
  assert.equal(computeEstimatedCompletion(criteria, new Set(["configurator-entered"])), 0);
  assert.equal(computeEstimatedCompletion(criteria, new Set()), 0);
  assert.equal(
    computeEstimatedCompletion(criteria, new Set(["configurator-entered", "configuration-finished"])),
    1,
  );
});

test("computeEstimatedCompletion: reports a proportional fraction across multiple required criteria/groups, not a binary 0/1", () => {
  const criteria: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d", required: true },
    { id: "b", type: "url_pattern", description: "d", required: true },
    { id: "c", type: "url_pattern", description: "d", required: true },
    { id: "d", type: "url_pattern", description: "d", required: true },
  ];
  assert.equal(computeEstimatedCompletion(criteria, new Set()), 0);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["a"])), 0.25);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["a", "b"])), 0.5);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["a", "b", "c", "d"])), 1);
});

test("computeEstimatedCompletion: a required OR-group counts as one satisfied unit as soon as any one member is satisfied", () => {
  const criteria: SuccessCriterion[] = [
    { id: "domain-confirmed", type: "url_pattern", description: "d", required: true },
    { id: "cta-clicked", type: "semantic_page_match", description: "d", group: "objective-reached" },
    { id: "basket-page-reached", type: "url_pattern", description: "d", group: "objective-reached" },
  ];
  assert.equal(computeEstimatedCompletion(criteria, new Set()), 0);
  // Only the OR-group satisfied: 1 of 2 required units (the standalone criterion, the group).
  assert.equal(computeEstimatedCompletion(criteria, new Set(["cta-clicked"])), 0.5);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["domain-confirmed", "cta-clicked"])), 1);
});

test("computeEstimatedCompletion: a task with no required criteria falls back to the fraction of optional criteria satisfied, never jumping straight to 1", () => {
  const criteria: SuccessCriterion[] = [
    { id: "optional-one", type: "url_pattern", description: "d", required: false },
    { id: "optional-two", type: "url_pattern", description: "d", required: false },
  ];
  assert.equal(computeEstimatedCompletion(criteria, new Set()), 0);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["optional-one"])), 0.5);
  assert.equal(computeEstimatedCompletion(criteria, new Set(["optional-one", "optional-two"])), 1);
});

test("computeEstimatedCompletion: a task with zero success criteria reports 0, never 1", () => {
  assert.equal(computeEstimatedCompletion([], new Set()), 0);
});

// ---------------------------------------------------------------------------------------
// computeMilestoneRollup (Goal-Directed Bounded Branch Exploration): reuses existing
// successCriteria/satisfiedCriteriaIds as the objective's milestones -- see
// core/successEvaluator.ts's own doc comment. Milestone order is declaration order.
// ---------------------------------------------------------------------------------------

test("computeMilestoneRollup: a single-criterion task (the common, pre-existing case) reports a trivial single-milestone rollup", () => {
  const criteria: SuccessCriterion[] = [{ id: "only", type: "url_pattern", description: "Reach the target." }];

  const beforeSatisfied = computeMilestoneRollup(criteria, new Set());
  assert.equal(beforeSatisfied.totalMilestones, 1);
  assert.equal(beforeSatisfied.completedMilestones, 0);
  assert.equal(beforeSatisfied.remaining.length, 1);
  assert.equal(beforeSatisfied.activeSubGoal?.id, "only");

  const afterSatisfied = computeMilestoneRollup(criteria, new Set(["only"]));
  assert.equal(afterSatisfied.completedMilestones, 1);
  assert.equal(afterSatisfied.remaining.length, 0);
  assert.equal(afterSatisfied.activeSubGoal, undefined);
});

test("computeMilestoneRollup: reports '2 of N completed' and picks the first unmet milestone (in declaration order) as the active sub-goal", () => {
  const criteria: SuccessCriterion[] = [
    { id: "reached-section", type: "url_pattern", description: "Reach the required section." },
    { id: "entity-selected", type: "element_present", description: "Select the required entity." },
    { id: "final-page", type: "url_pattern", description: "Reach the final destination page." },
  ];

  const rollup = computeMilestoneRollup(criteria, new Set(["reached-section", "entity-selected"]));
  assert.equal(rollup.totalMilestones, 3);
  assert.equal(rollup.completedMilestones, 2);
  assert.deepEqual(
    rollup.completed.map((m) => m.id),
    ["reached-section", "entity-selected"],
  );
  assert.deepEqual(
    rollup.remaining.map((m) => m.id),
    ["final-page"],
  );
  assert.equal(rollup.activeSubGoal?.id, "final-page");
});

test("computeMilestoneRollup: a group of alternative criteria counts as one milestone, satisfied once any member is satisfied", () => {
  const criteria: SuccessCriterion[] = [
    { id: "path-a", type: "url_pattern", description: "Reach via path A.", group: "either-path" },
    { id: "path-b", type: "url_pattern", description: "Reach via path B.", group: "either-path" },
    { id: "final", type: "url_pattern", description: "Reach the final page." },
  ];

  const rollup = computeMilestoneRollup(criteria, new Set(["path-b"]));
  assert.equal(rollup.totalMilestones, 2, "the group counts as one milestone, not two");
  assert.equal(rollup.completedMilestones, 1);
  assert.deepEqual(
    rollup.completed.map((m) => m.id),
    ["path-a"],
    "the group's representative is its first-declared member",
  );
});

test("computeMilestoneRollup: all milestones satisfied leaves remaining empty and activeSubGoal undefined", () => {
  const criteria: SuccessCriterion[] = [
    { id: "a", type: "url_pattern", description: "d" },
    { id: "b", type: "url_pattern", description: "d" },
  ];
  const rollup = computeMilestoneRollup(criteria, new Set(["a", "b"]));
  assert.equal(rollup.completedMilestones, 2);
  assert.equal(rollup.remaining.length, 0);
  assert.equal(rollup.activeSubGoal, undefined);
});

test("computeMilestoneRollup: an unsuccessful downstream branch never un-satisfies an earlier, already-completed milestone (satisfiedCriteriaIds is a one-way ratchet)", () => {
  const criteria: SuccessCriterion[] = [
    { id: "entity-selected", type: "element_present", description: "Select the required entity." },
    { id: "final-page", type: "url_pattern", description: "Reach the final destination page." },
  ];
  const satisfied = new Set(["entity-selected"]);

  // Simulate a downstream branch failing: nothing about a failed branch ever removes an id
  // from satisfiedCriteriaIds (see RunState/successEvaluator's own ratchet discipline) --
  // computeMilestoneRollup is purely a read over whatever the set currently contains, so
  // this is really asserting the caller-side invariant that a failed branch must never call
  // satisfiedCriteriaIds.delete(...).
  const rollup = computeMilestoneRollup(criteria, satisfied);
  assert.deepEqual(
    rollup.completed.map((m) => m.id),
    ["entity-selected"],
    "the required entity selection milestone remains completed regardless of any later branch outcome",
  );
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

test("an already-satisfied OPTIONAL (required: false) criterion is short-circuited exactly like a required one -- the milestone pattern (e.g. configurator-entered) never pays repeated verification cost once satisfied", async () => {
  // Matches the real configurator-entered/configuration-finished pattern (docs/n8n-
  // integration.md "Terminal-route success model"): an optional milestone criterion,
  // satisfied early, must never be re-verified on every subsequent step just because it
  // is optional -- the short-circuit in evaluateSuccessCriteria operates purely on
  // criterion id membership in alreadySatisfiedCriteriaIds and has no `required`
  // conditional anywhere near it (see src/core/successEvaluator.ts), but until now no
  // test exercised the required:false case specifically.
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const optionalMilestone: SuccessCriterion = {
    id: "configurator-entered",
    type: "semantic_page_match",
    description: "The vehicle configurator has been entered.",
    required: false,
  };
  // Deliberately unreachable by the deterministic evaluator alone (cross-language page),
  // so re-evaluation -- if it happened -- would necessarily escalate to the verifier,
  // making the thrown error below a reliable failure signal.
  const html = page_("<h1>Configurateur de vehicule</h1><h2>Options de configuration visibles</h2>", "Configurez");
  const verifier = fakeVerifier(() => {
    throw new Error("semanticVerifier.verify() must never be called for an already-satisfied optional criterion");
  });

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(
      page,
      [optionalMilestone],
      objective,
      verifier,
      new Set(["configurator-entered"]),
    );
    assert.deepEqual(satisfied, [], "an already-satisfied criterion is never re-reported as newly satisfied");
  });
});

test("an optional (required: false) criterion not yet satisfied is still evaluated normally, and getMissingRequiredCriteriaIds never reports it as missing once satisfied or not", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const optionalMilestone: SuccessCriterion = {
    id: "configurator-entered",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
    required: false,
  };
  const html = page_("<h1>Vehicle Configurator</h1><h2>Configuration Controls Visible</h2>", "Configure Your Vehicle");

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [optionalMilestone], objective);
    assert.deepEqual(satisfied, ["configurator-entered"], "an optional criterion not yet in alreadySatisfiedCriteriaIds is still evaluated and can become satisfied");
  });
});

// ---------------------------------------------------------------------------------------
// lastActionEvidence (optional 6th param, threaded to semanticVerifier.verify() only):
// lets a criterion generically require that a *specific* control was clicked -- e.g. a
// terminal completion control (Summary/Continue/equivalent) -- verified by meaning against
// the actual click, never by literal word/brand-label matching. Off by default and never
// affects the deterministic lexical path or any non-semantic criterion type.
// ---------------------------------------------------------------------------------------

test("lastActionEvidence is forwarded to semanticVerifier.verify() when supplied", async () => {
  const objective = "Finish the configuration.";
  const criterion: SuccessCriterion = {
    id: "configuration-finished",
    type: "semantic_page_match",
    description: "The final completion control was clicked and the resulting page confirms completion.",
  };
  const html = page_("<h1>Merci</h1><h2>Configuration terminee</h2>", "Recapitulatif");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.9, evidence: "Recapitulatif / Configuration terminee." }));

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      objective,
      verifier,
      undefined,
      { ctaText: "Continuer", accessibleName: "Continuer vers le recapitulatif", elementType: "button" },
    );
    assert.ok(satisfied.includes("configuration-finished"));
  });

  assert.equal(verifier.calls.length, 1);
  assert.deepEqual(verifier.calls[0]?.lastActionEvidence, {
    ctaText: "Continuer",
    accessibleName: "Continuer vers le recapitulatif",
    elementType: "button",
  });
});

test("lastActionEvidence is absent from the verifier call when not supplied (backward compatible)", async () => {
  const objective = "Reach the vehicle configurator and stop once configuration controls are visible.";
  const criterion: SuccessCriterion = {
    id: "reached-configurator",
    type: "semantic_page_match",
    description: "Vehicle configuration controls are visible on the page.",
  };
  const html = page_("<h1>Configurateur de vehicule</h1><h2>Options de configuration visibles</h2>", "Configurez");
  const verifier = fakeVerifier(() => ({ satisfied: true, confidence: 0.9, evidence: "Match." }));

  await withPage(html, async (page) => {
    await evaluateSuccessCriteria(page, [criterion], objective, verifier);
  });

  assert.equal(verifier.calls.length, 1);
  assert.equal(verifier.calls[0]?.lastActionEvidence, undefined);
});

test("a rejecting semanticVerifier that finds lastActionEvidence names the wrong control keeps the terminal criterion unsatisfied, even though the page looks right", async () => {
  // Models the exact defect a route-agnostic (page-only) verification would miss: the
  // right-looking page was reached, but not via the completion control -- e.g. a user
  // navigated to the summary URL directly, or clicked an unrelated link that happens to
  // land there. A verifier that inspects lastActionEvidence can reject this generically,
  // by meaning, with no brand/label-specific check anywhere in the engine itself.
  const objective = "Finish the configuration.";
  const criterion: SuccessCriterion = {
    id: "configuration-finished",
    type: "semantic_page_match",
    description: "The final completion control was clicked and the resulting page confirms completion.",
  };
  const html = page_("<h1>Configuration terminee</h1>", "Recapitulatif");
  const verifier = fakeVerifier((input) => {
    const clickedCompletionControl = /continue|summary|terminer|recapitulatif/i.test(
      input.lastActionEvidence?.accessibleName ?? input.lastActionEvidence?.ctaText ?? "",
    );
    return clickedCompletionControl
      ? { satisfied: true, confidence: 0.9, evidence: "Completion control clicked and page confirms it." }
      : { satisfied: false, confidence: 0.9, evidence: "Page looks right, but the completion control was not what was clicked." };
  });

  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, [criterion], objective, verifier, undefined, {
      ctaText: "Voir les offres",
      accessibleName: "Voir les offres promotionnelles",
      elementType: "a",
    });
    assert.ok(!satisfied.includes("configuration-finished"));
  });
});

// ---------------------------------------------------------------------------------------
// Ordered required-milestone enforcement (docs/n8n-integration.md §9f): converts
// declaration-order milestones from a reporting-only convention (Goal-Directed Bounded
// Branch Exploration's activeSubGoal) into an enforced runtime constraint -- the fix for the
// reported false-success regression where all five milestones of a five-step journey were
// satisfied on the very first step, from the homepage alone, because every criterion was
// evaluated (and satisfiable) independently of declaration order.
// ---------------------------------------------------------------------------------------

test("only the first unsatisfied required milestone is eligible for evaluation -- a later required criterion never satisfies from the same call, even when the same page would trivially satisfy it too", async () => {
  const html = page_("<h1>Step One Complete</h1><h2>Step Two Complete</h2>", "Both Steps");
  const criteria: SuccessCriterion[] = [
    { id: "step-1", type: "semantic_page_match", description: "Step one is complete.", required: true },
    { id: "step-2", type: "semantic_page_match", description: "Step two is complete.", required: true },
  ];
  await withPage(html, async (page) => {
    const satisfied = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set());
    assert.deepEqual(
      satisfied,
      ["step-1"],
      "only the active milestone (step-1) may satisfy from this call, even though step-2's own vocabulary is also present on this exact page",
    );
  });
});

test("completing the active milestone activates the next one, satisfied on a later call against a page that genuinely represents it", async () => {
  const criteria: SuccessCriterion[] = [
    { id: "step-1", type: "semantic_page_match", description: "Step one is complete.", required: true },
    { id: "step-2", type: "semantic_page_match", description: "Step two is complete.", required: true },
  ];
  const stepOneHtml = page_("<h1>Step One Complete</h1>", "Step One");
  const stepTwoHtml = page_("<h1>Step Two Complete</h1>", "Step Two");

  await withPage(stepOneHtml, async (page) => {
    const firstCall = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set());
    assert.deepEqual(firstCall, ["step-1"]);
  });
  await withPage(stepTwoHtml, async (page) => {
    const secondCall = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set(["step-1"]));
    assert.deepEqual(secondCall, ["step-2"], "step-2 becomes eligible, and satisfiable, once step-1 is already satisfied");
  });
});

test("no required milestone can be satisfied before every earlier required milestone, however many times the same unchanged page is evaluated", async () => {
  const html = page_(
    "<h1>Step One</h1><h2>Step Two</h2><h3>Step Three</h3><h4>Step Four</h4>",
    "All Steps Visible At Once",
  );
  const criteria: SuccessCriterion[] = [
    { id: "step-1", type: "semantic_page_match", description: "Step one reached.", required: true },
    { id: "step-2", type: "semantic_page_match", description: "Step two reached.", required: true },
    { id: "step-3", type: "semantic_page_match", description: "Step three reached.", required: true },
    { id: "step-4", type: "semantic_page_match", description: "Step four reached.", required: true },
  ];
  await withPage(html, async (page) => {
    const satisfiedIds = new Set<string>();
    for (let call = 0; call < 5; call += 1) {
      const newlySatisfied = await evaluateSuccessCriteria(page, criteria, "", undefined, satisfiedIds);
      newlySatisfied.forEach((id) => satisfiedIds.add(id));
      assert.ok(newlySatisfied.length <= 1, `call ${call} satisfied ${newlySatisfied.length} new criteria at once`);
    }
    assert.deepEqual([...satisfiedIds].sort(), ["step-1", "step-2", "step-3", "step-4"]);
  });
});

test("step-3 cannot become satisfied before step-2, and step-5 cannot become satisfied before steps 1-4, even against a single page carrying evidence for all five simultaneously", async () => {
  const html = page_(
    "<h1>Milestone One</h1><h2>Milestone Two</h2><h3>Milestone Three</h3><h4>Milestone Four</h4>" +
      '<p data-testid="milestone-five">Milestone Five</p>',
    "All Milestones",
  );
  const criteria: SuccessCriterion[] = [
    { id: "step-1", type: "semantic_page_match", description: "Milestone one reached.", required: true },
    { id: "step-2", type: "semantic_page_match", description: "Milestone two reached.", required: true },
    { id: "step-3", type: "semantic_page_match", description: "Milestone three reached.", required: true },
    { id: "step-4", type: "semantic_page_match", description: "Milestone four reached.", required: true },
    {
      id: "step-5",
      type: "element_present",
      description: "Milestone five marker present.",
      config: { selector: '[data-testid="milestone-five"]' },
      required: true,
    },
  ];
  await withPage(html, async (page) => {
    // Only step-1 satisfied so far -- step-3 and step-5 must not appear, despite the page
    // carrying evidence for every milestone at once.
    const fromOnlyStep1 = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set(["step-1"]));
    assert.deepEqual(fromOnlyStep1, ["step-2"]);
    assert.ok(!fromOnlyStep1.includes("step-3"));
    assert.ok(!fromOnlyStep1.includes("step-5"));

    // Steps 1-3 satisfied, step-4 still outstanding -- step-5 must not satisfy even though
    // its own marker element is already present on the page.
    const fromSteps1to3 = await evaluateSuccessCriteria(
      page,
      criteria,
      "",
      undefined,
      new Set(["step-1", "step-2", "step-3"]),
    );
    assert.deepEqual(fromSteps1to3, ["step-4"]);
    assert.ok(!fromSteps1to3.includes("step-5"));

    // All of steps 1-4 satisfied: step-5 is now the active milestone and may satisfy.
    const fromSteps1to4 = await evaluateSuccessCriteria(
      page,
      criteria,
      "",
      undefined,
      new Set(["step-1", "step-2", "step-3", "step-4"]),
    );
    assert.deepEqual(fromSteps1to4, ["step-5"]);
  });
});

test("an optional (required: false) criterion is always eligible, regardless of its declared position relative to an outstanding required milestone", async () => {
  const html = page_(
    "<h1>Required Milestone One</h1><h2>Optional Signal Present</h2><h3>Required Milestone Two</h3>",
    "Mixed",
  );
  const criteria: SuccessCriterion[] = [
    { id: "required-1", type: "semantic_page_match", description: "Required milestone one reached.", required: true },
    { id: "optional-signal", type: "semantic_page_match", description: "Optional signal present.", required: false },
    { id: "required-2", type: "semantic_page_match", description: "Required milestone two reached.", required: true },
  ];
  await withPage(html, async (page) => {
    // required-2 is gated behind required-1 (still unsatisfied), but optional-signal --
    // declared between them -- is unaffected and satisfies immediately, exactly as before
    // ordered-milestone enforcement existed.
    const satisfied = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set());
    assert.deepEqual(satisfied.sort(), ["optional-signal", "required-1"]);
    assert.ok(!satisfied.includes("required-2"));
  });
});

test("milestoneEvidenceContext records one evidence entry per newly satisfied criterion, and none for a criterion the ordering gate skipped", async () => {
  const html = page_("<h1>Milestone One</h1><h2>Milestone Two</h2>", "Two Milestones");
  const criteria: SuccessCriterion[] = [
    { id: "step-1", type: "semantic_page_match", description: "Milestone one reached.", required: true },
    { id: "step-2", type: "semantic_page_match", description: "Milestone two reached.", required: true },
  ];
  await withPage(html, async (page) => {
    const sink: MilestoneEvidenceRecord[] = [];
    const context: MilestoneEvidenceContext = { sink, stepIndex: 3, phase: "post_action" };
    const satisfied = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set(), undefined, undefined, context);
    assert.deepEqual(satisfied, ["step-1"]);
    assert.equal(sink.length, 1, "step-2 was gated and must never receive an evidence record");
    assert.equal(sink[0]?.criterionId, "step-1");
    assert.equal(sink[0]?.criterionType, "semantic_page_match");
    assert.equal(sink[0]?.stepIndex, 3);
    assert.equal(sink[0]?.phase, "post_action");
    assert.equal(sink[0]?.evidenceSource, "semantic_page_match:deterministic");
    assert.equal(typeof sink[0]?.score, "number");
    assert.ok((sink[0]?.reason.length ?? 0) > 0);
  });
});

// ---------------------------------------------------------------------------------------
// PR 1D (truthful milestone evaluation, see CLAUDE.md and docs/architecture.md §21):
// evidenceTier/score are always populated on MilestoneEvidenceRecord, and surfaceScoped
// excludes covered (background) content from semantic_page_match evidence.
// ---------------------------------------------------------------------------------------

test("MilestoneEvidenceRecord.evidenceTier is 'observed' with score 1.0 for a mechanical (non-semantic) criterion type", async () => {
  const html = page_('<button id="goal">Goal reached</button>', "Fixture");
  const criteria: SuccessCriterion[] = [
    { id: "goal-present", type: "element_present", description: "Goal control present.", config: { selector: "#goal" } },
  ];
  await withPage(html, async (page) => {
    const sink: MilestoneEvidenceRecord[] = [];
    const context: MilestoneEvidenceContext = { sink, stepIndex: 0, phase: "post_action" };
    const satisfied = await evaluateSuccessCriteria(page, criteria, "", undefined, new Set(), undefined, undefined, context);
    assert.deepEqual(satisfied, ["goal-present"]);
    assert.equal(sink[0]?.evidenceSource, "element_present");
    assert.equal(sink[0]?.evidenceTier, "observed");
    assert.equal(sink[0]?.score, 1.0);
  });
});

test("MilestoneEvidenceRecord.evidenceTier is 'inferred' with the deterministic overlap score for a semantic_page_match criterion", async () => {
  const html = page_("<h1>Configuration Controls Visible</h1>", "Vehicle Configurator");
  const criteria: SuccessCriterion[] = [
    {
      id: "reached-configurator",
      type: "semantic_page_match",
      description: "Vehicle configuration controls are visible on the page.",
    },
  ];
  await withPage(html, async (page) => {
    const sink: MilestoneEvidenceRecord[] = [];
    const context: MilestoneEvidenceContext = { sink, stepIndex: 0, phase: "post_action" };
    const satisfied = await evaluateSuccessCriteria(
      page,
      criteria,
      "Reach the vehicle configurator.",
      undefined,
      new Set(),
      undefined,
      undefined,
      context,
    );
    assert.deepEqual(satisfied, ["reached-configurator"]);
    assert.equal(sink[0]?.evidenceSource, "semantic_page_match:deterministic");
    assert.equal(sink[0]?.evidenceTier, "inferred");
    assert.ok((sink[0]?.score ?? 0) > 0 && (sink[0]?.score ?? 0) <= 1, "expected the deterministic overlap score, not a placeholder");
  });
});

test("surfaceScoped=true excludes covered background content from semantic_page_match evidence, while still matching a newly-appeared, uncovered surface's own content", async () => {
  // A full-viewport overlay (simulating a newly-opened drawer/panel) covers a pre-existing
  // background heading entirely, and itself contains a different heading of its own -- the
  // exact shape a surface-scoped evaluation must tell apart: background content that is now
  // hidden underneath the surface must never satisfy a milestone, while the surface's own
  // visible content still can.
  const html = page_(
    '<h1 id="background">Old Offer Details</h1>' +
      '<div style="position:fixed;top:0;left:0;width:100%;height:100%;background:#fff;">' +
      '<h2 id="drawer">Drawer Content Visible</h2>' +
      "</div>",
    "Fixture",
  );
  const backgroundCriterion: SuccessCriterion = {
    id: "background-match",
    type: "semantic_page_match",
    description: "Old offer details are shown.",
    config: { minScore: 0.1 },
  };
  const drawerCriterion: SuccessCriterion = {
    id: "drawer-match",
    type: "semantic_page_match",
    description: "Drawer content is visible.",
    config: { minScore: 0.1 },
  };

  await withPage(html, async (page) => {
    // Without surfaceScoped (the default, unchanged behaviour): both the covered background
    // heading and the drawer's own heading are part of the evidence pool.
    const withoutScoping = await evaluateSuccessCriteria(page, [backgroundCriterion], "", undefined, new Set());
    assert.deepEqual(withoutScoping, ["background-match"], "unscoped evaluation must still see covered background content, unchanged from before this fix");

    // With surfaceScoped=true: the covered background heading is excluded...
    const scopedBackground = await evaluateSuccessCriteria(
      page,
      [backgroundCriterion],
      "",
      undefined,
      new Set(),
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.deepEqual(scopedBackground, [], "a milestone must not be satisfied by background content a newly-opened surface has covered over");

    // ...while the drawer's own, uncovered content still satisfies normally.
    const scopedDrawer = await evaluateSuccessCriteria(
      page,
      [drawerCriterion],
      "",
      undefined,
      new Set(),
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.deepEqual(scopedDrawer, ["drawer-match"], "the newly-opened surface's own visible content must still satisfy a milestone when surface-scoped");
  });
});

// ---------------------------------------------------------------------------------------
// Navigational-chrome exclusion (docs/n8n-integration.md §9, the other half of the fix): a
// link/CTA/menu item living in persistent site-wide navigation/header/footer chrome renders
// identically on every page of a site, so it must never by itself prove a destination
// described elsewhere was actually reached -- purely structural (standard HTML5 landmark
// elements/ARIA landmark roles), never brand/site/vocabulary-specific.
// ---------------------------------------------------------------------------------------

test("a homepage whose own <nav> lists downstream destinations does not satisfy criteria describing those destinations (REGRESSION: reproduces the reported false-success bug's shape)", async () => {
  const html = page_(
    '<nav><a href="/offers">Offers</a><a href="/model">The Voyager Crossover</a><a href="/quote">Request a Quote</a></nav>' +
      "<h1>Welcome Home</h1>",
    "Home",
  );
  const offersCriterion: SuccessCriterion = {
    id: "reached-offers",
    type: "semantic_page_match",
    description: "Current offers are shown.",
  };
  const modelCriterion: SuccessCriterion = {
    id: "selected-model",
    type: "semantic_page_match",
    description: "The Voyager Crossover offer is selected.",
  };
  const quoteCriterion: SuccessCriterion = {
    id: "opened-quote-form",
    type: "semantic_page_match",
    description: "The Request a Quote form is displayed.",
  };
  assert.equal(await isSatisfied(html, "", offersCriterion), false, "a homepage Offers nav link must not satisfy 'Navigate to the Offers page'");
  assert.equal(await isSatisfied(html, "", modelCriterion), false, "a homepage model nav link must not satisfy 'Select the offer'");
  assert.equal(await isSatisfied(html, "", quoteCriterion), false, "a homepage Request a Quote nav link must not satisfy 'Open the Request a Quote form'");
});

test("identical link text satisfies the criterion in ordinary page content but not inside <nav>", async () => {
  const criterion: SuccessCriterion = {
    id: "selected-model",
    type: "semantic_page_match",
    description: "The Voyager Crossover offer is selected.",
  };
  const inNav = page_('<nav><a href="/model">Voyager Crossover Offer</a></nav><h1>Home</h1>', "Home");
  const inContent = page_('<h1>Offer Details</h1><a href="/model">Voyager Crossover Offer</a>', "Details");
  assert.equal(await isSatisfied(inNav, "", criterion), false);
  assert.equal(await isSatisfied(inContent, "", criterion), true);
});

test('a link inside <header>, <footer>, or [role="navigation"] is excluded identically to <nav>', async () => {
  const criterion: SuccessCriterion = {
    id: "selected-model",
    type: "semantic_page_match",
    description: "The Voyager Crossover offer is selected.",
    config: { signals: ["interactiveElements"] },
  };
  const inHeader = page_('<header><a href="/model">Voyager Crossover Offer</a></header><h1>Home</h1>', "Home");
  const inFooter = page_('<footer><a href="/model">Voyager Crossover Offer</a></footer><h1>Home</h1>', "Home");
  const inAriaNav = page_(
    '<div role="navigation"><a href="/model">Voyager Crossover Offer</a></div><h1>Home</h1>',
    "Home",
  );
  assert.equal(await isSatisfied(inHeader, "", criterion), false);
  assert.equal(await isSatisfied(inFooter, "", criterion), false);
  assert.equal(await isSatisfied(inAriaNav, "", criterion), false);
});

// ---------------------------------------------------------------------------------------
// Panel-relevance-veto corrective pass (see CLAUDE.md and the BMW post-PR61 live-run
// investigation): a resulting-surface milestone must still fail closed when the panel's own
// causal attribution is missing, even when its content would otherwise score adopt-tier.
// This isolates the `panelContext.causallyLinked` gate directly (real evaluateSuccessCriteria
// code, a real SemanticCriterionVerifier double, no full click/adoption pipeline needed to
// exercise this one condition) -- panelAttribution.test.ts already covers same-step panel
// evidence availability and the close guard end-to-end.
// ---------------------------------------------------------------------------------------

test("a panel without causal attribution fails closed for the resulting-surface milestone, even with adopt-tier content", async () => {
  const criterion: SuccessCriterion = {
    id: "panel_visible",
    type: "semantic_page_match",
    description: "Your enquiry panel with your own contact details is now clearly visible.",
  };
  const evidence: PanelEvidence = {
    containerFound: true,
    identity: "div|Your Enquiry Panel",
    role: "div",
    headings: ["Your Enquiry Panel", "Your Contact Details"],
    interactiveText: ["First Name", "Submit", "Cancel"],
    documentUsable: true,
    relevance: { tier: "adopt", score: 0.5, adoptThreshold: 0.35, rejectThreshold: 0.08 },
  };
  const panelContextNotCausallyLinked: PanelMatchContext = { evidence, causallyLinked: false };

  const verifier: SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } = (() => {
    const calls: SemanticVerificationInput[] = [];
    return {
      calls,
      async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
        calls.push(input);
        const p = input.panelEvidence;
        const confirmed = p !== undefined && p.causallyLinked && p.documentUsable && p.relevanceTier === "adopt";
        return confirmed
          ? { satisfied: true, confidence: 0.9, evidence: "Causally-linked panel confirmed." }
          : { satisfied: false, confidence: 0.2, evidence: `Not causally linked (causallyLinked: ${p?.causallyLinked}).` };
      },
    };
  })();

  await withPage(page_(""), async (page) => {
    const satisfied = await evaluateSuccessCriteria(
      page,
      [criterion],
      "Complete the item journey.",
      verifier,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      panelContextNotCausallyLinked,
    );
    assert.equal(satisfied.length, 0, "an adopt-tier panel with no causal attribution must never satisfy the milestone");
  });

  assert.equal(verifier.calls.length, 1, "the verifier must still have been consulted (the deterministic panel_causal path requires causallyLinked)");
  assert.equal(verifier.calls[0]!.panelEvidence?.causallyLinked, false);
});
