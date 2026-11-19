import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { RunState } from "../../src/core/state.js";
import { returnToParentSurface } from "../../src/core/surfaceReturn.js";
import { executeTaskAsync, type RunnerBrowser } from "../../src/api/runner.js";
import { createInMemoryTaskStore } from "../../src/api/inMemoryTaskStore.js";
import {
  MAX_ACTION_TRACE_RECORDS,
  MAX_PAGE_LIFECYCLE_EVENTS,
  PageLifecycleLog,
  markEngineClose,
} from "../../src/diagnostics/pageLifecycle.js";
import { MAX_FAILURE_RECORDS, buildEngineFailureContext } from "../../src/diagnostics/failureContext.js";
import { MockReasoningProvider } from "../../src/reasoning/mockReasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type { ActionTraceRecord, EngineFailureContext } from "../../src/types/failureDiagnostics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const TIMING = { ttlSeconds: 86400, staleThresholdMs: 90_000, heartbeatIntervalMs: 15_000 };

function buildTask(startUrl: string, overrides: Partial<TaskRequest> = {}): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "failure-black-box",
    objective: "Reach a page this fixture never actually provides.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      {
        id: "unreachable",
        type: "url_pattern",
        description: "A page this run never reaches.",
        config: { pattern: "**never-reached.html" },
      },
    ],
    captureModules: [],
    limits: { maxSteps: 8, maxBacktracks: 3, maxRepeatedActions: 3 },
    safety: { allowedActions: ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"] },
    outputSchemaVersion: "1.53.0",
    ...overrides,
  };
}

/** Clicks "Continue" on call 1, returns `secondDecision` on call 2, throws on call 3. */
function scriptedProvider(secondDecision: Decision["action"]): ReasoningProvider {
  let calls = 0;
  return {
    async decide(context: ReasoningContext): Promise<Decision> {
      calls += 1;
      if (calls === 1) {
        const target = context.observation.interactiveElements.find((el) => el.accessibleName === "Continue");
        assert.ok(target, "fixture start page should expose a Continue link");
        return { action: { type: "click", target: target.id }, rationale: "test: continue" };
      }
      if (calls === 2) {
        return { action: secondDecision, rationale: "test: second decision" };
      }
      throw new Error("simulated failure after go_back");
    },
  };
}

function failureContextOf(error: unknown): EngineFailureContext {
  const context = (error as { engineFailureContext?: EngineFailureContext }).engineFailureContext;
  assert.ok(context, "expected engineFailureContext on the thrown error");
  return context;
}

async function withFixtures<T>(fn: (baseUrl: string, page: Page) => Promise<T>): Promise<T> {
  const fixtures = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    return await fn(fixtures.baseUrl, page);
  } finally {
    console.error = originalConsoleError;
    await browser.close().catch(() => {});
    await fixtures.close();
  }
}

test("a thrown run keeps its partial diagnostics, page trace and a reasoning-selected go_back source", async () => {
  await withFixtures(async (baseUrl, page) => {
    const task = buildTask(`${baseUrl}/start.html`);
    let caught: unknown;
    await runTask({ page, task, reasoning: scriptedProvider({ type: "go_back" }) }).catch((e: unknown) => {
      caught = e;
    });
    assert.ok(caught instanceof Error);
    assert.equal(caught.message, "simulated failure after go_back");
    // Non-enumerable, so printing the error keeps the one-line summary only.
    assert.equal(Object.keys(caught).includes("engineFailureContext"), false);

    const context = failureContextOf(caught);
    assert.equal(context.stepCount, 2);
    assert.equal(context.activeSurface, "main");
    assert.equal(context.activePageId, "page-1");

    const partial = context.partialDiagnostics;
    assert.ok(partial);
    assert.deepEqual(
      partial.steps.map((s) => s.actionType),
      ["click", "go_back"],
    );
    assert.ok(partial.steps[0]?.urlBefore.endsWith("/start.html"));
    assert.equal(partial.steps[0]?.rationale, "test: continue");
    assert.ok(Array.isArray(partial.surfaceAdoption.attempts));
    assert.ok(Array.isArray(partial.recovery.attempts));
    assert.ok(Array.isArray(partial.alternativeExploration.candidates));
    assert.ok(Array.isArray(partial.reasoningDecisions));
    assert.ok(Array.isArray(partial.milestoneEvidence));
    assert.equal(partial.journeyMemory.guidanceUsed, false);

    const goBackTrace = context.actionTrace?.find((r) => r.actionType === "go_back");
    assert.ok(goBackTrace?.goBack);
    assert.equal(goBackTrace.goBack.source, "reasoning_decision");
    assert.equal(goBackTrace.goBack.dispatchedAs, "browser_history");
    assert.equal(goBackTrace.journeyMemory?.guidanceOffered, false);
    assert.ok(goBackTrace.before.activePageUrl.endsWith("/step2.html"));
    assert.ok(goBackTrace.after?.activePageUrl.endsWith("/start.html"));
    assert.equal(goBackTrace.after?.stepPageClosed, false);
    assert.deepEqual(context.lastAttemptedAction, { stepIndex: 1, actionType: "go_back", goBackSource: "reasoning_decision" });
  });
});

