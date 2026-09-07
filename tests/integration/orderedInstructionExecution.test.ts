import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { computeInstructionProgress } from "../../src/reasoning/promptBuilder.js";
import type { TaskRequest, SuccessCriterion } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * REGRESSION (run_e78d8d76-b487-4ece-8e0b-a0e2fbd48b1b): with three remaining ordered
 * instructions ("click Continue", "then click the action matching Book/Reserve a test
 * drive", "stop and return the resulting URL"), both a continue-shaped control and a
 * book/reserve-shaped control were visible on the same page at once. Nothing told the
 * model one was explicitly ordered before the other; it produced a low-confidence guess
 * and the run stopped instead of progressing.
 *
 * OrderedInstructionModelClient below is a deterministic stand-in for a well-behaved
 * reasoning decision (mirrors BlockerAwareModelClient in blockerRecovery.test.ts): it
 * consults the engine's own computeInstructionProgress (src/reasoning/promptBuilder.ts --
 * the exact function feeding the real system prompt/payload) to find the earliest
 * unfinished required instruction, then looks only for an uncovered element matching that
 * instruction's own test-supplied pattern -- never a later instruction's pattern, however
 * prominent or early in DOM order a matching control for it might be. This is deliberately
 * how a real model is *told* to behave (see promptBuilder.ts's orderedInstructionClause),
 * so these tests exercise the engine's supporting machinery (successCriteria ordering
 * exposure, satisfiedCriteriaIds accumulation, stop_success gating, resulting-URL capture)
 * end-to-end, the same way the whole codebase's other deterministic reasoning stand-ins do
 * for their respective mechanisms. Every fixture below is entirely generic/synthetic
 * (served from 127.0.0.1, generic English wording) -- no brand, market, or vendor text
 * anywhere, and no fixed assumption about what any instruction's control looks like.
 */
class OrderedInstructionModelClient implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  constructor(private readonly patternsByCriterionId: Record<string, RegExp>) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      const decision: Decision = { action: { type: "stop_success" }, rationale: "Every required instruction is satisfied." };
      this.decisions.push(decision);
      return decision;
    }

    const progress = computeInstructionProgress(context.successCriteria, context.satisfiedCriteriaIds);
    const isReachable = (el: { visible?: boolean; disabled?: boolean; covered?: boolean }) =>
      el.visible !== false && !el.disabled && !el.covered;
    const elements = context.observation.interactiveElements;

    if (progress.earliestUnfinished) {
      for (const id of progress.earliestUnfinished.ids) {
        const pattern = this.patternsByCriterionId[id];
        if (!pattern) {
          continue;
        }
        const match = elements.find((el) => isReachable(el) && pattern.test(el.accessibleName));
        if (match && context.allowedActions.includes("click")) {
          const decision: Decision = {
            action: { type: "click", target: match.id },
            rationale: `"${match.accessibleName}" matches the earliest unfinished instruction (${id}).`,
          };
          this.decisions.push(decision);
          return decision;
        }
      }
    }

    // The earliest unfinished instruction has no currently reachable match -- ordinary
    // bounded recovery (scroll if allowed), never skipping ahead to a later instruction.
    const decision: Decision = context.allowedActions.includes("scroll")
      ? { action: { type: "scroll" }, rationale: "Earliest unfinished instruction not yet actionable; scrolling to look for it." }
      : context.allowedActions.includes("stop_failure")
        ? { action: { type: "stop_failure" }, rationale: "No reachable control for the earliest unfinished instruction." }
        : { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
    this.decisions.push(decision);
    return decision;
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "ordered-instruction-task",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 15, maxBacktracks: 0, maxRepeatedActions: 6 },
    safety: { allowedActions: ["click", "scroll", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
    ...overrides,
  };
}

// The example ordered objective from the task spec: select a specified item, activate the
// primary progression action, select a specified terminal action, stop and return the URL.
function orderedSuccessCriteria(terminalPattern = "**/terminal-success.html"): SuccessCriterion[] {
  return [
    {
      id: "select-item",
      type: "element_present",
      description: "Select the specified item.",
      config: { selector: "#item-selected" },
      required: true,
    },
    {
      id: "primary-progression",
      type: "element_present",
      description: "Activate the primary progression action.",
      config: { selector: "#continue-activated" },
      required: true,
    },
    {
      id: "terminal-action",
      type: "url_pattern",
      description: "Select the specified terminal action.",
      config: { pattern: terminalPattern },
      required: true,
    },
  ];
}

const ORDERED_PATTERNS: Record<string, RegExp> = {
  "select-item": /select item/i,
  "primary-progression": /continue/i,
  "terminal-action": /terminal action/i,
};

