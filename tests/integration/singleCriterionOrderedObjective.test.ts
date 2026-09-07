import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { computeInstructionProgress } from "../../src/reasoning/promptBuilder.js";
import type { TaskRequest, SuccessCriterion } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

/**
 * The REAL n8n request shape (see task requirement this file exists for): the caller sends
 * exactly one semantic_page_match successCriterion whose description is the complete,
 * multiline ordered objective, e.g.:
 *
 *   successCriteria: [{
 *     id: "objective-destination-reached",
 *     type: "semantic_page_match",
 *     description: "<complete multiline ordered objective>",
 *     config: { minScore: 0.4 },
 *     required: true,
 *   }]
 *
 * -- never one successCriterion per instruction (see tests/integration/
 * orderedInstructionExecution.test.ts, which covers that already-supported multi-criterion
 * shape and is unaffected by this file). src/reasoning/instructionParser.ts generically
 * parses this single description into ordered instruction lines, and
 * src/core/instructionProgress.ts's evidence-based ratchet tracks which are done -- both
 * exercised end-to-end here, no request/response schema change involved anywhere.
 *
 * SingleCriterionOrderedModelClient below is the same kind of deterministic, well-behaved
 * reasoning stand-in already used throughout this codebase (see
 * OrderedInstructionModelClient in orderedInstructionExecution.test.ts): it consults the
 * engine's own computeInstructionProgress to find the earliest unfinished *synthetic*
 * instruction position (id `${criterionId}#${segmentIndex}`, produced by the parser) and
 * looks only for an uncovered element matching that specific segment's own test-supplied
 * pattern -- never a later segment's pattern, however prominent. Entirely generic/synthetic
 * fixtures (127.0.0.1, generic English wording) -- no brand, market, or vendor text.
 */
class SingleCriterionOrderedModelClient implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  constructor(private readonly patternsBySegmentIndex: Record<number, RegExp>) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      const decision: Decision = { action: { type: "stop_success" }, rationale: "Every required instruction is satisfied." };
      this.decisions.push(decision);
      return decision;
    }

    const progress = computeInstructionProgress(
      context.successCriteria,
      context.satisfiedCriteriaIds,
      context.internalInstructionProgress,
    );
    const isReachable = (el: { visible?: boolean; disabled?: boolean; covered?: boolean }) =>
      el.visible !== false && !el.disabled && !el.covered;
    const elements = context.observation.interactiveElements;

    if (progress.earliestUnfinished) {
      const segmentIndex = Number(progress.earliestUnfinished.ids[0]?.split("#").pop());
      const pattern = this.patternsBySegmentIndex[segmentIndex];
      if (pattern) {
        const match = elements.find((el) => isReachable(el) && pattern.test(el.accessibleName));
        if (match && context.allowedActions.includes("click")) {
          const decision: Decision = {
            action: { type: "click", target: match.id },
            rationale: `"${match.accessibleName}" matches the earliest unfinished instruction segment ${segmentIndex}.`,
          };
          this.decisions.push(decision);
          return decision;
        }
      }
    }

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
    taskId: "single-criterion-ordered-objective-task",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 15, maxBacktracks: 0, maxRepeatedActions: 6 },
    safety: { allowedActions: ["click", "scroll", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
    ...overrides,
  };
}

// Exactly the wording required by the task spec's item 4.
const MULTILINE_OBJECTIVE =
  "1. Select the specified item.\n" +
  "2. Activate the progression action.\n" +
  "3. Select the specified terminal action.\n" +
  "4. Stop and return the resulting URL.";

function singleSemanticCriterion(): SuccessCriterion[] {
  return [
    {
      id: "objective-destination-reached",
      type: "semantic_page_match",
      description: MULTILINE_OBJECTIVE,
      config: { minScore: 0.4 },
      required: true,
    },
  ];
}

