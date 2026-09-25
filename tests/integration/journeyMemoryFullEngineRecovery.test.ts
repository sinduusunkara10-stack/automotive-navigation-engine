import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";
import RedisMock from "ioredis-mock";

import { runTask } from "../../src/core/engine.js";
import { createRedisJourneyMemoryStore } from "../../src/core/journeyMemory/store.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { validateAgainstTaskResponseSchema } from "../helpers/validateTaskResponseSchema.js";

/**
 * Issue 1 (full-engine cross-run recovery integration test, binding acceptance-issue
 * contract): exercises the REAL production wiring -- runTask() -> loop.ts ->
 * reasoningProvider.ts/promptBuilder.ts -> actions/* -- never journeyMemory service methods
 * in isolation. Uses the same local-HTTP-fixture-server pattern as
 * tests/integration/milestoneAnchoredRecovery.test.ts, and a real, in-process ioredis-mock-
 * backed JourneyMemoryStore (see src/core/journeyMemory/store.ts's createRedisJourneyMemoryStore)
 * injected through runTask()'s test-only journeyMemoryStore param (src/core/engine.ts) --
 * never a live network Redis. Nothing here is automotive/brand-specific: every route/label
 * is synthetic and served from 127.0.0.1/localhost, per CLAUDE.md.
 */

async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    // Run A: a straightforward, real multi-step navigation the engine actually executes and
    // verifies (item 1 of the required sequence).
    if (path === "/start.html") return void page("Start", '<a id="begin" href="/step1.html">Begin Configurator</a>');
    if (path === "/step1.html") {
      return void page(
        "Step 1",
        '<a id="trimAlpha" href="/step2.html">Choose Trim Alpha</a> <a id="trimBeta" href="/deadend.html">Choose Trim Beta</a>',
      );
    }
    if (path === "/step2.html") {
      return void page(
        "Step 2",
        '<div id="configured">Configured</div><a id="summary" href="/summary.html">View Summary</a>',
      );
    }
    if (path === "/summary.html") return void page("Summary", '<div id="summary-complete">Complete</div>');
    if (path === "/deadend.html") return void page("Dead end", "<p>No further controls here.</p>");

    // Run B: a related-but-not-identical journey on the same registrable domain. Its own
    // real start page and its own step1 page whose real (structurally-analogous) control
    // carries a genuinely different id/label than Run A's "Choose Trim Alpha" (item 8: the
    // exact remembered element does not exist under the same id, so semantic candidate
    // matching -- not literal replay -- is what has to find it). Its step1 page's *first*,
    // decoy branch is a genuine dead end (item 5: constructs a real low-confidence/no-
    // progress condition) whose destination page structurally resembles a "configured" page
    // (it eventually reaches the shared /summary.html) but never actually carries the
    // #configured marker Run A's milestone was verified against -- proving (item 10) that
    // historical memory alone can never flip that milestone to verified; only this run's own
    // live observation of the real /step2.html can.
    if (path === "/start-b.html") return void page("Start B", '<a id="begin2" href="/step1-b.html">Begin Configurator</a>');
    if (path === "/step1-b.html") {
      return void page(
        "Step 1 (variant)",
        '<a id="trimBetaDecoy" href="/step2-decoy.html">Select Beta Trim</a> ' +
          '<a id="trimAlphaRenamed" href="/step2.html">Select Alpha Trim</a>',
      );
    }
    if (path === "/step2-decoy.html") return void page("Dead end (decoy)", "<p>Nothing else here.</p>");

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Failed to determine fixture server address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

function isSatisfied(context: ReasoningContext): boolean {
  const requiredIds = context.successCriteria.filter((c) => c.required !== false).map((c) => c.id);
  return requiredIds.every((id) => context.satisfiedCriteriaIds.includes(id));
}