// ---------------------------------------------------------------------------------------
// Single-origin fixture server: every scenario below is served from here, one route per
// distinct page-transition shape (full navigation / same-page update / modal / multiple
// intermediates / no-Continue wording / absent terminal / new tab). Entirely generic,
// state-driven by what the *fixture* does when clicked -- never a configurator-specific
// state machine baked into engine code.
// ---------------------------------------------------------------------------------------
async function startOrderedInstructionFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);

    const ITEM_BUTTON =
      '<button id="item">Select item</button>' +
      "<script>document.getElementById('item').addEventListener('click', function () {" +
      "var m = document.createElement('div'); m.id = 'item-selected'; document.body.appendChild(m);" +
      "document.getElementById('stage2').style.display = 'block';" +
      "});</script>";

    // Main full-sequence fixture: State A (item only) -> State B (Continue AND an early,
    // wrongly-ordered terminal control both appear on the same page) -> State C (after
    // Continue, the early terminal control is replaced by an unrelated prominent control
    // AND the real terminal control) -> State D (terminal control navigates same-tab).
    if (path === "/full-sequence.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none">' +
          '<button id="continue">Continue</button>' +
          '<button id="terminal-early">Terminal action (should never be clicked here)</button>' +
          "</div>" +
          "<script>" +
          "document.getElementById('continue').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
          "document.getElementById('stage2').innerHTML = " +
          "'<button id=\"unrelated-prominent\">Unrelated prominent control</button>' + " +
          "'<button id=\"terminal-real\">Terminal action</button>';" +
          "var real = document.getElementById('terminal-real');" +
          "real.addEventListener('click', function () { window.location.href = '/terminal-success.html'; });" +
          "var wrong = document.getElementById('unrelated-prominent');" +
          "wrong.addEventListener('click', function () { window.location.href = '/wrong-terminal.html'; });" +
          "});" +
          "document.getElementById('terminal-early').addEventListener('click', function () {" +
          "window.location.href = '/wrong-terminal.html';" +
          "});" +
          "</script>",
      );
    }

    if (path === "/terminal-success.html") {
      return void page("<h1>Terminal reached</h1>");
    }

    if (path === "/wrong-terminal.html") {
      return void page("<h1>Wrong terminal -- must never be reached by a correctly-ordered run</h1>");
    }

    // Variation: the intermediate action is a *full-page navigation*, not a same-page
    // update -- the terminal control only exists on the destination page.
    if (path === "/nav-intermediate.html") {
      return void page(ITEM_BUTTON + '<div id="stage2" style="display:none"><a id="continue" href="/nav-intermediate-step2.html">Continue</a></div>');
    }
    if (path === "/nav-intermediate-step2.html") {
      return void page(
        '<script>var m = document.createElement("div"); m.id = "continue-activated"; document.body.appendChild(m);</script>' +
          '<button id="terminal-real">Terminal action</button>' +
          "<script>document.getElementById('terminal-real').addEventListener('click', function () { window.location.href = '/terminal-success.html'; });</script>",
      );
    }

    // Variation: the intermediate action opens a modal/drawer (an overlay on the *same*
    // page) rather than updating page content directly.
    if (path === "/modal-intermediate.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none"><button id="continue">Continue</button></div>' +
          "<script>" +
          "document.getElementById('continue').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
          "var modal = document.createElement('div');" +
          "modal.setAttribute('role', 'dialog');" +
          "modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white;';" +
          "modal.innerHTML = '<button id=\"terminal-real\">Terminal action</button>';" +
          "document.body.appendChild(modal);" +
          "document.getElementById('terminal-real').addEventListener('click', function () { window.location.href = '/terminal-success.html'; });" +
          "});" +
          "</script>",
      );
    }

    // Variation: multiple intermediate progression steps before the terminal control ever
    // appears.
    if (path === "/multi-intermediate.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none"><button id="continue">Continue</button></div>' +
          "<script>" +
          "var step = 0;" +
          "document.getElementById('continue').addEventListener('click', function () {" +
          "step += 1;" +
          "if (step === 1) {" +
          "document.getElementById('stage2').innerHTML = '<button id=\"continue2\">Continue</button>';" +
          "document.getElementById('continue2').addEventListener('click', arguments.callee);" +
          "} else {" +
          "var m = document.getElementById('continue-activated') || document.createElement('div');" +
          "m.id = 'continue-activated'; document.body.appendChild(m);" +
          "document.getElementById('stage2').innerHTML = '<button id=\"terminal-real\">Terminal action</button>';" +
          "document.getElementById('terminal-real').addEventListener('click', function () { window.location.href = '/terminal-success.html'; });" +
          "}" +
          "});" +
          "</script>",
      );
    }

    // Variation: no Continue-labelled control at all -- a differently-worded progression
    // control is used instead.
    if (path === "/no-continue-wording.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none"><button id="next">Next</button></div>' +
          "<script>" +
          "document.getElementById('next').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
          "document.getElementById('stage2').innerHTML = '<button id=\"terminal-real\">Terminal action</button>';" +
          "document.getElementById('terminal-real').addEventListener('click', function () { window.location.href = '/terminal-success.html'; });" +
          "});" +
          "</script>",
      );
    }

    // Variation: the requested terminal action never appears at all.
    if (path === "/terminal-absent.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none"><button id="continue">Continue</button></div>' +
          "<script>document.getElementById('continue').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
          "});</script>",
      );
    }

    // Variation: the terminal action opens a new tab/window (target=_blank), never
    // navigating the original page at all. The anchor's own click handler still runs on
    // the original page even though the browser also opens a new tab -- it stamps
    // #terminal-reached there, exactly the same generic element_present completion signal
    // pattern already used elsewhere in this codebase (see blockerRecovery.test.ts's own
    // OBJECTIVE_BUTTON), since a url_pattern criterion checked against the *original*
    // page's URL could never be satisfied here (see the known-limitations note on this
    // test below).
    if (path === "/new-tab-terminal.html") {
      return void page(
        ITEM_BUTTON +
          '<div id="stage2" style="display:none"><button id="continue">Continue</button></div>' +
          "<script>" +
          "document.getElementById('continue').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
          "document.getElementById('stage2').innerHTML = '<a id=\"terminal-real\" href=\"/terminal-success.html\" target=\"_blank\">Terminal action</a>';" +
          "document.getElementById('terminal-real').addEventListener('click', function () {" +
          "var t = document.createElement('div'); t.id = 'terminal-reached'; document.body.appendChild(t);" +
          "});" +
          "});" +
          "</script>",
      );
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine fixture server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function orderedInstructionTask(baseUrl: string, path: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return baseTask({
    startUrl: `${baseUrl}${path}`,
    objective: "Select the specified item, then activate the primary progression action, then select the specified terminal action, then stop and return the resulting URL.",
    successCriteria: orderedSuccessCriteria(),
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------
// The required, generic full-sequence test (states A -> B -> C -> D). Must pass before a
// PR implementing this fix is created.
// ---------------------------------------------------------------------------------------

test("GENERIC FULL SEQUENCE: specified item -> intermediate progression action -> changed page state -> requested terminal action -> immediate stop -> resulting URL returned", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/full-sequence.html");
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);

    // State D: the engine stopped immediately -- the last recorded step is the
    // stop_success decision itself, no trailing action/reasoning call after it.
    const lastStep = response.steps[response.steps.length - 1];
    assert.equal(lastStep?.selectedAction.type, "stop_success");

    // Item 18: analytics evidence recorded only for actions actually attempted.
    const clicks = response.captures.cta_clicks ?? [];
    const clickedNames = clicks.map((c) => c.ctaText);
    assert.deepEqual(
      clickedNames,
      ["Select item", "Continue", "Terminal action"],
      "expected exactly the 3 real, correctly-ordered clicks, nothing else",
    );
    assert.ok(
      !clickedNames.some((name) => /should never be clicked here/i.test(name)),
      "the early, wrongly-ordered terminal control must never be clicked",
    );
    assert.ok(
      !clickedNames.includes("Unrelated prominent control"),
      "the unrelated prominent control must never be clicked merely for being prominent/earlier",
    );

    // Item 3 (PART 1): completing the intermediate instruction never marked the whole
    // objective complete -- the run continued through all 3 real clicks plus stop_success,
    // never stopping short after just the first (item-selection) click.
    assert.equal(response.steps.length, 4, "expected item, continue, terminal, and stop_success as 4 distinct steps");
    assert.notEqual(response.steps[response.steps.length - 1]?.selectedAction.type, "click", "the terminal step must be stop_success, never a trailing click");
  } finally {
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// Variation tests (see task spec's numbered list). Each comment names which item(s) it
// proves. Items 15/16/17 (low-confidence/schema corrective retry mechanics, shared budget)
// are proven at the unit level in tests/unit/claudeReasoningProvider.test.ts -- exercising
// them here too would require a fake, non-deterministic model client mid-integration-run,
// which the rest of this file deliberately avoids. Item 20 (existing cookie/blocker/
// destinationUrl/domain-safety tests unchanged) is confirmed by the full suite continuing
// to pass unmodified alongside this new file.
// ---------------------------------------------------------------------------------------

test("VARIATION (item 1): the intermediate action causes full-page navigation, and the terminal control only exists on the destination page (also proves item 5)", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/nav-intermediate.html");
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 3): the intermediate action opens a modal/drawer overlay on the same page", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/modal-intermediate.html");
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 6): multiple intermediate progression steps exist before the terminal control ever appears", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/multi-intermediate.html");
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 7): there is no Continue-labelled control -- another semantically valid progression control (\"Next\") is used", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/no-continue-wording.html");
    const reasoning = new OrderedInstructionModelClient({ ...ORDERED_PATTERNS, "primary-progression": /^next$/i });
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (items 8/9/10): the requested terminal action is wording-agnostic -- test drive, request a quote, and add to cart all work identically", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    for (const terminalWording of ["Book a test drive", "Request a quote", "Add to cart"]) {
      const routePage = await browser.newPage();
      const server: Server = createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        const body = (html: string) =>
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${html}</body></html>`);
        if (path === "/start.html") {
          return void body(
            '<button id="item">Select item</button>' +
              '<div id="stage2" style="display:none"><button id="continue">Continue</button></div>' +
              "<script>document.getElementById('item').addEventListener('click', function () {" +
              "var m = document.createElement('div'); m.id = 'item-selected'; document.body.appendChild(m);" +
              "document.getElementById('stage2').style.display = 'block';" +
              "});" +
              "document.getElementById('continue').addEventListener('click', function () {" +
              "var m = document.createElement('div'); m.id = 'continue-activated'; document.body.appendChild(m);" +
              `document.getElementById('stage2').innerHTML = '<button id="terminal-real">${terminalWording}</button>';` +
              "document.getElementById('terminal-real').addEventListener('click', function () { window.location.href = '/terminal-success.html'; });" +
              "});</script>",
          );
        }
        if (path === "/terminal-success.html") {
          return void body("<h1>Terminal reached</h1>");
        }
        res.writeHead(404).end("Not found");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      const wordingBaseUrl = `http://127.0.0.1:${address.port}`;

      const task = orderedInstructionTask(wordingBaseUrl, "/start.html");
      const wordPattern = new RegExp(terminalWording.split(" ")[0] ?? terminalWording, "i");
      const reasoning = new OrderedInstructionModelClient({ ...ORDERED_PATTERNS, "terminal-action": wordPattern });
      const response = await runTask({ page: routePage, task, reasoning });

      assert.equal(response.status, "success", `expected success for terminal wording "${terminalWording}", got ${response.status}/${response.statusReason}`);
      assert.equal(response.finalUrl, `${wordingBaseUrl}/terminal-success.html`);

      await routePage.close();
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 11): the requested terminal action is absent -- the run never falsely reports success and stops via existing bounded mechanisms", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/terminal-absent.html", {
      limits: { maxSteps: 8, maxBacktracks: 0, maxRepeatedActions: 3 },
    });
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.notEqual(response.status, "success", "must never falsely report success when the terminal instruction can never be satisfied");
    assert.equal(response.engineAssessment.objectiveAchieved, false);
    assert.ok(response.steps.length <= 8, "must stop via an existing bounded mechanism, never loop unboundedly");
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 13): the terminal action opens a new tab/window -- the resulting URL is still captured at the action-evidence level and in finalUrl (also proves item 8)", async () => {
  // KNOWN LIMITATION (see final report): a url_pattern success criterion is checked
  // against the engine's own tracked page, which never navigates for a popup/new tab --
  // the caller must describe terminal success via a criterion satisfiable on the
  // *original* page (element_present here, mirroring the fixture's #terminal-reached
  // marker) rather than url_pattern in this specific scenario. finalUrl/resultingUrl still
  // correctly capture the new tab's destination regardless of which criterion type proves
  // success.
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/new-tab-terminal.html", {
      successCriteria: [
        {
          id: "select-item",
          type: "element_present",
          description: "Select the specified item.",
          config: { selector: "#item-selected" },
          required: true,
        },
        {
          id: "primary-progression",
          type: "element_present",
          description: "Activate the primary progression action.",
          config: { selector: "#continue-activated" },
          required: true,
        },
        {
          id: "terminal-action",
          type: "element_present",
          description: "Select the specified terminal action.",
          config: { selector: "#terminal-reached" },
          required: true,
        },
      ],
    });
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`, "finalUrl must reflect the new tab's destination, not the unchanged original page");

    const clicks = response.captures.cta_clicks ?? [];
    const terminalClick = clicks.find((c) => /terminal action/i.test(c.ctaText));
    assert.ok(terminalClick, "expected the terminal click to be recorded");
    assert.equal(terminalClick?.resultingUrl, `${baseUrl}/terminal-success.html`, "the action-level resultingUrl evidence must reflect the new tab's URL");
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION (item 12): the terminal action opens in the same tab (the main full-sequence test already exercises this; asserted again explicitly here for direct contrast with item 13)", async () => {
  const { baseUrl, close } = await startOrderedInstructionFixtureServer();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = orderedInstructionTask(baseUrl, "/full-sequence.html");
    const reasoning = new OrderedInstructionModelClient(ORDERED_PATTERNS);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success");
    const clicks = response.captures.cta_clicks ?? [];
    const terminalClick = clicks.find((c) => /terminal action/i.test(c.ctaText));
    assert.equal(terminalClick?.resultingUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});
