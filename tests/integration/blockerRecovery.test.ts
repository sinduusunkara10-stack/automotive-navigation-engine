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
  readonly decisions: Decision[] = [];
  private fixedTargetId: string | undefined;
  private captured = false;
  constructor(private readonly pattern: RegExp) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    if (!this.captured) {
      this.captured = true;
      this.fixedTargetId = context.observation.interactiveElements.find((el) => this.pattern.test(el.accessibleName))?.id;
    }
    const decision: Decision =
      this.fixedTargetId && context.allowedActions.includes("click")
        ? { action: { type: "click", target: this.fixedTargetId }, rationale: "Deliberately re-proposing the same target regardless of live state." }
        : context.allowedActions.includes("stop_failure")
          ? { action: { type: "stop_failure" }, rationale: "No target captured." }
          : { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
    this.decisions.push(decision);
    return decision;
  }
}

/**
 * A deliberately unsophisticated stand-in (same spirit as AlwaysSameTargetProvider above):
 * advances through an ordered list of accessible-name patterns one per call, ignoring live
 * reachability entirely -- mirrors the reported production incident's own sequence of
 * distinct candidate targets ("Choisir el-14" -> "el-23" -> ...), each intercepted by the
 * same underlying obstruction. Stops (stop_failure) once every pattern has been tried.
 */
class RotatingCoveredTargetProvider implements ReasoningProvider {
  readonly decisions: Decision[] = [];
  private index = 0;
  constructor(private readonly targetPatterns: RegExp[]) {}

