import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import {
  attemptCheckpointReconstruction,
  matchesDecisionPoint,
  reobserveForBranchReturn,
} from "../../src/core/branchReturnRecovery.js";
import { captureDecisionPointCheckpoint } from "../../src/core/decisionPointCheckpoint.js";
import { computeDecisionPointFingerprint } from "../../src/core/routeMemory.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import type { Captures } from "../../src/types/task-response.js";

/**
 * Direct, unit-level coverage of src/core/branchReturnRecovery.ts (Task 1/Task 2, production
 * incident run_fae0519a-ef71-46b9-a053-4ca82bb30000) against a real Chromium/Playwright page
 * and a purely synthetic local fixture -- no brand/market/CTA-specific wording anywhere, per
 * CLAUDE.md's non-negotiable design rule. See tests/integration/branchExploration.test.ts
 * (Wing 2) and tests/integration/milestoneAnchoredRecovery.test.ts for the corresponding
 * full-engine (runTask()) coverage of the same fix.
 */

function emptyCaptures(): Captures {
  return {};
}

async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/hub.html") {
      // A relevant control sits far below the fold; an unrelated, purely-decorative control
      // is immediately visible. Neither label shares vocabulary with the other, so any
      // position-only bias (rather than the existing semantic-matching machinery) would be
      // exposed by these tests.
      return void page(
        "Recovery hub",
        '<h2>Choose a next step</h2>' +
          '<a href="/decoy.html">Unrelated seasonal notice</a>' +
          '<div style="height:2200px"></div>' +
          '<a href="/target.html">Continue the reachable objective</a>',
      );
    }
    if (path === "/hub-hydrating.html") {
      // Simulates a slow-hydrating region: the real control only appears after a short
      // client-side delay, standing in for the "stale/hydrating candidate" case -- a fresh
      // buildObservation() call after the bounded settle must see it, never a stale/replayed
      // element captured before it existed.
      return void page(
        "Recovery hub",
        '<h2>Choose a next step</h2>' +
          '<div id="slot"></div>' +
          "<script>setTimeout(() => { document.getElementById('slot').innerHTML = " +
          "'<a href=\"/target.html\">Continue the reachable objective</a>'; }, 150);</script>",
      );
    }
    if (path === "/unrelated.html") {
      return void page("Something else entirely", "<p>No shared vocabulary with the hub at all.</p>");
    }
    if (path === "/target.html" || path === "/decoy.html") {
      return void page("Downstream page", "<p>Reached.</p>");
    }
    res.writeHead(404).end();
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

const withActiveSurface = (o: Awaited<ReturnType<typeof buildObservation>>) => o;

