import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

async function validateAgainstResponseSchema(response: unknown): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as Record<string, unknown>;
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(response);
  assert.ok(valid, ajv.errorsText(validate.errors));
}

/**
 * REGRESSION (real production run): a full-viewport consent-style overlay's own control
 * looked identical, in the observation, to a genuinely clickable one -- reachable at the
 * moment it was observed, but gone (hidden, detached-and-replaced, or its owning frame
 * removed) by the time the engine actually tried to dispatch a click on it. The previous
 * fix (PR #24, "covered") gave the reasoning layer evidence to *prefer* an uncovered
 * control up front; it did not address what happens when a target that looked fine at
 * decision time goes stale in the (unavoidable) gap between deciding and dispatching --
 * the reported run's click failed with clickErrorCategory=hidden,
 * fallbackRejectedReason=unsafe_protocol, and the whole task ended immediately in
 * action_execution_error with the real journey-progress control never attempted.
 *
 * Root cause and fix, precisely:
 *  - src/actions/click.ts now classifies a failed click's cause (hidden, detached,
 *    covered/intercepted, timed out, or its owning frame becoming unavailable) as
 *    `staleTarget` -- a race, never a genuinely wrong decision -- as distinct from
 *    "disabled" (a legitimate, already-visible fact) or a truly unknown error.
 *  - src/core/loop.ts's pre-dispatch revalidation is now a small bounded loop (not a
 *    single retry-then-dispatch-anyway), and a dispatched staleTarget failure is no
 *    longer immediately fatal: it is tracked via a dedicated, bounded consecutive-failure
 *    counter (RunState.consecutiveStaleTargetFailures) and the run simply continues to
 *    its next step (a brand-new observation, another chance for the reasoning provider)
 *    until that bound is exceeded, at which point the run stops with a precise
 *    "stale_target_recovery_exhausted" reason instead of the generic
 *    "action_execution_error".
 *  - One level of generic, same-origin child-frame scanning (src/observation/frames.ts)
 *    lets the engine see and act on a blocker whose live control happens to live inside an
 *    iframe, without any vendor/CMP-specific iframe selector.
 *  - A new, fully generic consentInteractionPolicy (types/task-request.ts) gates how much
 *    latitude the model has to interact with a consent/preference-shaped control at all --
 *    tested at the prompt level in tests/unit/promptBuilder.test.ts; the engine itself
 *    never keyword-matches "accept"/"reject" text.
 *
 * BlockerAwareModelClient below is a deterministic stand-in for a well-behaved reasoning
 * decision (mirrors PR #24's CoveredAwareModelClient): it inspects only the same compact
 * Observation evidence a real model would receive (visible/covered/disabled, accessible
 * name, frameOrigin) and never hardcodes an element id, a CTA word, or a selector. Every
 * fixture below is entirely synthetic, served from 127.0.0.1, with generic English labels
 * ("Objective control", "Dismiss blocker") -- no brand, market, or vendor wording anywhere,
 * matching this session's established convention that test fixtures may reproduce an
 * incident's *shape* without production code ever encoding it.
 */

interface PromptPageElement {
  id: string;
  accessibleName: string;
  visible?: boolean;
  disabled?: boolean;
  covered?: boolean;
  frameOrigin?: string;
}

class BlockerAwareModelClient implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  constructor(
    private readonly objectivePattern: RegExp,
    private readonly blockerPattern: RegExp,
  ) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
    const allSatisfied = requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
    if (allSatisfied && context.allowedActions.includes("stop_success")) {
      const decision: Decision = { action: { type: "stop_success" }, rationale: "Required criteria satisfied." };
      this.decisions.push(decision);
      return decision;
    }

    const isReachable = (el: PromptPageElement) => el.visible !== false && !el.disabled && !el.covered;
    const elements = context.observation.interactiveElements as PromptPageElement[];

    const objective = elements.find((el) => isReachable(el) && this.objectivePattern.test(el.accessibleName));
    if (objective && context.allowedActions.includes("click")) {
      const decision: Decision = {
        action: { type: "click", target: objective.id },
        rationale: `"${objective.accessibleName}" is uncovered and matches the objective.`,
      };
      this.decisions.push(decision);
      return decision;
    }

    const blocker = elements.find((el) => isReachable(el) && this.blockerPattern.test(el.accessibleName));
    if (blocker && context.allowedActions.includes("click")) {
      const decision: Decision = {
        action: { type: "click", target: blocker.id },
        rationale: `Clearing blocking control "${blocker.accessibleName}" before the objective is reachable.`,
      };
      this.decisions.push(decision);
      return decision;
    }

    const decision: Decision = context.allowedActions.includes("stop_failure")
      ? { action: { type: "stop_failure" }, rationale: "No reachable control available." }
      : { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
    this.decisions.push(decision);
    return decision;
  }
}

