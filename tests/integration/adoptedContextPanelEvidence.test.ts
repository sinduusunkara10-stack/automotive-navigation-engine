import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import type {
  SemanticCriterionVerifier,
  SemanticVerificationInput,
  SemanticVerificationOutcome,
} from "../../src/reasoning/semanticCriterionVerifier.js";

/**
 * Adopted-context panel-evidence fix (see CLAUDE.md and the Peugeot E-208 "Résumé panel"
 * investigation, 2026-11-20): regression coverage for the generic engine defect where a
 * drawer/panel opened *inside* an already-adopted browsing context (a configurator opened as
 * its own tab, not "main") could never be formalised as an in_document surface
 * (shouldEnterInDocumentSurface used to require `onMain`), so panel-scoped evidence
 * (causal linkage, scoped headings/interactiveText, documentUsable, relevance context) was
 * only ever available for the one step of the causing click itself, then permanently lost on
 * every later step. Every fixture here is synthetic HTML served from 127.0.0.1/localhost on
 * an ephemeral port, no brand/market/CTA text, per CLAUDE.md's non-negotiable design rule.
 *
 * Two hostnames resolving to the same local server ("127.0.0.1" and "localhost") give the
 * popup a genuinely different hostname string for deterministic surface-adoption purposes,
 * exactly like tests/integration/fullEnginePopupContinuation.test.ts's own convention --
 * /source.html below builds its own popup target from the incoming request's Host header.
 */

async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/source.html") {
      // Built from the incoming request's own Host header rather than a fixed string, so
      // this fixture server needs no second request/placeholder-substitution step -- the
      // popup target is simply the same host with "127.0.0.1" swapped for "localhost"
      // (crossHostBase's own transform), a genuinely different hostname for deterministic
      // surface-adoption purposes.
      const requestHost = req.headers.host ?? "";
      const configuratorUrl = `http://${requestHost.replace("127.0.0.1", "localhost")}/configurator.html`;
      return void page(
        "Source Page",
        '<button type="button" id="open-configurator">Open Configurator</button>' +
          "<script>" +
          "document.getElementById('open-configurator').addEventListener('click', function () {" +
          `  window.open(${JSON.stringify(configuratorUrl)}, '_blank');` +
          "});" +
          "</script>",
      );
    }

    if (path === "/configurator.html") {
      // The panel's own scoped content deliberately shares no vocabulary at all with the
      // criterion description below (standing in for a different-language panel, e.g.
      // French "Résumé"/"Continuez" against an English criterion) -- a deterministic
      // lexical score can only ever classify it reject/ambiguous. The trigger sits apart
      // from the panel so the click itself always succeeds outright.
      return void page(
        "Configurator Page",
        '<button type="button" id="resume-trigger" style="position:absolute;top:0;left:0;">Zzyx Qvor</button>' +
          "<script>" +
          "document.getElementById('resume-trigger').addEventListener('click', function () {" +
          "  var d = document.createElement('div');" +
          "  d.id = 'resume-panel';" +
          "  d.style.cssText = 'position:fixed;top:0;right:0;height:100%;width:40%;background:#fff;';" +
          "  d.innerHTML = '<h2>Fwoop Nexil</h2><h3>Drenz 48219</h3>' +" +
          "    '<button type=\"button\">Blorvak</button>';" +
          "  document.body.appendChild(d);" +
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

const OBJECTIVE = "Complete the item configuration journey.";
const PANEL_MILESTONE_DESCRIPTION = "The summary side panel is open and shows the configured item and its total price.";

function buildTask(params: { startUrl: string }): TaskRequest {
  return {
    schemaVersion: "1.51.0",
    taskId: "adopted-context-panel-evidence",
    objective: OBJECTIVE,
    startUrl: params.startUrl,
    allowedDomains: ["127.0.0.1", "localhost"],
    successCriteria: [
      { id: "panel_visible", type: "semantic_page_match", description: PANEL_MILESTONE_DESCRIPTION, required: true },
    ],
    captureModules: ["errors", "cta_clicks"],
    limits: { maxSteps: 8, maxBacktracks: 1, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "go_back", "stop_success", "stop_blocked", "stop_failure"],
      allowSurfaceAdoption: true,
      surfaceAdoptionDomainPolicy: "require_allowed_domain",
    },
    outputSchemaVersion: "1.53.0",
  };
}

/**
 * Returns satisfied=false the FIRST time it is asked about the panel criterion (even with
 * good causallyLinked/documentUsable evidence), and satisfied=true on every later call --
 * so the milestone can only complete if panel evidence is still available on a step *after*
 * the one that opened the panel. Before the adopted-context fix, that second call would have
 * carried no panelEvidence at all (undefined), so this double-checks persistence (requirement
 * B), not just same-step availability (which already worked). It also never confirms the
 * criterion on causallyLinked/documentUsable being merely absent -- the fixed F false-positive
 * requirement -- by only ever returning true once real, usable, causally-linked panel
 * evidence is present at all.
 */
function persistenceProvingVerifier(): SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } {
  const calls: SemanticVerificationInput[] = [];
  let causallyLinkedCallCount = 0;
  return {
    calls,
    async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
      calls.push(input);
      const p = input.panelEvidence;
      if (!p || !p.causallyLinked || !p.documentUsable) {
        return { satisfied: false, confidence: 0.1, evidence: "No causally-linked, usable panel evidence yet." };
      }
      causallyLinkedCallCount += 1;
      if (causallyLinkedCallCount === 1) {
        return { satisfied: false, confidence: 0.2, evidence: "Deliberately not confirming on the first causally-linked call." };
      }
      // Judged by MEANING, exactly as a real cross-language-aware verifier would, never
      // gated on relevanceTier's own same-language lexical score (which here is reject/
      // ambiguous by construction -- see the fixture's deliberately foreign-looking panel
      // vocabulary).
      return {
        satisfied: true,
        confidence: 0.9,
        evidence: `Causally-linked, usable panel "${p.identity}" still present on a later step (relevanceTier: ${p.relevanceTier}).`,
      };
    },
  };
}

