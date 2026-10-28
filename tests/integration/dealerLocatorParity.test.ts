import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { ActionResult } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

// tests/fixtures/dealer-locator-widget.html is a dealer locator (locality autocomplete, dealer
// search, dealer list, hidden dealer fields) rendered in light DOM or inside an open shadow root.
// Every scenario runs in both and must behave identically. The live 2026-10-28 run's shape is
// locality=empty&dealers=cards: no locality suggestion, Enter searches, the dealer endpoint answers
// with 9 records, and clicking a dealer swaps the whole search view (the lookup field included)
// for a detail view whose own control commits the dealer. Before the fix the field's detachment
// stalled every later probe call on Playwright's 30 s default and blinded the dealer stage, so the
// run ended unresolved with no Submit, exactly as live.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const DEALERS = Array.from({ length: 9 }, (_, i) => ({ id: `D-${1000 + i}`, name: `Garage Exemple ${i + 1}`, city: "Exempleville" }));
const DOMS = ["light", "shadow"] as const;

interface Counters {
  leadPosts: Record<string, string>[];
  submitEvents: number;
  localityRequests: number;
  dealerRequests: number;
  localityChoices: number;
  dealerChoices: number;
  dealerCommits: number;
}

interface Run {
  result: ActionResult;
  counters: Counters;
  durationMs: number;
}

async function runLocator(query: string, options: { dealerRecords?: unknown[] } = {}): Promise<Run> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  try {
    await page.route("**/api/localities*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ localities: [{ label: "75001 Paris" }, { label: "75002 Paris" }] }) }),
    );
    await page.route("**/api/dealers*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dealers: options.dealerRecords ?? DEALERS }) }));
    await page.route("**/api/lead", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
    await page.goto(`${baseUrl}/dealer-locator-widget.html?${query}`);
    const started = Date.now();
    const result = (await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "dealer-locator" })) as ActionResult;
    const durationMs = Date.now() - started;
    const counters = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        leadPosts: w.__leadPosts as Record<string, string>[],
        submitEvents: w.__submitEvents as number,
        localityRequests: w.__localityRequests as number,
        dealerRequests: w.__dealerRequests as number,
        localityChoices: w.__localityChoices as number,
        dealerChoices: w.__dealerChoices as number,
        dealerCommits: w.__dealerCommits as number,
      };
    });
    return { result, counters, durationMs };
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
    await page.close();
    await browser.close();
    await close();
  }
}

function assertCommittedAndSubmittedOnce(run: Run, label: string): void {
  const { result, counters } = run;
  const context = `${label}: ${JSON.stringify({ outcome: result.formFillOutcome, dealer: result.formDealerSearchDiagnostics, events: result.dealerLookupTrace?.execution?.eventsDispatched, counters })}`;
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, true, context);
  assert.equal(counters.dealerChoices, 1, `exactly one dealer selection -- ${context}`);
  assert.equal(counters.dealerCommits, 1, context);
  assert.equal(counters.submitEvents, 1, `Submit exactly once -- ${context}`);
  assert.equal(counters.leadPosts.length, 1, context);
  assert.match(counters.leadPosts[0]!["dealer.id"] ?? "", /^D-10\d\d$/, "the posted dealer is one the widget itself committed");
  assert.equal(result.formFillOutcome, "submitted", context);
  assert.deepEqual(result.formPostSubmitDiagnostics?.preSubmitReadinessFailures ?? [], [], context);
}

function assertBlockedWithoutSubmit(run: Run, label: string): void {
  const { result, counters } = run;
  const context = `${label}: ${JSON.stringify({ outcome: result.formFillOutcome, dealer: result.formDealerSearchDiagnostics, counters })}`;
  assert.equal(result.formDealerSearchDiagnostics?.dealerValueVerified, false, context);
  assert.equal(counters.dealerCommits, 0, context);
  assert.ok(result.formPostSubmitDiagnostics?.preSubmitReadinessFailures?.includes("dealer_dependency_unresolved"), context);
  assert.equal(result.formPostSubmitDiagnostics?.submitAttempted, false, context);
  assert.equal(counters.submitEvents, 0, `Submit never pressed -- ${context}`);
  assert.equal(counters.leadPosts.length, 0, context);
  assert.notEqual(result.formFillOutcome, "submitted", context);
}