test("an engine-substituted go_back is tagged with its substitution source", async () => {
  await withFixtures(async (baseUrl, page) => {
    const task = buildTask(`${baseUrl}/start.html`);
    let caught: unknown;
    await runTask({ page, task, reasoning: scriptedProvider({ type: "stop_blocked" }) }).catch((e: unknown) => {
      caught = e;
    });
    const context = failureContextOf(caught);
    const goBackTrace = context.actionTrace?.find((r) => r.actionType === "go_back");
    assert.ok(goBackTrace?.goBack, "expected journey replanning to substitute a go_back for stop_blocked");
    assert.equal(goBackTrace.goBack.source, "journey_replanning");
    assert.equal(goBackTrace.goBack.substitutedFor, "stop_blocked");
  });
});

test("an engine page close is recorded as closedBy engine, any other close as external, and browser disconnect too", async () => {
  const browser = await chromium.launch();
  const main = await (await browser.newContext()).newPage();
  const log = new PageLifecycleLog();
  const detach = log.attach(main);
  try {
    const engineClosed = await main.context().newPage();
    const externallyClosed = await main.context().newPage();
    markEngineClose(engineClosed, "surface_return");
    await engineClosed.close();
    await externallyClosed.close();
    await browser.close();
    const events = log.getEvents();
    const engineId = log.pageId(engineClosed);
    const externalId = log.pageId(externallyClosed);
    assert.ok(events.some((e) => e.kind === "page_created" && e.pageId === engineId));
    const engineClose = events.find((e) => e.kind === "page_closed" && e.pageId === engineId);
    assert.equal(engineClose?.closedBy, "engine");
    assert.equal(engineClose?.closeReason, "surface_return");
    const externalClose = events.find((e) => e.kind === "page_closed" && e.pageId === externalId);
    assert.equal(externalClose?.closedBy, "external");
    assert.equal(externalClose?.closeReason, undefined);
    assert.ok(events.some((e) => e.kind === "browser_disconnected" && e.closedBy === "external"));
  } finally {
    detach();
    await browser.close().catch(() => {});
  }
});

test("returnToParentSurface's own close is recorded as an engine close, with the surface stack change", async () => {
  const browser = await chromium.launch();
  try {
    const main = await (await browser.newContext()).newPage();
    const state = new RunState();
    const detach = state.pageLifecycle.attach(main);
    const child = await main.context().newPage();
    state.pushSurface("adopted-1", child);
    await returnToParentSurface({ state, mainPage: main });
    detach();
    const events = state.pageLifecycle.getEvents();
    const childId = state.pageLifecycle.pageId(child);
    assert.ok(events.some((e) => e.kind === "surface_entered" && e.surfaceId === "adopted-1" && e.pageId === childId));
    assert.ok(events.some((e) => e.kind === "surface_left" && e.surfaceId === "adopted-1"));
    const close = events.find((e) => e.kind === "page_closed" && e.pageId === childId);
    assert.equal(close?.closedBy, "engine");
    assert.equal(close?.closeReason, "surface_return");
  } finally {
    await browser.close();
  }
});

test("failure currentUrl reads the active surface's page, not the original tab", async () => {
  await withFixtures(async (baseUrl, main) => {
    await main.goto(`${baseUrl}/start.html`);
    const state = new RunState();
    state.pageLifecycle.attach(main);
    const adopted = await main.context().newPage();
    await adopted.goto(`${baseUrl}/step2.html`);
    state.pushSurface("adopted-1", adopted);
    const context = buildEngineFailureContext({
      task: buildTask(`${baseUrl}/start.html`),
      state,
      mainPage: main,
      steps: [],
      reasoning: new MockReasoningProvider(),
    });
    assert.ok(context.currentUrl?.endsWith("/step2.html"));
    assert.ok(context.mainPageUrl?.endsWith("/start.html"));
    assert.equal(context.activeSurface, "adopted-1");
    assert.equal(context.activePageId, state.pageLifecycle.pageId(adopted));
    assert.equal(context.activePageClosed, false);
  });
});