test("matchesDecisionPoint: an exact fingerprint match verifies immediately, basis 'fingerprint'", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const observation = await buildObservation(page);
    const fingerprint = computeDecisionPointFingerprint(observation);
    const result = matchesDecisionPoint(observation, fingerprint, undefined);
    assert.equal(result.verified, true);
    assert.equal(result.matchBasis, "fingerprint");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("matchesDecisionPoint: a checkpoint alone (no live page match) never verifies a milestone -- a genuinely different, unrelated page is rejected", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const originObservation = await buildObservation(page);
    const decisionPointId = computeDecisionPointFingerprint(originObservation);
    const checkpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: originObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: ["reach the intended downstream objective page"],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });

    await page.goto(`${baseUrl}/unrelated.html`);
    const unrelatedObservation = await buildObservation(page);
    const result = matchesDecisionPoint(unrelatedObservation, decisionPointId, checkpoint);
    assert.equal(result.verified, false, "the checkpoint's own recorded vocabulary must never be satisfied by an unrelated page");
    assert.equal(result.matchBasis, "none");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("matchesDecisionPoint: a checkpoint with too little discriminating vocabulary (short title only, no semantic milestones) never semantically verifies -- guards against a short title being a trivial substring of an unrelated page's own longer title", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const originObservation = await buildObservation(page);
    const decisionPointId = computeDecisionPointFingerprint(originObservation);
    // No remainingMilestoneConcepts at all -- the exact shape a task with only
    // url_pattern/non-semantic success criteria produces.
    const thinCheckpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: originObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: [],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });

    await page.goto(`${baseUrl}/unrelated.html`);
    const unrelatedObservation = await buildObservation(page);
    const result = matchesDecisionPoint(unrelatedObservation, decisionPointId, thinCheckpoint);
    assert.equal(result.verified, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("reobserveForBranchReturn: bounded scroll discovers a relevant control that starts outside the initial viewport, without ever selecting the unrelated-but-visible one merely for its position", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const originObservation = await buildObservation(page);
    const decisionPointId = computeDecisionPointFingerprint(originObservation);
    const checkpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: originObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: ["choose a next step toward the reachable objective"],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });

    // Navigate away and back, so the live page is fresh (never a stale/replayed handle) and
    // the initial viewport genuinely does not contain the far-below-the-fold control.
    await page.goto(`${baseUrl}/decoy.html`);
    await page.goto(`${baseUrl}/hub.html`);

    const result = await reobserveForBranchReturn({
      page,
      withActiveSurface,
      decisionPointFingerprint: decisionPointId,
      checkpoint,
    });

    assert.equal(result.verified, true, "the fresh page is genuinely the same decision point and must verify");
    const names = result.observation.interactiveElements.map((el) => el.accessibleName);
    assert.ok(
      names.includes("Continue the reachable objective") && names.includes("Unrelated seasonal notice"),
      "the returned observation must reflect the full live page (both controls), not a partial/cached one",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("reobserveForBranchReturn: a slow-hydrating control is re-observed live, never replayed from a stale pre-hydration snapshot", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub-hydrating.html`);
    // Read the observation immediately, before the client-side hydration timer fires --
    // this is the "stale" snapshot a naive implementation might otherwise reuse.
    const staleObservation = await buildObservation(page);
    assert.ok(
      !staleObservation.interactiveElements.some((el) => el.accessibleName === "Continue the reachable objective"),
      "sanity check: the control genuinely does not exist yet at this instant",
    );

    const decisionPointId = computeDecisionPointFingerprint(staleObservation);
    const checkpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: staleObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: ["choose a next step toward the reachable objective"],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });

    await page.waitForTimeout(300);
    const result = await reobserveForBranchReturn({
      page,
      withActiveSurface,
      decisionPointFingerprint: decisionPointId,
      checkpoint,
    });
    assert.ok(
      result.observation.interactiveElements.some((el) => el.accessibleName === "Continue the reachable objective"),
      "the post-hydration control must be present in the freshly re-observed live page",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("attemptCheckpointReconstruction: navigates to the checkpoint's own sanitized URL and verifies restoration via live re-observation", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const originObservation = await buildObservation(page);
    const decisionPointId = computeDecisionPointFingerprint(originObservation);
    const checkpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: originObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: ["choose a next step toward the reachable objective"],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });
    // sanitizePageIdentity's own registrableDomain deliberately never carries a port (real
    // sites this engine targets never need one) -- this local, ephemeral-port fixture server
    // does, so the port is restored here purely to make reconstruction's own navigation
    // mechanics reach this test's actual server; reconstruction itself does nothing
    // port-specific, it only concatenates whatever registrableDomain the checkpoint carries.
    checkpoint.sanitizedUrl = { ...checkpoint.sanitizedUrl, registrableDomain: new URL(baseUrl).host };

    await page.goto(`${baseUrl}/unrelated.html`);
    const alreadyAttempted = new Set<string>();
    const result = await attemptCheckpointReconstruction({
      page,
      withActiveSurface,
      checkpoint,
      decisionPointFingerprint: decisionPointId,
      allowedDomains: [new URL(baseUrl).hostname],
      actionNavigationTimeoutMs: 5000,
      captures: emptyCaptures(),
      captureModules: [],
      stepIndex: 5,
      alreadyAttemptedFingerprints: alreadyAttempted,
    });

    assert.equal(result.attempted, true);
    assert.equal(result.used, true);
    assert.equal(result.outcome, "verified");
    assert.equal(result.finalLiveVerificationOutcome, "restored");
    assert.ok(alreadyAttempted.has(checkpoint.fingerprint));
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("attemptCheckpointReconstruction: the fingerprint guard prevents a second reconstruction to the same checkpoint within one run", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/hub.html`);
    const originObservation = await buildObservation(page);
    const decisionPointId = computeDecisionPointFingerprint(originObservation);
    const checkpoint = captureDecisionPointCheckpoint({
      branchId: "branch-1",
      stepIndex: 0,
      observation: originObservation,
      activeSurfaceIdentity: "main",
      activeMilestoneIds: [],
      remainingMilestoneConcepts: ["choose a next step toward the reachable objective"],
      candidatesAlreadyAttempted: [],
      routeDepth: 0,
    });

    const alreadyAttempted = new Set<string>([checkpoint.fingerprint]);
    const result = await attemptCheckpointReconstruction({
      page,
      withActiveSurface,
      checkpoint,
      decisionPointFingerprint: decisionPointId,
      allowedDomains: [new URL(baseUrl).hostname],
      actionNavigationTimeoutMs: 5000,
      captures: emptyCaptures(),
      captureModules: [],
      stepIndex: 5,
      alreadyAttemptedFingerprints: alreadyAttempted,
    });

    assert.equal(result.attempted, false, "a checkpoint already reconstructed once this run must never be reconstructed again");
    assert.equal(result.outcome, "skipped_fingerprint_guard");
    assert.equal(result.finalLiveVerificationOutcome, "restore_failed");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("attemptCheckpointReconstruction: with no checkpoint at all, it is skipped rather than attempted, and never itself claims verification", () => {
  return (async () => {
    const alreadyAttempted = new Set<string>();
    const browser = await chromium.launch();
    const page = await browser.newPage();
    try {
      const result = await attemptCheckpointReconstruction({
        page,
        withActiveSurface,
        checkpoint: undefined,
        decisionPointFingerprint: "{}",
        allowedDomains: ["example.test"],
        actionNavigationTimeoutMs: 5000,
        captures: emptyCaptures(),
        captureModules: [],
        stepIndex: 0,
        alreadyAttemptedFingerprints: alreadyAttempted,
      });
      assert.equal(result.attempted, false);
      assert.equal(result.used, false);
      assert.equal(result.outcome, "skipped_no_checkpoint");
      assert.equal(result.finalLiveVerificationOutcome, "restore_failed");
    } finally {
      await page.close();
      await browser.close();
    }
  })();
});