/**
 * A deliberately unsophisticated stand-in (mirrors the pre-existing
 * tests/integration/actionExecutionConsistency.test.ts's StubbornClickProvider): picks a
 * target once from the initial observation and keeps blindly re-proposing that exact same
 * id forever, regardless of its live reachability. A well-behaved model (like
 * BlockerAwareModelClient above) would never do this -- it can already see a covered
 * control is covered and would converge to stop_failure instead -- so this is the only way
 * to deterministically exercise core/loop.ts's bounded stale-target recovery ceiling
 * itself, as distinct from proving the ceiling is never *needed* in the first place.
 */
class AlwaysSameTargetProvider implements ReasoningProvider {
  private fixedTargetId: string | undefined;
  private captured = false;
  constructor(private readonly pattern: RegExp) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.captured) {
      this.captured = true;
      this.fixedTargetId = context.observation.interactiveElements.find((el) => this.pattern.test(el.accessibleName))?.id;
    }
    if (this.fixedTargetId && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: this.fixedTargetId }, rationale: "Deliberately re-proposing the same target regardless of live state." };
    }
    return context.allowedActions.includes("stop_failure")
      ? { action: { type: "stop_failure" }, rationale: "No target captured." }
      : { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.5.0",
    taskId: "blocker-recovery",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 5 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.5.0",
    ...overrides,
  };
}

// element_present (not the still-unimplemented element_text_match) is the real,
// evaluator-backed criterion type here: the objective control's own click handler creates
// this element for the first time, so its presence is proof the control was actually
// activated, not just that the page loaded.
const REACHED_OBJECTIVE_CRITERION = {
  id: "objective-clicked",
  type: "element_present" as const,
  description: "The objective control's own click handler confirms it was activated.",
  config: { selector: "#objective-reached" },
  required: true,
};