test("lifecycle events, action trace and exported diagnostics are capped", () => {
  const log = new PageLifecycleLog();
  for (let i = 0; i < 150; i += 1) {
    log.record({ kind: "surface_entered", surfaceId: `s-${i}` });
  }
  const events = log.getEvents();
  assert.equal(events.length, MAX_PAGE_LIFECYCLE_EVENTS);
  assert.equal(events[0]?.surfaceId, "s-0");
  assert.equal(events[events.length - 1]?.surfaceId, "s-149");

  const snapshot = { at: "", activeSurface: "main", activePageId: "page-1", activePageUrl: "", activePageClosed: false, openPages: [] };
  for (let i = 0; i < 70; i += 1) {
    const record: ActionTraceRecord = { stepIndex: i, actionType: "wait", before: snapshot };
    log.recordAction(record);
  }
  assert.equal(log.getActionTrace().length, MAX_ACTION_TRACE_RECORDS);

  const state = new RunState();
  for (let i = 0; i < 80; i += 1) {
    state.surfaceAdoptionDiagnostics.push({ stepIndex: i, surfaceId: `adopted-${i}`, event: "adopted" });
  }
  const fakePage = { url: () => "http://127.0.0.1/x", isClosed: () => false } as unknown as Page;
  const context = buildEngineFailureContext({
    task: buildTask("http://127.0.0.1/start.html"),
    state,
    mainPage: fakePage,
    steps: [],
    reasoning: new MockReasoningProvider(),
  });
  assert.equal(context.partialDiagnostics?.surfaceAdoption.attempts.length, MAX_FAILURE_RECORDS);
});

async function runFailingTaskThroughRunner(baseUrl: string, runId: string, logFlag: string) {
  const previous = process.env.NAV_FAILURE_DIAGNOSTICS_LOG;
  process.env.NAV_FAILURE_DIAGNOSTICS_LOG = logFlag;
  const logged: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  };
  const realBrowser = await chromium.launch();
  const browser: RunnerBrowser = {
    async newPage() {
      const page = await realBrowser.newPage();
      // Fails inside runTask (after the page lifecycle log is attached), mimicking a run that
      // throws mid-journey.
      (page as Page).title = async () => {
        throw new Error("simulated page.title failure");
      };
      return page;
    },
    async close() {
      await realBrowser.close();
    },
  };
  try {
    const store = createInMemoryTaskStore(TIMING);
    const task = buildTask(`${baseUrl}/start.html`);
    await store.createRun(runId, task.taskId);
    await executeTaskAsync(runId, task, store, undefined, undefined, undefined, () => Promise.resolve(browser));
    return { record: await store.getRun(runId), logged };
  } finally {
    console.error = originalConsoleError;
    if (previous === undefined) delete process.env.NAV_FAILURE_DIAGNOSTICS_LOG;
    else process.env.NAV_FAILURE_DIAGNOSTICS_LOG = previous;
    await realBrowser.close().catch(() => {});
  }
}

function normalise(details: unknown): unknown {
  return JSON.parse(
    JSON.stringify(details, (key, value) => (key === "stack" || key === "at" || key === "latencyMs" ? undefined : value)),
  );
}

test("NAV_FAILURE_DIAGNOSTICS_LOG changes Render logs only; errorDetails is identical either way", async () => {
  const fixtures = await startStaticServer(fixturesDir);
  try {
    const off = await runFailingTaskThroughRunner(fixtures.baseUrl, "run_log_off", "0");
    const on = await runFailingTaskThroughRunner(fixtures.baseUrl, "run_log_on", "1");

    assert.equal(off.record?.status, "failed");
    assert.equal(on.record?.status, "failed");
    assert.equal(off.record?.error, "simulated page.title failure");
    assert.ok(off.record?.errorDetails?.pageLifecycle, "errorDetails always carries the lifecycle log");
    assert.ok(off.record?.errorDetails?.partialDiagnostics, "errorDetails always carries partial diagnostics");
    assert.deepEqual(normalise(on.record?.errorDetails), normalise(off.record?.errorDetails));

    assert.equal(off.logged.some((line) => line.includes("[timeline]")), false);
    const timeline = on.logged.filter((line) => line.includes("[timeline]"));
    assert.ok(timeline.length > 0);
    assert.ok(timeline.every((line) => line.includes("runId=run_log_on")));
    assert.ok(timeline[timeline.length - 1]?.includes("error=simulated page.title failure"));
    // The PR #110 summary line is present in both modes.
    assert.ok(off.logged.some((line) => line.includes('runId "run_log_off"')));
  } finally {
    await fixtures.close();
  }
});

test("a successful run's output carries none of the failure-only diagnostics", async () => {
  await withFixtures(async (baseUrl, page) => {
    const task = buildTask(`${baseUrl}/start.html`, {
      successCriteria: [
        { id: "reached_success_page", type: "url_pattern", description: "Success page", config: { pattern: "**success.html" } },
      ],
      captureModules: ["page_visits"],
    });
    const result = await runTask({ page, task });
    assert.equal(result.status, "success");
    const serialised = JSON.stringify(result);
    for (const field of ["pageLifecycle", "actionTrace", "goBackSource", "partialDiagnostics", "engineFailureContext", "stepPageClosed"]) {
      assert.equal(serialised.includes(field), false, `${field} must not appear in a successful response`);
    }
  });
});
