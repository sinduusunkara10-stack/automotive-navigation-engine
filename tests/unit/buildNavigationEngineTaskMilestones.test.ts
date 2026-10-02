import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSuccessCriteriaFromObjective,
  groupAlternativeMilestones,
} from "../../n8n/buildNavigationEngineTaskMilestones.js";

/**
 * Regression coverage for run_9f535d17-24a7-4b21-aacd-9a5f4fa0e933 (Peugeot, schemaVersion
 * 1.32.0): the n8n task-builder's naive line-per-milestone split turned a single "either A, or
 * B" alternative into two independently-required successCriteria, which the engine can never
 * satisfy together -- guaranteeing no_progress_required_criteria_unmet regardless of what the
 * run actually did. The engine's own successCriterion.group mechanism (unchanged, see
 * src/core/successEvaluator.ts) already solves this; the bug was the task-builder never using
 * it.
 */

const PEUGEOT_OBJECTIVE = [
  "Start on the above start URL.",
  "Capture analytics tags for the start page.",
  'Locate the "Configurez et commandez" CTAs shown beneath the vehicle cards.',
  'Click "Configurez et commandez" under either:',
  "E‑208 (preferred), or",
  "E‑2008 (fallback if E‑208 is unavailable).",
  "After reaching the configurator page, click Résumé.",
  "Reach the summary page/dialog.",
  "Stop and return.",
].join("\n");

test("TEST1: groups the E-208/E-2008 alternative under a shared group, leaving every other line ungrouped", () => {
  const criteria = buildSuccessCriteriaFromObjective(PEUGEOT_OBJECTIVE, "");

  assert.equal(criteria.length, 9, "every objective line still becomes one criterion -- no lines dropped or merged");

  const byDescription = new Map(criteria.map((c) => [c.description, c]));
  const e208 = byDescription.get("E‑208 (preferred), or");
  const e2008 = byDescription.get("E‑2008 (fallback if E‑208 is unavailable).");

  assert.ok(e208?.group, "E-208 alternative must be grouped");
  assert.ok(e2008?.group, "E-2008 alternative must be grouped");
  assert.equal(e208?.group, e2008?.group, "both alternatives must share the same group id");

  for (const c of criteria) {
    if (c.description === e208?.description || c.description === e2008?.description) {
      continue;
    }
    assert.equal(c.group, undefined, `non-alternative line "${c.description}" must stay ungrouped`);
  }

  // Every criterion, grouped or not, is still individually `required: true` -- group-level
  // required-ness is computed by the engine (groupCriteria), not the task-builder.
  assert.ok(criteria.every((c) => c.required === true));
});

test("TEST2: a plain ordered objective with no alternation is completely unaffected", () => {
  const objective = ["Open the homepage.", "Click the pricing link.", "Reach the pricing page."].join("\n");
  const criteria = buildSuccessCriteriaFromObjective(objective, "");

  assert.equal(criteria.length, 3);
  assert.ok(criteria.every((c) => c.group === undefined), "no line ends in a trailing 'or' -- nothing should be grouped");
  assert.deepEqual(
    criteria.map((c) => c.description),
    ["Open the homepage.", "Click the pricing link.", "Reach the pricing page."],
  );
});

test("TEST3: a three-way alternative chains every member into one group", () => {
  const result = groupAlternativeMilestones(["Pick a color:", "Red, or", "Green, or", "Blue."]);

  assert.equal(result[0]?.group, undefined, "the lead-in line itself is not part of the alternation");
  const group = result[1]?.group;
  assert.ok(group);
  assert.equal(result[2]?.group, group);
  assert.equal(result[3]?.group, group);
});

test("TEST4: a trailing 'or' on the very last line (no following alternative) is left ungrouped", () => {
  const result = groupAlternativeMilestones(["Do the thing, or"]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.group, undefined);
});