/** No lookup step may stall on a node the widget removed (the live run's 30 s waits). */
function assertNoStalledStep(run: Run, label: string): void {
  const steps = run.result.dealerLookupTrace?.execution?.activationSteps ?? [];
  for (const step of steps) assert.ok(step.durationMs < 15_000, `${label}: ${step.step} took ${step.durationMs} ms`);
}

for (const dom of DOMS) {
  test(`dealer locator (${dom} DOM): a locality suggestion is rendered and selected, then the dealer list that follows is selected and committed, and Submit runs once`, async () => {
    const run = await runLocator(`dom=${dom}&locality=list&dealers=radios`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 1);
    const events = run.result.dealerLookupTrace!.execution!.eventsDispatched;
    assert.ok(events.includes("click_location_suggestion") && events.includes("click_dealer_result"), JSON.stringify(events));
    assertNoStalledStep(run, dom);
  });

  test(`dealer locator (${dom} DOM): dealer results requested asynchronously after the locality choice are awaited and committed`, async () => {
    const run = await runLocator(`dom=${dom}&locality=list&dealers=radios&dealerDelay=1500`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 1);
  });

  test(`dealer locator (${dom} DOM): dealer records that arrive at once but render later are awaited and committed`, async () => {
    const run = await runLocator(`dom=${dom}&locality=list&dealers=radios&renderDelay=2500`);
    assertCommittedAndSubmittedOnce(run, dom);
  });

  test(`dealer locator (${dom} DOM): the live shape -- no locality suggestion, Enter searches, a dealer card swaps out the search view and the detail view's control commits the dealer`, async () => {
    const run = await runLocator(`dom=${dom}&locality=empty&dealers=cards`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 0);
    assert.equal(run.counters.dealerRequests, 1);
    assertNoStalledStep(run, dom);
  });

  test(`dealer locator (${dom} DOM): with no locality suggestions the dealer search still runs, and native radios hidden off-screen are selected through their labels`, async () => {
    const run = await runLocator(`dom=${dom}&locality=empty&dealers=radios`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 0);
    assert.ok(run.result.dealerLookupTrace!.execution!.eventsDispatched.includes("press_enter"));
  });

  test(`dealer locator (${dom} DOM): a locality, then a dealer card, then the card's own choose control -- each selected once and the dealer committed`, async () => {
    const run = await runLocator(`dom=${dom}&locality=list&dealers=cards`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 1);
  });

  test(`dealer locator (${dom} DOM): suggestion and dealer lists that re-render with new nodes are still selected exactly once`, async () => {
    const run = await runLocator(`dom=${dom}&locality=list&dealers=radios&rerender=1`);
    assertCommittedAndSubmittedOnce(run, dom);
    assert.equal(run.counters.localityChoices, 1);
  });

  test(`dealer locator (${dom} DOM): a dealer only shown as selected, with no committed state, stays blocked and Submit is never pressed`, async () => {
    const run = await runLocator(`dom=${dom}&locality=empty&dealers=cards&commit=no`);
    assertBlockedWithoutSubmit(run, dom);
    assert.equal(run.counters.dealerChoices, 1, "the choose control is pressed once, never repeated");
    assertNoStalledStep(run, dom);
  });

  test(`dealer locator (${dom} DOM): records returned by the dealer endpoint with nothing selectable rendered stay blocked`, async () => {
    const run = await runLocator(`dom=${dom}&locality=empty&dealers=none`);
    assertBlockedWithoutSubmit(run, dom);
    assert.ok(run.counters.dealerRequests >= 1);
    assert.equal(run.counters.dealerChoices, 0);
    assert.equal(run.result.dealerLookupTrace?.execution?.lookupFailureClassification, "lookup_request_returned_records_but_no_result_rendered");
  });

  test(`dealer locator (${dom} DOM): an empty locality answer followed by an empty dealer answer stays blocked`, async () => {
    const run = await runLocator(`dom=${dom}&locality=empty&dealers=radios`, { dealerRecords: [] });
    assertBlockedWithoutSubmit(run, dom);
    assert.equal(run.counters.dealerChoices, 0);
  });
}
