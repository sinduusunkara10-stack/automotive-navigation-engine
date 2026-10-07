import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { ACTION_TYPES } from "../../src/types/actions.js";
import { validateDecision } from "../../src/safety/index.js";
import type { TaskRequest, Limits } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Structural proof (not per-journey special-casing) that a Test Drive-style lead-capture
 * journey -- the second, non-configurator journey CLAUDE.md requires the same generic
 * mechanisms to handle unmodified -- can never result in personal-data entry, regardless
 * of what any reasoning provider (real or fake) proposes, UNLESS a task explicitly opts in
 * to both safety.allowFormSubmission and safety.allowPersonalDataEntry (Lead-form filling
 * Phase 1, see docs/architecture.md "Lead-form filling"). This is no longer a vocabulary-
 * level guarantee (fill_form is now the one action capable of writing a value into a form
 * field) -- it is enforced by src/safety/index.ts's validateDecision, which rejects any
 * fill_form decision unless both flags are true, exactly like allowedActions/domain
 * enforcement. Every other action/journey, and any task that omits or sets either flag
 * false, is unaffected: no code path can write a value into a form field for it.
 */

test("the engine's action vocabulary has exactly one action capable of entering data into a form field (fill_form)", () => {
  assert.deepEqual(
    [...ACTION_TYPES].sort(),
    ["capture", "click", "fill_form", "go_back", "navigate", "scroll", "stop_blocked", "stop_failure", "stop_success", "wait"].sort(),
    "the fixed action vocabulary (CLAUDE.md) has exactly the fill_form action able to fill/type/input, gated behind explicit opt-in",
  );
});

test("the safety layer rejects fill_form unless both allowFormSubmission and allowPersonalDataEntry are explicitly true", () => {
  const limits: Limits = { maxSteps: 10, maxBacktracks: 2 };
  const state = {
    limits: { stepCount: 1, backtrackCount: 0, startedAtMs: Date.now() },
    actionHistory: [],
    visitedUrls: ["https://example-fictional-oem.test/start.html"],
  };
  const cases: [boolean, boolean][] = [
    [false, false],
    [true, false],
    [false, true],
  ];
  for (const [allowFormSubmission, allowPersonalDataEntry] of cases) {
    const result = validateDecision({
      action: { type: "fill_form", target: "form-1" },
      safety: {
        allowedActions: ["fill_form", "stop_success", "stop_blocked", "stop_failure"],
        allowFormSubmission,
        allowPaymentOrPurchase: false,
        allowPersonalDataEntry,
      },
      limits,
      allowedDomains: ["example-fictional-oem.test"],
      state,
    });
    assert.equal(result.allowed, false, `allowFormSubmission=${allowFormSubmission} allowPersonalDataEntry=${allowPersonalDataEntry}`);
    assert.ok(result.flags.includes("lead_form_entry_not_allowed"));
  }

  const allowed = validateDecision({
    action: { type: "fill_form", target: "form-1" },
    safety: {
      allowedActions: ["fill_form", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: true,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: true,
    },
    limits,
    allowedDomains: ["example-fictional-oem.test"],
    state,
  });
  assert.equal(allowed.allowed, true);
  assert.ok(!allowed.flags.includes("lead_form_entry_not_allowed"));
});

/**
 * Always clicks the submit control if present; otherwise stops. Deliberately never fills
 * anything -- it can't (see the vocabulary assertion above). Matches by accessible name,
 * never the fixture's own HTML id -- the engine assigns its own opaque element ids.
 */
class ClickSubmitProvider implements ReasoningProvider {
  async decide(context: ReasoningContext): Promise<Decision> {
    const submit = context.observation.interactiveElements.find(
      (el) => el.visible !== false && /submit/i.test(el.accessibleName),
    );
    if (submit && context.allowedActions.includes("click")) {
      return { action: { type: "click", target: submit.id }, rationale: "Click the submit control." };
    }
    return { action: { type: "stop_failure" }, rationale: "Nothing left to do." };
  }
}

function baseTask(overrides: Partial<TaskRequest> & Pick<TaskRequest, "startUrl">): TaskRequest {
  return {
    schemaVersion: "1.38.0",
    taskId: "no-personal-data-entry-test-drive",
    objective:
      "Reach the test drive booking form. Do not enter any personal information -- only reaching the form matters.",
    journeyType: "test_drive",
    allowedDomains: ["127.0.0.1"],
    successCriteria: [],
    captureModules: ["cta_clicks", "errors"],
    limits: { maxSteps: 4, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "wait", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.40.0",
    ...overrides,
  };
}

test("reaching a Test Drive lead-capture form never results in any field being filled, even when the reasoning layer clicks the submit control", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    const task = baseTask({ startUrl: `${baseUrl}/lead-form.html` });

    await runTask({ page, task, reasoning: new ClickSubmitProvider() });

    // Read the live DOM directly -- not the engine's own captures -- so this proves the
    // absence of data entry independent of anything the engine itself chose to report.
    const values = await page.evaluate(() => ({
      fullName: (document.getElementById("full-name") as HTMLInputElement | null)?.value ?? "",
      email: (document.getElementById("email") as HTMLInputElement | null)?.value ?? "",
      phone: (document.getElementById("phone") as HTMLInputElement | null)?.value ?? "",
    }));

    assert.deepEqual(values, { fullName: "", email: "", phone: "" });
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