function runATask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "journey-memory-full-engine-run-a",
    allowedDomains: ["127.0.0.1"],
    startUrl,
    objective: "Begin the configurator, choose a trim, and view the configuration summary.",
    successCriteria: [
      { id: "step1", type: "url_pattern", description: "Reach step 1.", config: { pattern: "**/step1.html" } },
      { id: "configured", type: "element_present", description: "Configure a trim.", config: { selector: "#configured" } },
      { id: "summary", type: "url_pattern", description: "Reach the summary.", config: { pattern: "**/summary.html" } },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 10, maxBacktracks: 4, maxRepeatedActions: 6 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

function runBTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.26.0",
    taskId: "journey-memory-full-engine-run-b",
    allowedDomains: ["127.0.0.1"],
    startUrl,
    objective: "Begin the configurator, select the correct trim option, and view the configuration summary.",
    successCriteria: [
      { id: "step1", type: "url_pattern", description: "Reach step 1.", config: { pattern: "**/step1-b.html" } },
      { id: "configured", type: "element_present", description: "Configure a trim.", config: { selector: "#configured" } },
      { id: "summary", type: "url_pattern", description: "Reach the summary.", config: { pattern: "**/summary.html" } },
    ],
    captureModules: ["errors"],
    limits: { maxSteps: 10, maxBacktracks: 4, maxRepeatedActions: 6 },
    safety: { allowedActions: ["click", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.27.0",
  };
}

/** Run A: deterministic, real navigation -- no memory involved (memory is empty on Run A). */
class RunAProvider implements ReasoningProvider {
  private stage: "start" | "step1" | "step2" | "done" = "start";

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All success criteria satisfied." };
    }
    const els = context.observation.interactiveElements;
    const find = (name: string) => els.find((el) => el.accessibleName === name);
    const click = (target: string, rationale: string): Decision => ({ action: { type: "click", target }, rationale });

    if (this.stage === "start") {
      const begin = find("Begin Configurator");
      if (begin) {
        this.stage = "step1";
        return click(begin.id, "Begin the configurator.");
      }
    }
    if (this.stage === "step1") {
      const trimAlpha = find("Choose Trim Alpha");
      if (trimAlpha) {
        this.stage = "step2";
        return click(trimAlpha.id, "Choose trim alpha.");
      }
    }
    if (this.stage === "step2") {
      const summary = find("View Summary");
      if (summary) {
        this.stage = "done";
        return click(summary.id, "View the summary.");
      }
    }
    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

/**
 * Run B: deliberately explores a genuine dead end first (forcing the loop's existing
 * no-milestone-progress escalation signal to fire -- see core/loop.ts's
 * journeyMemoryEscalationSignal), returns a first `stop_blocked` decision with a
 * fallbackReason at the escalated decision (exercising the recovery-focused extra call --
 * core/loop.ts's decisionNeedsRecovery branch), and only on that second, recovery call reads
 * the real (bounded, bounded-to-generic-fields) journeyMemory summary off the *actual*
 * ReasoningContext it was given -- never a value this test injected some other way -- to
 * decide which live element to click. It still requires that element to actually be present
 * on the live page under its own current id/label (never a literal replay of a remembered
 * id): "Select Alpha Trim" is a different id AND a different accessible name than Run A's
 * "Choose Trim Alpha", so the match below is genuinely semantic (token-overlap against the
 * remembered actionLabel), not an exact-string lookup.
 */
class RunBProvider implements ReasoningProvider {
  private stage: "start" | "step1_first" | "step1_after_deadend" | "step2" | "done" = "start";
  private sawDeadEnd = false;
  private escalatedDecisionCallCount = 0;

  /** Set once the escalated decision actually carried journeyMemory guidance built from the real accepted/ambiguous candidates -- the direct proof (item 7) that guidance reached the real prompt passed to the reasoning call, read straight off the ReasoningContext runTask()/loop.ts itself constructed. */
  sawJourneyMemoryInPrompt = false;
  sawJourneyMemoryActionLabel: string | undefined;
  /** True only if this provider ever had to fall back to clicking an element it could not semantically justify from memory -- stays false in the expected path (item 8/12: live-candidate match succeeds, no generic-exploration fallback needed). */
  usedGenericFallback = false;

  async decide(context: ReasoningContext): Promise<Decision> {
    if (isSatisfied(context) && context.allowedActions.includes("stop_success")) {
      return { action: { type: "stop_success" }, rationale: "All success criteria satisfied." };
    }
    const els = context.observation.interactiveElements;
    const find = (name: string) => els.find((el) => el.accessibleName === name);
    const click = (target: string, rationale: string): Decision => ({ action: { type: "click", target }, rationale });

    if (this.stage === "start") {
      const begin = find("Begin Configurator");
      if (begin) {
        this.stage = "step1_first";
        return click(begin.id, "Begin the configurator.");
      }
    }

    if (this.stage === "step1_first") {
      // Deliberately picks the decoy branch first -- a genuine dead end the current-run
      // page shape forces (item 5).
      const decoy = find("Select Beta Trim");
      if (decoy) {
        this.stage = "step1_after_deadend";
        return click(decoy.id, "Try the beta trim option first.");
      }
    }

    if (this.stage === "step1_after_deadend" && !this.sawDeadEnd) {
      // Landed on the decoy dead end: no interactive elements, and critically no
      // #configured marker -- if memory alone could ever satisfy a milestone this is
      // exactly where a broken implementation would wrongly claim "configured" (item 10).
      this.sawDeadEnd = true;
      if (els.length === 0) {
        return { action: { type: "go_back" }, rationale: "Dead end reached; returning to try the other option." };
      }
    }

    // Back at step1-b after the dead end. This is the escalated decision: report it once as
    // a low-confidence stop_blocked (fallbackReason set) so core/loop.ts's recovery-focused
    // extra reasoning.decide() call fires; only that second call below picks the real route.
    const alreadyBackAtStep1 = els.some((el) => el.accessibleName === "Select Alpha Trim" || el.accessibleName === "Select Beta Trim");
    if (alreadyBackAtStep1 && this.stage === "step1_after_deadend") {
      if (context.journeyMemory && context.journeyMemory.records.length > 0) {
        this.sawJourneyMemoryInPrompt = true;
      }
      this.escalatedDecisionCallCount += 1;
      if (this.escalatedDecisionCallCount === 1) {
        // First call at this decision point: report low confidence to force core/loop.ts's
        // one bounded recovery-focused extra reasoning.decide() call (decisionNeedsRecovery)
        // -- exercised below via the second call, which reads the same real journeyMemory
        // summary and actually picks the live route.
        return { action: { type: "stop_blocked" }, rationale: "Low confidence.", fallbackReason: "low_confidence" };
      }
      // Recovery-escalation call: for every remembered record and every live candidate
      // element, score their token overlap and pick the live element with the single best
      // match across the whole remembered set (semantic match, never a literal id/string
      // lookup, and never restricted to only the single highest-ranked remembered record --
      // a real reasoning layer would consider all of them too).
      const tokensOf = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
      let bestElement: (typeof els)[number] | undefined;
      let bestOverlap = 0;
      let bestRecordLabel: string | undefined;
      for (const record of context.journeyMemory?.records ?? []) {
        const rememberedTokens = tokensOf(record.actionLabel);
        for (const el of els) {
          const nameTokens = tokensOf(el.accessibleName);
          let overlap = 0;
          for (const t of nameTokens) if (rememberedTokens.has(t)) overlap += 1;
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestElement = el;
            bestRecordLabel = record.actionLabel;
          }
        }
      }
      this.sawJourneyMemoryActionLabel = bestRecordLabel;
      const semanticMatch = bestOverlap > 0 ? bestElement : undefined;
      const target = semanticMatch ?? find("Select Alpha Trim");
      if (!target) {
        this.usedGenericFallback = true;
        return { action: { type: "stop_failure" }, rationale: "No live candidate matched memory or fell back to exploration." };
      }
      if (!semanticMatch) this.usedGenericFallback = true;
      this.stage = "step2";
      return click(target.id, "Select the alpha trim option (semantically matched against remembered guidance).");
    }

    if (this.stage === "step2") {
      const summary = find("View Summary");
      if (summary) {
        this.stage = "done";
        return click(summary.id, "View the summary.");
      }
    }

    return { action: { type: "stop_failure" }, rationale: "No matching candidate found." };
  }
}