/** Opens the configurator (adopted as a new tab), clicks the in-page summary trigger inside it, waits one step, then stops. */
class OpenConfiguratorThenResumeProvider implements ReasoningProvider {
  private step = 0;

  async decide(context: ReasoningContext): Promise<Decision> {
    this.step += 1;
    if (this.step === 1) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Open Configurator");
      assert.ok(trigger, "expected the configurator-opening trigger on the source page");
      return { action: { type: "click", target: trigger!.id }, rationale: "Open the configurator." };
    }
    if (this.step === 2) {
      const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Zzyx Qvor");
      assert.ok(trigger, "expected the summary-panel trigger inside the adopted configurator tab");
      return { action: { type: "click", target: trigger!.id }, rationale: "Open the summary panel." };
    }
    if (this.step === 3) {
      // A neutral, no-op step -- forces the next evaluateSuccessCriteria call for the panel
      // milestone to happen on a step *after* the one that opened the panel, exactly the
      // case the adopted-context fix is about.
      return { action: { type: "wait" }, rationale: "Let the panel settle." };
    }
    return { action: { type: "stop_success" }, rationale: "Objective reached." };
  }
}

test("adopted-context panel-evidence fix: a panel opened inside an already-adopted tab keeps causally-linked, usable panel evidence available on a later step, not just the click's own step", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/source.html` });
    const verifier = persistenceProvingVerifier();
    const provider = new OpenConfiguratorThenResumeProvider();

    const response = await runTask({ page, task, reasoning: provider, semanticVerifier: verifier });

    assert.equal(response.status, "success", "the panel milestone must complete once panel evidence is judged on a later step");
    assert.deepEqual(response.diagnostics.missingRequiredCriteriaIds ?? [], []);

    const panelMilestone = response.diagnostics?.milestoneEvidence?.find((m) => m.criterionId === "panel_visible");
    assert.ok(panelMilestone, "expected the panel milestone to have satisfying evidence recorded");
    assert.equal(panelMilestone!.evidenceSource, "semantic_page_match:verifier");

    // Proves the fix: at least two distinct calls carried causally-linked, usable panel
    // evidence -- one from the click's own step (pre-existing behaviour) and at least one
    // from a later step (the gap this PR closes). Before the fix, every call after the
    // click's own step would have panelEvidence === undefined.
    const causallyLinkedCalls = verifier.calls.filter((c) => c.panelEvidence?.causallyLinked === true && c.panelEvidence?.documentUsable === true);
    assert.ok(
      causallyLinkedCalls.length >= 2,
      `expected causally-linked panel evidence on at least two separate calls (one later than the opening step), got ${causallyLinkedCalls.length}`,
    );

    // False-positive protection (requirement F): the verifier was never asked to confirm
    // from lastActionEvidence/a bare click alone -- every satisfying call it made still
    // carried real panelEvidence.
    const satisfyingCall = verifier.calls.find((c) => c === causallyLinkedCalls[causallyLinkedCalls.length - 1]);
    assert.ok(satisfyingCall?.panelEvidence, "the satisfying call must still carry real panel evidence, never a bare click alone");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("adopted-context panel-evidence fix: an unrelated click/tag with no panel opening never satisfies the panel milestone, even across several steps", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser: Browser = await chromium.launch();
  const page: Page = await browser.newPage();

  try {
    const task = buildTask({ startUrl: `${baseUrl}/source.html` });
    const verifier: SemanticCriterionVerifier & { calls: SemanticVerificationInput[] } = (() => {
      const calls: SemanticVerificationInput[] = [];
      return {
        calls,
        async verify(input: SemanticVerificationInput): Promise<SemanticVerificationOutcome> {
          calls.push(input);
          // A real verifier would also never confirm here -- there is no panel evidence at
          // all for this run (the trigger is never clicked), so this fake simply mirrors a
          // correctly-fail-closed real model.
          return { satisfied: false, confidence: 0.1, evidence: "No panel evidence present." };
        },
      };
    })();

    class OpenConfiguratorOnlyProvider implements ReasoningProvider {
      private step = 0;
      async decide(context: ReasoningContext): Promise<Decision> {
        this.step += 1;
        if (this.step === 1) {
          const trigger = context.observation.interactiveElements.find((el) => el.accessibleName === "Open Configurator");
          assert.ok(trigger);
          return { action: { type: "click", target: trigger!.id }, rationale: "Open the configurator." };
        }
        if (this.step <= 4) {
          return { action: { type: "wait" }, rationale: "Waiting, never opening the summary panel." };
        }
        return { action: { type: "stop_failure" }, rationale: "Never reached the required panel." };
      }
    }

    const response = await runTask({ page, task, reasoning: new OpenConfiguratorOnlyProvider(), semanticVerifier: verifier });

    assert.notEqual(response.status, "success");
    assert.ok(
      (response.diagnostics.missingRequiredCriteriaIds ?? []).includes("panel_visible"),
      "the panel milestone must stay unsatisfied when no panel was ever opened, regardless of how many steps pass",
    );
    assert.ok(
      verifier.calls.every((c) => c.panelEvidence === undefined),
      "no call should ever have carried panel evidence for a run that never opened the panel",
    );
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
