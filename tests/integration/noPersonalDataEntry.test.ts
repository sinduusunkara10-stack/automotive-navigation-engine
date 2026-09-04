import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { runTask } from "../../src/core/engine.js";
import { ACTION_TYPES } from "../../src/types/actions.js";
import type { TaskRequest } from "../../src/types/task-request.js";
import type { Decision, ReasoningContext, ReasoningProvider } from "../../src/reasoning/reasoningProvider.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

/**
 * Structural proof (not per-journey special-casing) that a Test Drive-style lead-capture
 * journey -- the second, non-configurator journey CLAUDE.md requires the same generic
 * mechanisms to handle unmodified -- can never result in personal-data entry, regardless
 * of what any reasoning provider (real or fake) proposes. This is not a runtime guardrail
 * that could have a gap: the engine's entire action vocabulary (src/types/actions.ts) has
 * no action capable of typing/filling a value into any element at all, so no code path
 * anywhere in this engine can write a value into a form field.
 */

test("the engine's action vocabulary contains no action capable of entering data into a form field", () => {
  assert.deepEqual(
    [...ACTION_TYPES].sort(),
    ["capture", "click", "go_back", "navigate", "scroll", "stop_blocked", "stop_failure", "stop_success", "wait"].sort(),
    "the fixed action vocabulary (CLAUDE.md) has no fill/type/input action of any kind",
  );
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
    schemaVersion: "1.7.0",
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
    outputSchemaVersion: "1.6.0",
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