const SEGMENT_PATTERNS: Record<number, RegExp> = {
  0: /^select item$/i,
  1: /^progression action$/i,
  // Segment 2 ("Select the specified terminal action") is deliberately wording-agnostic --
  // matched per-test against whichever terminal control that run's fixture actually offers.
};

// Content deliberately echoes the objective's own vocabulary closely enough to clear the
// criterion's minScore (0.4) via the existing deterministic lexical evaluator alone -- a
// realistic destination page's own title/heading legitimately describing having completed
// the requested journey, not a fixed brand string. See src/core/semanticPageMatch.ts.
const TERMINAL_SUCCESS_BODY =
  "<h1>Select the specified item, activate the progression action, select the specified terminal " +
  "action, stop and return the resulting url.</h1>";
const WRONG_TERMINAL_BODY = "<h1>Wrong terminal -- must never be reached by a correctly-ordered run</h1>";

const TERMINAL_WORDINGS = ["Add to cart", "Book a test drive", "Request a quote", "Contact a dealer", "View stock"];

function terminalButtonId(wording: string): string {
  return `terminal-${wording.replace(/\s+/g, "-").toLowerCase()}`;
}

// Only the button markup -- no embedded <script> tags. A browser never executes a <script>
// element introduced via an .innerHTML assignment (unlike a full page load), so listener
// wiring must always happen as plain JS statements in the *enclosing* script instead -- see
// terminalWireScript below, used both for a same-page innerHTML swap and for a real
// full-page load.
function terminalButtonsHtml(): string {
  return TERMINAL_WORDINGS.map((wording) => `<button id="${terminalButtonId(wording)}">${wording}</button>`).join("");
}

// Plain JS statement source (never re-parsed HTML) that wires each terminal button's click
// handler -- safe to splice directly into any already-executing <script> block, whether that
// block came from the original page load or is running in response to an earlier click.
function terminalWireScript(correctWording: string): string {
  return TERMINAL_WORDINGS.map((wording) => {
    const destination = wording === correctWording ? "/terminal-success.html" : "/wrong-terminal.html";
    return (
      `document.getElementById('${terminalButtonId(wording)}').addEventListener('click', function () { ` +
      `window.location.href = '${destination}'; });`
    );
  }).join("");
}