  async decide(context: ReasoningContext): Promise<Decision> {
    const pattern = this.targetPatterns[this.index];
    this.index += 1;
    const target = pattern ? context.observation.interactiveElements.find((el) => pattern.test(el.accessibleName)) : undefined;
    const decision: Decision =
      target && context.allowedActions.includes("click")
        ? {
            action: { type: "click", target: target.id },
            rationale: `Deliberately trying "${target.accessibleName}" regardless of coverage.`,
          }
        : context.allowedActions.includes("stop_failure")
          ? { action: { type: "stop_failure" }, rationale: "No more candidate targets to try." }
          : { action: { type: "stop_blocked" }, rationale: "No permitted action available." };
    this.decisions.push(decision);
    return decision;
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl" | "objective" | "successCriteria">): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "blocker-recovery",
    allowedDomains: ["127.0.0.1"],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 5 },
    safety: { allowedActions: ["click", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.9.0",
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

    if (path === "/persistent-overlay-multi-target-consent.html") {
      // Mirrors the reported production incident's shape: several distinct
      // objective-like controls, all permanently covered by the *same* persistent
      // overlay (which is never dismissed -- there is deliberately no working dismiss
      // control here). Deliberately consent-flavoured generic wording ("Manage
      // preferences"), never any brand/vendor text. See
      // persistent-overlay-multi-target-loading.html below for the non-consent variant
      // proving the exact same mechanism applies identically either way.
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;" role="dialog">Manage preferences</div>' +
          '<button id="objective1">Objective control 1</button>' +
          '<button id="objective2">Objective control 2</button>' +
          '<button id="objective3">Objective control 3</button>' +
          '<button id="objective4">Objective control 4</button>',
      );
    }

    if (path === "/persistent-overlay-multi-target-loading.html") {
      // Identical shape to the consent-flavoured fixture above, but with a loading/busy
      // overlay instead -- proves core/loop.ts's blocker-signature tracking is keyed
      // only on the intercepting element's own generic identity, never on any
      // consent-specific wording or detection.
      return void page(
        '<div id="overlay" style="position:fixed;inset:0;z-index:9999;" role="status">Please wait, loading...</div>' +
          '<button id="continue1">Continue step 1</button>' +
          '<button id="continue2">Continue step 2</button>' +
          '<button id="continue3">Continue step 3</button>' +
          '<button id="continue4">Continue step 4</button>',
      );
    }

    if (path === "/dismiss-succeeds-obstruction-persists.html") {
      // #objective sits under a small overlay positioned exactly over it (not a
      // full-viewport one), while #dismiss1/#dismiss2 sit elsewhere on the page,
      // fully clickable and mechanically successful -- but neither's click handler
      // does anything to the overlay. Reproduces the reported incident's exact shape:
      // two different dismiss-type clicks that both succeed mechanically, while the
      // real obstruction never actually clears.
      return void page(
        '<button id="objective" style="position:absolute;top:100px;left:100px;width:150px;height:30px;">Objective control</button>' +
          '<div id="overlay" style="position:absolute;top:100px;left:100px;width:150px;height:30px;z-index:9999;" role="dialog"></div>' +
          '<button id="dismiss1" style="position:absolute;top:300px;left:100px;">Dismiss attempt one</button>' +
          '<button id="dismiss2" style="position:absolute;top:350px;left:100px;">Dismiss attempt two</button>',
      );
    }

    if (path === "/blocker-signature-changes.html") {
      // document.elementFromPoint is monkey-patched to return a freshly-created,
      // uniquely-labelled element on *every single call* -- guaranteeing the
      // intercepting element's signature can never coincidentally match between two
      // reads. Proves core/loop.ts never treats a genuinely different obstruction as
      // "the same one", and therefore never skips a reasoning call for it.
      return void page(
        '<button id="objective">Objective control</button>' +
          "<script>" +
          "var n = 0;" +
          "document.elementFromPoint = function (x, y) {" +
          "  var el = document.createElement('div');" +
          "  el.setAttribute('role', 'status');" +
          "  el.textContent = 'Dynamic overlay ' + (n++);" +
          "  document.body.appendChild(el);" +
          "  return el;" +
          "};" +
          "</script>",
      );
    }

    if (path === "/header-link-permanent-consent-overlay.html") {
      // Mirrors the reported production incident's shape: an early-DOM, objective-
      // irrelevant header/navigation link (never clicked by any well-behaved decision) sits
      // under the very same full-viewport overlay that also covers the real, later,
      // objective-relevant control -- and the overlay itself never clears. Consent-flavoured
      // generic wording ("Manage cookie preferences"), never any brand/vendor text. See
      // header-link-permanent-loading-overlay.html below for the non-consent variant proving
      // the exact same mechanism applies identically either way.
      return void page(
        '<a id="header-link" href="#">Header link</a>' +
          '<div id="overlay" style="position:fixed;inset:0;z-index:9999;" role="dialog">Manage cookie preferences</div>' +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/header-link-permanent-loading-overlay.html") {
      // Identical shape to the consent-flavoured fixture above, but with a loading/busy
      // overlay instead -- proves the fix applies identically to a non-consent obstruction.
      return void page(
        '<a id="header-link" href="#">Header link</a>' +
          '<div id="overlay" style="position:fixed;inset:0;z-index:9999;" role="status">Please wait, loading...</div>' +
          OBJECTIVE_BUTTON,
      );
    }

    if (path === "/tracked-target-clears-after-checks.html") {
      // No overlay markup at all -- document.elementFromPoint is monkey-patched to
      // synthesize "covered" for the objective control's own hit-test point for its first
      // several checks (deterministic call-count, not wall-clock timing), then reports the
      // real, uncovered result from then on. Proves that once a real decision's target is
      // tracked as blocked and the obstruction is later confirmed gone, that same real
      // target is attempted again and succeeds -- never abandoned or replaced.
      return void page(
        OBJECTIVE_BUTTON +
          "<script>" +
          "var checks = 0;" +
          "var real = document.elementFromPoint.bind(document);" +
          "document.elementFromPoint = function (x, y) {" +
          "  var actual = real(x, y);" +
          "  var objectiveEl = document.getElementById('objective');" +
          "  if (actual === objectiveEl) {" +
          "    checks += 1;" +
          "    if (checks <= 6) {" +
          "      var fake = document.createElement('div');" +
          "      fake.setAttribute('role', 'dialog');" +
          "      fake.textContent = 'Synthetic transient overlay';" +
          "      return fake;" +
          "    }" +
          "  }" +
          "  return actual;" +
          "};" +
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

// ---------------------------------------------------------------------------------------
// Blocker-signature persistence tracking (RunState.lastBlocker*, core/loop.ts): the same
// obstruction across different candidate targets and/or mechanically-successful dismiss
// clicks skips wasted reasoning-provider calls once confirmed unchanged, while bounded
// stale-target exhaustion is still reached exactly as before. Generic throughout -- keyed
// only on the intercepting element's own tag/role/text, never on consent-specific wording.
// ---------------------------------------------------------------------------------------

test("REGRESSION: the same persistent obstruction across four different candidate targets skips reasoning calls once confirmed unchanged, and still reaches bounded exhaustion (consent-flavoured overlay)", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/persistent-overlay-multi-target-consent.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new RotatingCoveredTargetProvider([
      /objective control 1/i,
      /objective control 2/i,
      /objective control 3/i,
      /objective control 4/i,
    ]);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");
    // The core claim: without this fix, each of the 4 steps needed to reach exhaustion
    // would spend up to 4 reasoning calls (1 initial + 3 within-step retries, since a
    // persistently covered target always fails the pre-dispatch check) -- up to 16 calls
    // total, exactly as tests/unit/../signature-changes below still does when the
    // obstruction genuinely differs each time. Here, all 4 candidate patterns are
    // consumed within the first 2 steps (the within-step retry loop's own signature check
    // already stops retrying a 3rd/4th candidate against the same unchanged signature
    // within one step), and the last 2 occurrences needed to reach the same bounded
    // exhaustion are fully deterministic -- 4 real calls total, not 16.
    assert.equal(reasoning.decisions.length, 4, `expected exactly 4 real reasoning calls, got ${reasoning.decisions.length}`);
    assert.equal(response.steps.length, 4);

    const persistentBlockerSteps = response.steps.filter((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.equal(persistentBlockerSteps.length, 2, "expected exactly 2 deterministic persistent-blocker steps");
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: the same mechanism applies identically to a non-consent persistent overlay (a loading/busy panel)", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/persistent-overlay-multi-target-loading.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new RotatingCoveredTargetProvider([
      /continue step 1/i,
      /continue step 2/i,
      /continue step 3/i,
      /continue step 4/i,
    ]);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");
    assert.equal(reasoning.decisions.length, 4, `expected exactly 4 real reasoning calls, got ${reasoning.decisions.length}`);
    assert.equal(response.steps.length, 4);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: two mechanically-successful dismiss-type clicks are never trusted as proof the obstruction cleared -- the objective control (never itself selected or attempted) is never seeded as a tracked blocker target either", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/dismiss-succeeds-obstruction-persists.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new RotatingCoveredTargetProvider([/dismiss attempt one/i, /dismiss attempt two/i]);
    const response = await runTask({ page, task, reasoning });

    // Both dismiss clicks are real, ordinary buttons -- neither ever fails mechanically.
    const dismissSteps = response.steps.filter((s) => /dismiss attempt/i.test(s.decision) || s.selectedAction.type === "click");
    assert.ok(dismissSteps.slice(0, 2).every((s) => s.actionResult.success === true), "both dismiss clicks must succeed mechanically");

    // Yet the run still correctly determines the obstruction never actually cleared: the
    // required success criterion (the objective control's own click handler) is never
    // satisfied, so the run ends in failure regardless of the mechanical click outcomes.
    assert.equal(response.status, "failure");
    // The covered objective control is never selected by a real decision and never
    // dispatched -- FIX (blocker tracking must retain real semantic intent) means it is
    // therefore never seeded as a tracked blocker target purely for being observably
    // covered. Once the reasoning provider's own deliberately short candidate list (both
    // dismiss attempts) is exhausted, it correctly proposes stop_failure itself -- the run
    // never reaches stale_target_recovery_exhausted here, because no unattempted target was
    // ever tracked in the first place.
    assert.equal(response.diagnostics.finishReason, "stop_failure_action");
    assert.equal(
      reasoning.decisions.length,
      3,
      "expected the two real dismiss-attempt calls plus the provider's own final stop_failure, nothing skipped or extra",
    );
    const persistentBlockerSteps = response.steps.filter((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.equal(
      persistentBlockerSteps.length,
      0,
      "no reasoning call may be skipped via the deterministic blocker path when no real decision ever targeted the covered objective control",
    );
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("REGRESSION: a genuinely different obstruction (changed signature) between checks is never treated as the same blocker, so no reasoning call is skipped", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/blocker-signature-changes.html", {
      limits: { maxSteps: 8, maxBacktracks: 0, maxRepeatedActions: 8 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");
    // Every single elementFromPoint call returns a freshly-created, uniquely-labelled
    // element by construction, so no two consecutive covered-checks (whether within one
    // step's own retry loop or across steps) can ever coincide -- the persistence check
    // must never fire, so every within-step retry still spends a real reasoning call
    // rather than being short-circuited (more calls than steps, not fewer or equal).
    assert.ok(
      reasoning.decisions.length > response.steps.length,
      `expected more reasoning calls (${reasoning.decisions.length}) than steps (${response.steps.length}) -- no call should ever be skipped`,
    );
    const skippedSteps = response.steps.filter((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.equal(skippedSteps.length, 0, "the never-matching signature must never trigger the deterministic skip path");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

// ---------------------------------------------------------------------------------------
// FIX (real production run): core/loop.ts's proactive blocker-tracking branch used to seed
// RunState.lastBlockerTargetId from `observation.interactiveElements.find((el) =>
// el.covered)` -- the first covered element in DOM-scan order -- whenever nothing was
// tracked yet, regardless of whether any real decision had ever selected or attempted it.
// On a page where a full-viewport overlay covers both an early, objective-irrelevant header
// link *and* the real, later, objective-relevant control, this picked up the header link
// purely because of its position, and the deterministic stale-target-skip path then marched
// toward stale_target_recovery_exhausted against that irrelevant target -- without the
// reasoning provider ever getting a real attempt at the objective. The fix removes that
// proactive seed entirely: tracking is now established only from the target a real decision
// selected and the dispatched action for it actually failed as covered/intercepted (the
// pre-existing, already-correct post-dispatch branch a few lines below). AlwaysSameTargetProvider
// (defined above) is deliberately blind to reachability -- exactly the kind of decision that
// must still be handled safely -- so it is the right stand-in to exercise this path, as it
// already is for the bounded-recovery-exhausted test above. Entirely synthetic, generic
// fixtures throughout -- no live brand, label, selector, or element id.
// ---------------------------------------------------------------------------------------

test("FIX: an early-DOM unrelated header link under the same overlay as a later objective-relevant control never becomes the blocker-recovery target merely because it appears first in DOM order", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/header-link-permanent-consent-overlay.html", {
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    const headerLinkId = response.steps[0]?.observation.interactiveElements.find((el) => /header link/i.test(el.accessibleName))?.id;
    assert.ok(headerLinkId, "expected the early header link to be present in the very first observation");
    assert.ok(
      response.steps.every((s) => s.selectedAction.target !== headerLinkId),
      "the early, unrelated header link must never be dispatched against -- neither by a real decision (this stand-in never proposes it) nor by the deterministic blocker-recovery skip path",
    );
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("FIX: a real decision selecting the objective-relevant control and getting intercepted anchors blocker tracking to that selected target, not to any other covered element", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/header-link-permanent-consent-overlay.html", {
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    const objectiveId = response.steps[0]?.observation.interactiveElements.find((el) => /objective control/i.test(el.accessibleName))?.id;
    assert.ok(objectiveId, "expected the objective control to be present in the very first observation");

    // The first step's dispatched click is a real decision's own target, and it fails as
    // covered/intercepted -- this is what actually establishes tracking (the pre-existing,
    // unmodified post-dispatch branch), never mere observation.
    const firstFailure = response.steps.find((s) => s.actionResult.staleTarget === true);
    assert.ok(firstFailure, "expected at least one real, dispatched staleTarget failure");
    assert.equal(firstFailure?.selectedAction.target, objectiveId, "the real decision's own target must be what actually failed");

    // Once the deterministic skip path engages, it must act on that exact same
    // decision-selected target -- never a substitute.
    const skipStep = response.steps.find((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.ok(skipStep, "expected the deterministic blocker-recovery skip to eventually engage against a permanent obstruction");
    assert.equal(skipStep?.selectedAction.target, objectiveId, "blocker tracking must be anchored to the real decision's target");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("FIX: the same blocker remaining after one recovery action produces exactly one bounded deterministic skip, spending no fresh reasoning call", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/header-link-permanent-consent-overlay.html", {
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    // Verified empirically: a permanently covered, fixed real target reaches exhaustion in
    // exactly 4 steps -- 2 real dispatched failures (the first establishes tracking, the
    // second is the "one repeat" core/loop.ts always allows before skipping) followed by
    // exactly 2 bounded deterministic skips, using exactly 4 real reasoning-provider calls
    // total (the within-step pre-dispatch retry loop spends one extra call on each of the
    // first 2 steps; the 2 skip steps spend zero).
    assert.equal(response.steps.length, 4);
    assert.equal(reasoning.decisions.length, 4, "expected exactly 4 real reasoning calls, all spent before the first skip");

    const realFailureSteps = response.steps.filter((s) => !s.safetyFlags?.includes("persistent_blocker_detected"));
    const skipSteps = response.steps.filter((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.equal(realFailureSteps.length, 2, "expected exactly 2 real recovery steps establishing and confirming the tracked target");
    assert.equal(skipSteps.length, 2, "expected exactly 2 bounded deterministic skips once the same blocker remained");
    assert.ok(realFailureSteps.every((s) => s.actionResult.staleTarget === true));

    // The very first skip immediately follows the second real step -- one recovery action's
    // worth of repeat is all that is ever allowed before skipping starts.
    assert.equal(response.steps[2], skipSteps[0]);

    // Every skip step dispatches deterministically -- no re-observation/recovery-retry
    // bookkeeping of its own, since no reasoning call is made at all for it.
    for (const s of skipSteps) {
      assert.equal(s.reObservationAttempted, undefined);
      assert.equal(s.recoveryAttempts, undefined);
    }
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("FIX: once the blocker disappears, the same real intended target is attempted again and the journey continues", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/tracked-target-clears-after-checks.html", {
      limits: { maxSteps: 10, maxBacktracks: 0, maxRepeatedActions: 10 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    const objectiveId = response.steps[0]?.observation.interactiveElements.find((el) => /objective control/i.test(el.accessibleName))?.id;
    assert.ok(objectiveId, "expected the objective control to be present in the very first observation");

    const firstFailureIndex = response.steps.findIndex((s) => s.selectedAction.target === objectiveId && s.actionResult.staleTarget === true);
    const firstSuccessIndex = response.steps.findIndex((s) => s.selectedAction.target === objectiveId && s.actionResult.success === true);
    assert.ok(firstFailureIndex >= 0, "expected the real, tracked target to genuinely fail as covered/intercepted at least once");
    assert.ok(firstSuccessIndex >= 0, "expected the same real target to later succeed once the obstruction cleared");
    assert.ok(firstFailureIndex < firstSuccessIndex, "the failure must precede the eventual success -- the journey resumes, it doesn't restart");

    const successStep = response.steps[firstSuccessIndex];
    assert.ok(
      successStep?.progress.satisfiedCriteriaIds.includes("objective-clicked"),
      "the objective's own success criterion must be satisfied once the same real target is successfully attempted",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("FIX: a permanently-remaining blocker still reaches stale_target_recovery_exhausted without an infinite loop and without ever reverting to the unrelated first-covered header link", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/header-link-permanent-consent-overlay.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 20 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");
    assert.ok(response.steps.length < 20, `expected the dedicated recovery bound to stop the run well under maxSteps, took ${response.steps.length} steps`);

    const headerLinkId = response.steps[0]?.observation.interactiveElements.find((el) => /header link/i.test(el.accessibleName))?.id;
    assert.ok(headerLinkId, "expected the header link to be present in the observation");
    assert.ok(
      response.steps.every((s) => s.selectedAction.target !== headerLinkId),
      "exhaustion must be reached against the real intended target, never by reverting to the unrelated first-covered header link",
    );
    await validateAgainstResponseSchema(response);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("FIX: the exact same mechanism applies to a generic non-consent overlay (a loading/busy panel), proving the behaviour is not consent-specific", async () => {
  const { baseUrl, close } = await startBlockerFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = objectiveTask(baseUrl, "/header-link-permanent-loading-overlay.html", {
      limits: { maxSteps: 20, maxBacktracks: 0, maxRepeatedActions: 20 },
    });
    const reasoning = new AlwaysSameTargetProvider(/objective control/i);
    const response = await runTask({ page, task, reasoning });

    assert.equal(response.status, "failure");
    assert.equal(response.diagnostics.finishReason, "stale_target_recovery_exhausted");

    const headerLinkId = response.steps[0]?.observation.interactiveElements.find((el) => /header link/i.test(el.accessibleName))?.id;
    assert.ok(headerLinkId, "expected the header link to be present in the observation");
    assert.ok(
      response.steps.every((s) => s.selectedAction.target !== headerLinkId),
      "the non-consent overlay case must behave identically -- the unrelated header link is never targeted",
    );

    const objectiveId = response.steps[0]?.observation.interactiveElements.find((el) => /objective control/i.test(el.accessibleName))?.id;
    const skipStep = response.steps.find((s) => s.safetyFlags?.includes("persistent_blocker_detected"));
    assert.ok(skipStep, "expected the deterministic blocker-recovery skip to engage identically for a non-consent overlay");
    assert.equal(skipStep?.selectedAction.target, objectiveId);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