test("Run A verifies a real journey, writes journey memory; Run B's genuine recovery point is guided by it via real semantic matching, and live evidence alone governs milestone verification", async (t) => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();

  const originalEnv = {
    JOURNEY_MEMORY_ENABLED: process.env.JOURNEY_MEMORY_ENABLED,
    JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND: process.env.JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND,
  };
  process.env.JOURNEY_MEMORY_ENABLED = "true";
  // Low bound so the second (post-dead-end) decision at step1-b already qualifies as
  // "no milestone progress yet" -- deterministic, real engine-internal escalation logic,
  // never a second detection mechanism invented for this test.
  process.env.JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND = "2";

  const redisBacking = new RedisMock();
  const sharedStore = createRedisJourneyMemoryStore(redisBacking, { retentionDays: 90 });

  const restoreEnvVar = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  t.after(async () => {
    restoreEnvVar("JOURNEY_MEMORY_ENABLED", originalEnv.JOURNEY_MEMORY_ENABLED);
    restoreEnvVar("JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND", originalEnv.JOURNEY_MEMORY_NO_PROGRESS_ACTION_BOUND);
    await browser.close();
    await close();
  });

  // --- Run A: real runTask(), real navigation, real write-back. ---
  const pageA = await browser.newPage();
  const runAProvider = new RunAProvider();
  const responseA = await runTask({
    page: pageA,
    task: runATask(`${baseUrl}/start.html`),
    reasoning: runAProvider,
    journeyMemoryStore: sharedStore,
  });
  await pageA.close();

  const validationA = await validateAgainstTaskResponseSchema(responseA);
  assert.ok(validationA.valid, validationA.errorsText);
  assert.equal(responseA.status, "success", JSON.stringify(responseA.diagnostics.journeyMemory, null, 2));
  assert.deepEqual([...(responseA.engineAssessment.satisfiedSuccessCriteriaIds ?? [])].sort(), ["configured", "step1", "summary"]);

  assert.ok(responseA.diagnostics.journeyMemory, "expected journeyMemory diagnostics on Run A");
  assert.equal(responseA.diagnostics.journeyMemory?.enabled, true);
  assert.ok((responseA.diagnostics.journeyMemory?.segmentsWritten ?? 0) > 0, "expected Run A to write at least one segment");

  // --- Run B: real runTask(), same shared in-process store, a related-but-different task. ---
  const pageB = await browser.newPage();
  const runBProvider = new RunBProvider();
  const responseB = await runTask({
    page: pageB,
    task: runBTask(`${baseUrl}/start-b.html`),
    reasoning: runBProvider,
    journeyMemoryStore: sharedStore,
  });
  await pageB.close();

  const validationB = await validateAgainstTaskResponseSchema(responseB);
  assert.ok(validationB.valid, validationB.errorsText);

  const jm = responseB.diagnostics.journeyMemory;
  assert.ok(jm, "expected journeyMemory diagnostics on Run B");

  // Item 4: pre-run retrieval found and accepted (or, per scoring.ts's own deliberately
  // strict accept threshold, "ambiguous"-and-therefore-still-usable -- see
  // core/loop.ts's own journeyMemoryEscalationSignal/guidance construction, which treats
  // accepted and ambiguous candidates identically as guidance-eligible) Run A's memory,
  // deterministically -- zero Claude calls in this retrieval itself.
  assert.equal(jm?.lookupCompleted, true);
  assert.ok((jm?.candidatesConsidered ?? 0) > 0, "expected Run B's pre-run retrieval to consider Run A's written segments");
  assert.equal(jm?.candidatesRejected ?? 0, 0, "expected no genuinely irrelevant candidates in this closely-related pair of runs");
  assert.ok(
    (jm?.candidatesAccepted ?? 0) > 0 || jm?.guidanceUsed,
    "expected at least one accepted-or-ambiguous, guidance-eligible candidate from Run A's tier1, same-domain segments",
  );

  // Item 6: the recovery signal activated journey memory guidance.
  assert.equal(jm?.guidanceUsed, true, "expected guidance to have actually been injected once the escalation signal fired");
  assert.ok((jm?.historicalContextRecordCount ?? 0) > 0);
  assert.ok((jm?.historicalContextTokenEstimate ?? 0) > 0);
  assert.ok(jm?.influencedDecisions && jm.influencedDecisions.length > 0);
  assert.ok(jm?.influencedDecisions.every((d) => d.tier === "tier1"), "same-domain memory must be tier1");

  // Item 7: guidance actually reached the real ReasoningContext passed to reasoning.decide().
  assert.equal(runBProvider.sawJourneyMemoryInPrompt, true);
  assert.ok(runBProvider.sawJourneyMemoryActionLabel, "expected an actionLabel to have been present in the injected summary");

  // Item 8/9/12: the remembered action was not blindly replayed -- Run B's real click target
  // ("Select Alpha Trim", a different id/label than Run A's "Choose Trim Alpha") was found
  // by live-observation + semantic matching, not literal replay, and executed via the real
  // action code path (proven by the fixture's own URL actually changing to /step2.html,
  // observed in responseB.steps below). No fallback to generic exploration was needed.
  assert.equal(runBProvider.usedGenericFallback, false);
  assert.equal(jm?.fallbackExplorationUsed, false);
  assert.ok(
    responseB.steps.some((s) => s.currentUrl.endsWith("/step2.html")),
    "expected Run B to have actually navigated to the real step2 page via a real, executed click",
  );

  // Recovery usage: the one bounded extra Claude-shaped call fired and resolved the
  // stop_blocked fallback.
  assert.ok(jm?.extraClaudeCall, "expected the recovery-focused extra call diagnostic to be present");
  assert.equal(jm?.extraClaudeCall?.fired, true);
  assert.equal(jm?.extraClaudeCall?.matchedExecutedVerified, true);

  // Item 10: milestone verification used current-run evidence only. While on the decoy
  // dead-end page (which structurally resembles a "configured" page but never actually
  // carries the #configured marker), the "configured" criterion must never have been
  // satisfied -- proving memory alone (Run A's accepted, successful "configured" segment)
  // never flips a milestone to verified on its own.
  const decoyStep = responseB.steps.find((s) => s.currentUrl.endsWith("/step2-decoy.html"));
  assert.ok(decoyStep, "expected Run B to have actually visited the decoy dead end");
  assert.ok(
    !decoyStep?.progress.satisfiedCriteriaIds.includes("configured"),
    "the decoy page must never be treated as satisfying 'configured' -- only current-run live evidence may",
  );
  // ...and once the real /step2.html was reached, live evidence alone verified it.
  const realStep = responseB.steps.find((s) => s.currentUrl.endsWith("/step2.html"));
  assert.ok(realStep?.progress.satisfiedCriteriaIds.includes("configured"), "expected the real step2 page's own live #configured element to verify the milestone");

  // Item 11: the run advanced past the recovery point to the next expected milestone (and,
  // here, all the way to a verified success outcome).
  assert.equal(responseB.status, "success", JSON.stringify(responseB.diagnostics.journeyMemory, null, 2));
  assert.deepEqual([...(responseB.engineAssessment.satisfiedSuccessCriteriaIds ?? [])].sort(), ["configured", "step1", "summary"]);
});