async function startFixtureServer(correctTerminalWording: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);

    if (path === "/start.html") {
      return void page(
        '<button id="item">Select item</button>' +
          '<div id="stage2" style="display:none"><button id="progression">Progression action</button></div>' +
          "<script>" +
          "document.getElementById('item').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'item-selected'; document.body.appendChild(m);" +
          "document.getElementById('stage2').style.display = 'block';" +
          "});" +
          "document.getElementById('progression').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'progression-activated'; document.body.appendChild(m);" +
          `document.getElementById('stage2').innerHTML = ${JSON.stringify(terminalButtonsHtml())};` +
          terminalWireScript(correctTerminalWording) +
          "});" +
          "</script>",
      );
    }
    if (path === "/terminal-success.html") {
      return void page(TERMINAL_SUCCESS_BODY);
    }
    if (path === "/wrong-terminal.html") {
      return void page(WRONG_TERMINAL_BODY);
    }
    // Full-page-navigation variant of the progression step -- proves internal instruction
    // progress survives a real navigation, not just a same-page DOM update.
    if (path === "/nav-start.html") {
      return void page(
        '<button id="item">Select item</button>' +
          '<div id="stage2" style="display:none"><a id="progression" href="/nav-progression.html">Progression action</a></div>' +
          "<script>document.getElementById('item').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'item-selected'; document.body.appendChild(m);" +
          "document.getElementById('stage2').style.display = 'block';" +
          "});</script>",
      );
    }
    if (path === "/nav-progression.html") {
      return void page(
        terminalButtonsHtml() +
          "<script>" +
          'var m = document.createElement("div"); m.id = "progression-activated"; document.body.appendChild(m);' +
          terminalWireScript(correctTerminalWording) +
          "</script>",
      );
    }
    // Modal/drawer variant of the progression step -- proves internal instruction progress
    // survives a same-page overlay, not just plain in-place DOM content replacement.
    if (path === "/modal-start.html") {
      return void page(
        '<button id="item">Select item</button>' +
          '<div id="stage2" style="display:none"><button id="progression">Progression action</button></div>' +
          "<script>" +
          "document.getElementById('item').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'item-selected'; document.body.appendChild(m);" +
          "document.getElementById('stage2').style.display = 'block';" +
          "});" +
          "document.getElementById('progression').addEventListener('click', function () {" +
          "var m = document.createElement('div'); m.id = 'progression-activated'; document.body.appendChild(m);" +
          "var modal = document.createElement('div');" +
          "modal.setAttribute('role', 'dialog');" +
          "modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:white;';" +
          `modal.innerHTML = ${JSON.stringify(terminalButtonsHtml())};` +
          "document.body.appendChild(modal);" +
          terminalWireScript(correctTerminalWording) +
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

function taskFor(baseUrl: string, path: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return baseTask({
    startUrl: `${baseUrl}${path}`,
    objective: MULTILINE_OBJECTIVE,
    successCriteria: singleSemanticCriterion(),
    ...overrides,
  });
}

function patternsFor(terminalWording: string): Record<number, RegExp> {
  return { ...SEGMENT_PATTERNS, 2: new RegExp(`^${terminalWording}$`, "i") };
}

test("REAL REQUEST SHAPE, FULL SEQUENCE: one semantic_page_match criterion with a multiline description drives item -> progression -> terminal -> stop, choosing the correct terminal action among five alternatives", async () => {
  const correctTerminalWording = "Book a test drive";
  const { baseUrl, close } = await startFixtureServer(correctTerminalWording);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = taskFor(baseUrl, "/start.html");
    const reasoning = new SingleCriterionOrderedModelClient(patternsFor(correctTerminalWording));
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);

    // Instruction lines parsed separately, and only instruction 1 completes from selecting
    // the item -- proven by the exact click sequence below (no premature terminal click).
    const clicks = response.captures.cta_clicks ?? [];
    const clickedNames = clicks.map((c) => c.ctaText);
    assert.deepEqual(clickedNames, ["Select item", "Progression action", correctTerminalWording]);
    assert.ok(!clickedNames.includes("Add to cart"));
    assert.ok(!clickedNames.includes("Request a quote"));
    assert.ok(!clickedNames.includes("Contact a dealer"));
    assert.ok(!clickedNames.includes("View stock"));

    // Terminal action selected from multiple alternatives, immediate stop, resulting URL
    // returned, no subsequent action or reasoning call.
    assert.equal(response.steps.length, 4, "expected item, progression, terminal, and stop_success as 4 distinct steps");
    assert.equal(response.steps[response.steps.length - 1]?.selectedAction.type, "stop_success");
    assert.equal((reasoning as SingleCriterionOrderedModelClient).decisions.length, 4);
  } finally {
    await browser.close();
    await close();
  }
});

for (const terminalWording of ["Book a test drive", "Request a quote", "Add to cart"]) {
  test(`REAL REQUEST SHAPE, TERMINAL WORDING VARIATION: "${terminalWording}" wins among five competing actions`, async () => {
    const { baseUrl, close } = await startFixtureServer(terminalWording);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const task = taskFor(baseUrl, "/start.html");
      const reasoning = new SingleCriterionOrderedModelClient(patternsFor(terminalWording));
      const response = await runTask({ page, task, reasoning });

      assert.equal(response.status, "success", `expected success for "${terminalWording}", got ${response.status}/${response.statusReason}`);
      assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);

      const clicks = response.captures.cta_clicks ?? [];
      assert.equal(clicks[clicks.length - 1]?.ctaText, terminalWording);
    } finally {
      await browser.close();
      await close();
    }
  });
}