// ---------------------------------------------------------------------------------------
// Single-origin fixture server: every scenario below that doesn't specifically need a
// second origin (the cross-host tests further down do) is served from here.
// ---------------------------------------------------------------------------------------
async function startBlockerFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (body: string) =>
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);

    const OBJECTIVE_BUTTON =
      '<button id="objective">Objective control</button>' +
      `<script>document.getElementById('objective').addEventListener('click', function () {` +
      `var reached = document.createElement('div'); reached.id = 'objective-reached'; document.body.appendChild(reached);});</script>`;

    if (path === "/hidden-before-dispatch.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss">Dismiss blocker</button></div>' +
          OBJECTIVE_BUTTON +
          // Mutation-observer-triggered, not a bare timer: fires deterministically right
          // after buildObservation's very first scan tags #dismiss, then removes the
          // overlay on the next tick -- reproduces "visible when observed, gone (hidden,
          // since it is nested inside the removed overlay) by the time of dispatch"
          // without depending on real wall-clock timing/CI speed.
          "<script>" +
          "var o = new MutationObserver(function () {" +
          "  if (document.getElementById('dismiss') && document.getElementById('dismiss').hasAttribute('data-nav-engine-id')) {" +
          "    o.disconnect();" +
          "    setTimeout(function () { document.getElementById('overlay').remove(); }, 0);" +
          "  }" +
          "});" +
          "o.observe(document.getElementById('dismiss'), { attributes: true });" +
          "</script>",
      );
    }

    if (path === "/detached-and-replaced.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss">Dismiss blocker</button></div>' +
          OBJECTIVE_BUTTON +
          "<script>" +
          "var o = new MutationObserver(function () {" +
          "  var el = document.getElementById('dismiss');" +
          "  if (el && el.hasAttribute('data-nav-engine-id')) {" +
          "    o.disconnect();" +
          "    setTimeout(function () {" +
          "      var replacement = document.createElement('button');" +
          "      replacement.id = 'dismiss';" +
          "      replacement.textContent = 'Dismiss blocker';" +
          "      replacement.addEventListener('click', function () { document.getElementById('overlay').remove(); });" +
          "      el.replaceWith(replacement);" +
          "    }, 0);" +
          "  }" +
          "});" +
          "o.observe(document.getElementById('dismiss'), { attributes: true });" +
          "</script>",
      );
    }

    if (path === "/duplicate-hidden-visible.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          '<button id="hidden-dup" style="display:none" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button>' +
          '<button id="visible-dup" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button>' +
          "</div>" +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/desktop-mobile-duplicate.html") {
      return void page(
        "<style>.mobile-only{display:none} @media (max-width:600px){.mobile-only{display:block} .desktop-only{display:none}}</style>" +
          '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          '<button class="mobile-only" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button>' +
          '<button class="desktop-only" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button>' +
          "</div>" +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/same-origin-iframe-blocker.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          '<iframe srcdoc="&lt;button onclick=&quot;parent.document.getElementById(' +
          "'overlay'" +
          ").remove()&quot;&gt;Dismiss blocker&lt;/button&gt;\"></iframe>" +
          "</div>" +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/frame-unavailable.html") {
      // The mutation observer lives *inside* the iframe's own document (watching its own
      // button for the engine's data-nav-engine-id tag), since nothing about scanning the
      // frame's content ever mutates the outer <iframe> tag itself. Once tagged, it asks
      // its (same-origin) parent to remove the iframe entirely -- reproducing the frame
      // becoming unavailable between observation and dispatch.
      const iframeSrcdoc =
        "<button id='dismiss'>Dismiss blocker</button><script>" +
        "var o = new MutationObserver(function () {" +
        "  if (document.getElementById('dismiss').hasAttribute('data-nav-engine-id')) {" +
        "    o.disconnect();" +
        "    setTimeout(function () { parent.document.getElementById('the-frame').remove(); }, 0);" +
        "  }" +
        "});" +
        "o.observe(document.getElementById('dismiss'), { attributes: true });" +
        "</script>";
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          `<iframe id="the-frame" srcdoc="${iframeSrcdoc.replace(/"/g, "&quot;")}"></iframe>` +
          "</div>" +
          // A hidden main-document decoy with the *same* accessible name -- proves the
          // engine, once the iframe is gone, never falls back to clicking this instead.
          '<button style="display:none" id="decoy">Dismiss blocker</button>' +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/stale-markup-ignored.html") {
      return void page(
        // Inert leftover markup: uncovered, enabled, but wired to do nothing -- exactly
        // what a stale/already-handled CMP element left in the DOM looks like.
        '<button id="stale">Dismiss blocker</button>' + OBJECTIVE_BUTTON,
      );
    }

    if (path === "/genuine-overlay-then-clear.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button></div>' +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/blocker-disappears-itself.html") {
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss">Dismiss blocker</button></div>' +
          OBJECTIVE_BUTTON +
          "<script>" +
          "var o = new MutationObserver(function () {" +
          "  if (document.getElementById('dismiss') && document.getElementById('dismiss').hasAttribute('data-nav-engine-id')) {" +
          "    o.disconnect();" +
          "    setTimeout(function () { document.getElementById('overlay').remove(); }, 0);" +
          "  }" +
          "});" +
          "o.observe(document.getElementById('dismiss'), { attributes: true });" +
          "</script>",
      );
    }

    if (path === "/javascript-void-never-fallback.html") {
      return void page(
        // #dismiss is permanently covered by a second, always-on layer (deliberately, so
        // only a stub that ignores reachability -- see AlwaysSameTargetProvider -- will
        // ever attempt it, exactly reproducing the reported incident's decision). The
        // objective control stays permanently covered too, so the engine's only route
        // forward is #dismiss's own destinationUrl fallback, which must be rejected.
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          '<div style="position:fixed;inset:0;z-index:10000;"></div>' +
          '<a id="dismiss" href="javascript:void(0)">Dismiss blocker</a>' +
          "</div>" +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/bounded-recovery-exhausted.html") {
      return void page(
        // The overlay never clears, and its own dismiss control is itself always covered
        // by a second, permanent layer -- nothing the engine could ever legitimately click
        // resolves this page. Genuinely unrecoverable, on purpose. (Exercised by a
        // deliberately unsophisticated stub that keeps re-proposing the same id regardless
        // of live reachability -- see AlwaysSameTargetProvider below -- since a
        // well-behaved one would correctly never attempt a control it can already see is
        // covered, converging cleanly to stop_failure instead of ever reaching this bound.)
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;">' +
          '<div style="position:fixed;inset:0;z-index:10000;"></div>' +
          '<button id="dismiss">Dismiss blocker</button>' +
          "</div>" +
          OBJECTIVE_BUTTON,
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

function objectiveTask(baseUrl: string, path: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return baseTask({
    startUrl: `${baseUrl}${path}`,
    objective: "Clear any blocking control if genuinely necessary, then activate the objective control.",
    successCriteria: [REACHED_OBJECTIVE_CRITERION],
    ...overrides,
  });
}

test("REGRESSION: a blocker control visible at observation time but hidden before dispatch is re-observed, not treated as a fatal action failure", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/hidden-before-dispatch.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);
    // The pre-dispatch bounded loop catches this before ever calling dispatchAction, so no
    // click ever actually fails here at all.
    assert.equal(response.captures.errors, undefined);
    // The recovery diagnostics (reObservationAttempted/recoveryAttempts -- item "Diagnostics
    // and deployment verification" of the fix) must be present and schema-valid.
    assert.ok(response.steps.some((s) => s.reObservationAttempted === true && (s.recoveryAttempts ?? 0) > 0));
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a selected blocker control detached and replaced by a new element before dispatch is picked up under its new id", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/detached-and-replaced.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 2, "expected exactly two clicks: dismiss (under its replaced id), then the objective control");
    assert.match(clicks[0]?.ctaText ?? "", /dismiss blocker/i);
    assert.match(clicks[1]?.ctaText ?? "", /objective control/i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a hidden duplicate control with the same accessible name as a visible one is never selected -- only the live control is", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/duplicate-hidden-visible.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(clicks.every((c) => c.actionSucceeded), "every dispatched click must have succeeded (never attempted on the hidden duplicate)");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a responsive desktop/mobile duplicate pair resolves the same way -- only the currently-visible variant is ever selected", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/desktop-mobile-duplicate.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(clicks.every((c) => c.actionSucceeded));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a live blocker control inside a same-origin iframe is scanned, resolved, and clicked via its own frame -- no vendor-specific iframe selector", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/same-origin-iframe-blocker.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 2);
    assert.match(clicks[0]?.ctaText ?? "", /dismiss blocker/i);
    // The frame-scoped element must have carried frameOrigin in the observation the
    // decision was actually made from.
    const firstStepFrameEl = response.steps[0]?.observation.interactiveElements.find((el) => /dismiss blocker/i.test(el.accessibleName));
    assert.ok(firstStepFrameEl?.frameOrigin, "expected the iframe control to carry frameOrigin");
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: an iframe that becomes unavailable before dispatch produces a bounded, precise stop -- never a click on a hidden main-document duplicate", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/frame-unavailable.html", {
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 8 },
    });
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.notEqual(response.status, "success");
    // A well-behaved reasoning decision (this stub included) never even proposes a target
    // it can already see is unreachable, so the pre-dispatch bounded loop (core/loop.ts)
    // typically catches the frame's disappearance before a dispatch is ever attempted at
    // all -- a clean stop_failure once nothing reachable remains. If instead a dispatch
    // was attempted and failed, the bounded post-dispatch recovery still produces the same
    // kind of precise, non-fatal-until-exhausted outcome. Either way this must be a
    // specific, bounded stop -- never an unbounded hang or a crash.
    assert.ok(
      ["stop_failure_action", "stale_target_recovery_exhausted"].includes(response.diagnostics.finishReason),
      `expected a precise, bounded stop, got finishReason=${response.diagnostics.finishReason}`,
    );
    // Proves the pre-dispatch bounded recovery loop actually engaged (not simply that the
    // iframe's content was invisible to the engine from the start, which would make "never
    // clicks the decoy" trivially true for the wrong reason): the frame-scoped candidate
    // must have been genuinely selected, then found stale, triggering re-observation.
    assert.ok(
      response.steps[0]?.reObservationAttempted === true,
      "expected the iframe's control to have been selected and then found stale, not simply never seen",
    );
    // The hidden main-document decoy sharing the same accessible name must never have been
    // clicked -- if it had, the overlay would have been removed and the run would have
    // succeeded via the objective control instead.
    const clicks = response.captures.cta_clicks ?? [];
    assert.ok(!clicks.some((c) => c.actionSucceeded && /objective control/i.test(c.ctaText)));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: stale, uncovered leftover consent-style markup is simply ignored when the objective control is itself already reachable", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/stale-markup-ignored.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 1, "expected exactly one click: the objective control directly, ignoring the stale markup entirely");
    assert.match(clicks[0]?.ctaText ?? "", /objective control/i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a genuine overlay blocking the objective control is dismissed, the engine re-observes, and then clicks the now-uncovered objective control", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/genuine-overlay-then-clear.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    const clicks = response.captures.cta_clicks ?? [];
    assert.equal(clicks.length, 2);
    assert.match(clicks[0]?.ctaText ?? "", /dismiss blocker/i);
    assert.match(clicks[1]?.ctaText ?? "", /objective control/i);
    // Dismissing the blocker must never itself count as reaching the objective.
    assert.equal(clicks[0]?.actionAnalytics?.newlySatisfiedCriteriaIds, undefined);
    assert.deepEqual(clicks[1]?.actionAnalytics?.newlySatisfiedCriteriaIds, ["objective-clicked"]);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a blocker that disappears entirely by itself between decision and dispatch is never recorded as an action failure", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/blocker-disappears-itself.html");
    const reasoning = new BlockerAwareModelClient(/objective control/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.captures.errors, undefined, "the self-clearing blocker must never be recorded as an action failure");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a javascript:void(0) blocker control is never used as a navigation fallback, whether or not the run ultimately recovers", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/javascript-void-never-fallback.html", {
      limits: { maxSteps: 8, maxBacktracks: 0, maxRepeatedActions: 8 },
    });
    const reasoning = new AlwaysSameTargetProvider(/dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.notEqual(response.status, "success");
    const urls = response.steps.map((s) => s.currentUrl);
    assert.ok(urls.every((u) => !u.startsWith("javascript:")), "the page must never actually navigate to a javascript: URL");
    const fallbackAttempts = (response.captures.errors ?? []).filter((e) => e.message.includes("fallbackNavigationAttempted=true"));
    assert.equal(fallbackAttempts.length, 0, "a javascript: destinationUrl must never be attempted as a fallback");
    assert.ok((response.captures.errors ?? []).some((e) => e.message.includes("fallbackRejectedReason=unsafe_protocol")));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: recovery is bounded -- the same permanently-stale target is not retried indefinitely, and the run stops with a precise reason", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/bounded-recovery-exhausted.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new AlwaysSameTargetProvider(/dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");
    // Exhaustion must be reached well before the generous maxSteps ceiling -- proof the
    // dedicated bound, not maxSteps, is what actually stopped this run.
    assert.ok(response.steps.length < 20, `expected the dedicated recovery bound to stop the run well under maxSteps, took ${response.steps.length} steps`);

    const staleEntries = (response.captures.errors ?? []).filter((e) => e.category === "stale_target_recovery");
    assert.ok(staleEntries.length >= 2, "expected multiple recorded staleTarget occurrences leading up to exhaustion");
    assert.ok(staleEntries.slice(0, -1).every((e) => e.recoverable === true && e.stoppedRun === false), "every occurrence before the last must be recoverable");
    const last = staleEntries.at(-1);
    assert.equal(last?.recoverable, false);
    assert.equal(last?.stoppedRun, true);

    const staleActionResults = response.steps.map((s) => s.actionResult).filter((r) => r.staleTarget === true);
    assert.ok(staleActionResults.length >= 2, "expected ActionResult.staleTarget to be set on every occurrence");
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// Cross-host scenarios (task requirements: independent per-host consent state, a second
// blocker legitimately re-appearing on the destination host, and the full end-to-end
// combination). Two real HTTP origins with genuinely *different hostnames* -- "127.0.0.1"
// and "localhost", both loopback, no network/DNS flakiness -- so the engine's own
// hostname-based host_context_snapshot trigger (core/loop.ts) fires exactly as it would
// for two real, differently-named hosts, and localStorage/sessionStorage genuinely isolate
// per-origin exactly as a real cross-subdomain transition would.
// ---------------------------------------------------------------------------------------

async function startHostServer(
  bindHost: string,
  routes: Record<string, string>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><title>Fixture</title></head><body>${body}</body></html>`);
  });
  await new Promise<void>((resolve) => server.listen(0, bindHost, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine fixture server address");
  }
  return {
    baseUrl: `http://${bindHost}:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("REGRESSION (end-to-end): landing-host blocker handled, cross-host navigation, an independently-initialised destination-host blocker handled separately, objective reached", async () => {
  // The destination's own blocker requires an explicit dismiss click, exactly like the
  // landing host's -- proving the destination's independently-initialised blocker is
  // actually handled on its own, never assumed already-clear because the landing host's
  // was.
  const destination = await startHostServer("localhost", {
    "/destination.html":
      '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button></div>' +
      '<button id="objective">Objective control</button>' +
      "<script>document.getElementById('objective').addEventListener('click', function () {" +
      "var reached = document.createElement('div'); reached.id = 'objective-reached'; document.body.appendChild(reached);});</script>",
  });
  const landingReal = await startHostServer("127.0.0.1", {
    "/landing.html":
      '<div id="overlay" style="position:fixed;inset:0;z-index:9999;"><button id="dismiss" onclick="document.getElementById(\'overlay\').remove()">Dismiss blocker</button></div>' +
      `<a id="enter" href="${destination.baseUrl}/destination.html">Enter</a>`,
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({
      startUrl: `${landingReal.baseUrl}/landing.html`,
      objective: "Clear any blocking control, enter the destination, clear any blocking control there too, then activate the objective control.",
      successCriteria: [REACHED_OBJECTIVE_CRITERION],
      allowedDomains: ["127.0.0.1", "localhost"],
      captureModules: ["errors", "cta_clicks", "host_context_snapshot"],
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 5 },
    });
    const reasoning = new BlockerAwareModelClient(/objective control|^enter$/i, /dismiss blocker/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "success", `expected success, got ${response.status}/${response.statusReason}`);
    assert.equal(response.engineAssessment.objectiveAchieved, true);

    const snapshots = response.captures.host_context_snapshot ?? [];
    const hostnames = new Set(snapshots.map((s) => s.hostname));
    assert.equal(hostnames.size, 2, "expected a distinct host_context_snapshot baseline for each host visited");

    const clicks = response.captures.cta_clicks ?? [];
    const dismissClicks = clicks.filter((c) => /dismiss blocker/i.test(c.ctaText));
    assert.equal(dismissClicks.length, 2, "expected the blocker to be dismissed independently on *each* host -- landing handling must never be assumed to carry over");
    assert.match(clicks.at(-1)?.ctaText ?? "", /objective control/i);
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await landingReal.close();
    await destination.close();
  }
});