test("concurrent writers: two independent runTask()-driven writes to the same shared store do not corrupt or silently overwrite each other's verified records", async (t) => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();

  const original = process.env.JOURNEY_MEMORY_ENABLED;
  process.env.JOURNEY_MEMORY_ENABLED = "true";
  t.after(async () => {
    if (original === undefined) delete process.env.JOURNEY_MEMORY_ENABLED;
    else process.env.JOURNEY_MEMORY_ENABLED = original;
    await browser.close();
    await close();
  });

  const redisBacking = new RedisMock();
  const sharedStore = createRedisJourneyMemoryStore(redisBacking, { retentionDays: 90 });

  const pageC = await browser.newPage();
  const pageD = await browser.newPage();

  // Two distinct hostnames resolving to the same local fixture server, so each run gets its
  // own registrable domain (and therefore its own journey-memory keyspace partition) while
  // genuinely writing to the exact same shared JourneyMemoryStore instance concurrently.
  const urlC = baseUrl.replace("127.0.0.1", "127.0.0.1") + "/start.html";
  const urlD = baseUrl.replace("127.0.0.1", "localhost") + "/start.html";

  const [responseC, responseD] = await Promise.all([
    runTask({
      page: pageC,
      task: { ...runATask(urlC), taskId: "journey-memory-concurrent-c", allowedDomains: ["127.0.0.1"] },
      reasoning: new RunAProvider(),
      journeyMemoryStore: sharedStore,
    }),
    runTask({
      page: pageD,
      task: { ...runATask(urlD), taskId: "journey-memory-concurrent-d", allowedDomains: ["localhost"] },
      reasoning: new RunAProvider(),
      journeyMemoryStore: sharedStore,
    }),
  ]);

  await pageC.close();
  await pageD.close();

  assert.equal(responseC.status, "success");
  assert.equal(responseD.status, "success");
  assert.ok((responseC.diagnostics.journeyMemory?.segmentsWritten ?? 0) > 0);
  assert.ok((responseD.diagnostics.journeyMemory?.segmentsWritten ?? 0) > 0);

  const recordsC = await sharedStore.listDomain("127.0.0.1");
  const recordsD = await sharedStore.listDomain("localhost");
  assert.ok(recordsC.length > 0, "expected run C's own domain to retain its own written records");
  assert.ok(recordsD.length > 0, "expected run D's own domain to retain its own written records, not overwritten by run C's concurrent write");
  assert.ok(
    recordsC.every((r) => r.provenance.registrableDomain === "127.0.0.1"),
    "run C's records must never be corrupted by run D's concurrent write",
  );
  assert.ok(
    recordsD.every((r) => r.provenance.registrableDomain === "localhost"),
    "run D's records must never be corrupted by run C's concurrent write",
  );
});