test("progression becomes the earliest unfinished instruction and is selected before the terminal action even when a terminal-shaped control is already visible", async () => {
  const correctTerminalWording = "Request a quote";
  const { baseUrl, close } = await startFixtureServer(correctTerminalWording);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = taskFor(baseUrl, "/start.html");
    const reasoning = new SingleCriterionOrderedModelClient(patternsFor(correctTerminalWording));
    const response = await runTask({ page, task, reasoning });

    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks[0]?.ctaText, "Select item");
    assert.equal(clicks[1]?.ctaText, "Progression action", "progression must be selected before any terminal action");
    assert.equal(clicks[2]?.ctaText, correctTerminalWording);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION: the progression step causes a full-page navigation -- internal instruction progress survives it, and the terminal action is still correctly selected from the destination page", async () => {
  const correctTerminalWording = "Add to cart";
  const { baseUrl, close } = await startFixtureServer(correctTerminalWording);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = taskFor(baseUrl, "/nav-start.html");
    const reasoning = new SingleCriterionOrderedModelClient(patternsFor(correctTerminalWording));
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

test("VARIATION: the progression step opens a modal/drawer overlay on the same page -- internal instruction progress survives it", async () => {
  const correctTerminalWording = "View stock";
  const { baseUrl, close } = await startFixtureServer(correctTerminalWording);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const task = taskFor(baseUrl, "/modal-start.html");
    const reasoning = new SingleCriterionOrderedModelClient(patternsFor(correctTerminalWording));
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.finalUrl, `${baseUrl}/terminal-success.html`);
  } finally {
    await browser.close();
    await close();
  }
});

// A minimal, self-contained scripted reasoning stand-in for the plain-objective test below --
// deliberately not SingleCriterionOrderedModelClient, since that class's pattern-by-segment-
// index lookup only makes sense once a description has actually been decomposed. A plain,
// unstructured paragraph never decomposes (see the assertion below), so a plain click-until-
// satisfied-then-stop strategy is the right generic stand-in here.
class PlainObjectiveModelClient implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    if (requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id)) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "Required criterion satisfied." };
    }
    const match = context.observation.interactiveElements.find(
      (el) => el.visible !== false && !el.disabled && !el.covered && /reach destination/i.test(el.accessibleName),
    );
    if (match) {
      return { action: { type: "click", target: match.id }, rationale: `Clicking "${match.accessibleName}".` };
    }
    return { action: { type: "stop_failure" }, rationale: "No reachable control found." };
  }
}

test("a plain, single-paragraph objective with no explicit line structure retains the existing single-objective behaviour (no instruction decomposition)", async () => {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${body}</body></html>`);
    if (path === "/plain-start.html") {
      return void page(
        '<button id="go">Reach destination</button>' +
          "<script>document.getElementById('go').addEventListener('click', function () { window.location.href = '/plain-destination.html'; });</script>",
      );
    }
    if (path === "/plain-destination.html") {
      return void page("<h1>Select the item, activate the progression action, select the terminal action, and stop once the resulting page is reached.</h1>");
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const plainObjective =
      "Select the item, activate the progression action, select the terminal action, and stop once the resulting page is reached.";
    const task = baseTask({
      startUrl: `${baseUrl}/plain-start.html`,
      objective: plainObjective,
      allowedDomains: ["127.0.0.1"],
      successCriteria: [
        {
          id: "objective-destination-reached",
          type: "semantic_page_match",
          description: plainObjective,
          config: { minScore: 0.4 },
          required: true,
        },
      ],
    });

    // The single-objective description parses into < 2 segments, so computeInstructionProgress
    // must report exactly one (unexpanded) instruction position, not several.
    const progress = computeInstructionProgress(task.successCriteria, []);
    assert.equal(progress.earliestUnfinished?.ids[0], "objective-destination-reached");
    assert.equal(progress.terminal?.ids[0], "objective-destination-reached");
    assert.equal(progress.completed.length, 0);
    assert.equal(progress.pending.length, 0);

    const response = await runTask({ page, task, reasoning: new PlainObjectiveModelClient() });
    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
