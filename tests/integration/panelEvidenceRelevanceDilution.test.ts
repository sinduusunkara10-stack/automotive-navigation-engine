import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { gatherPanelEvidence } from "../../src/core/panelEvidence.js";
import { RELEVANCE_ADOPT_THRESHOLD } from "../../src/core/surfaceRelevance.js";

/**
 * Surface-adoption corrective work, round 2 (mirrors tests/integration/surfaceRelevance.test.ts's
 * own dilution regression, applied to core/panelEvidence.ts's twin code path for in-document
 * panels/drawers, per the confirmed same defect flagged as out-of-scope in PR #71 and now
 * fixed here): a panel that genuinely answers one later milestone must not be diluted below
 * the adopt threshold by vocabulary from earlier, unrelated milestones it doesn't also
 * restate.
 */

const OBJECTIVE = "Complete the vehicle finance application for the configured vehicle model.";
const UNRELATED_EARLIER_MILESTONES = [
  "Start from the product overview page and select a model to view.",
  "Click configure to open the configuration funnel for the selected model.",
  "Click continue to advance the configuration to the next step.",
];

const PANEL_HTML = `
<!doctype html>
<html><body style="margin:0">
  <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:#fff;">
    <h2>Vehicle Finance Application</h2>
    <button>Start Finance Application</button>
  </div>
</body></html>
`;

test("a causally-linked panel matching only one of several unrelated milestone descriptions is scored by its best-matching anchor, not diluted by the others", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(PANEL_HTML);

    const blendedEvidence = await gatherPanelEvidence(page, { kind: "in_document" }, [
      [...UNRELATED_EARLIER_MILESTONES, OBJECTIVE].join(" "),
    ]);
    assert.ok(
      blendedEvidence && blendedEvidence.relevance.score < RELEVANCE_ADOPT_THRESHOLD,
      `expected the old blended-anchor approach to score below adopt, got ${blendedEvidence?.relevance.score}`,
    );

    const evidence = await gatherPanelEvidence(page, { kind: "in_document" }, [...UNRELATED_EARLIER_MILESTONES, OBJECTIVE]);
    assert.ok(evidence?.containerFound);
    assert.equal(evidence.relevance.tier, "adopt");
    assert.ok(
      evidence.relevance.score >= RELEVANCE_ADOPT_THRESHOLD,
      `expected score >= adopt threshold, got ${evidence.relevance.score}`,
    );
  } finally {
    await page.close();
    await browser.close();
  }
});

test("a panel that is genuinely unrelated to every milestone still rejects (the fix does not make the gate more permissive)", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <!doctype html>
      <html><body style="margin:0">
        <div style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:#fff;">
          <h2>Customer Satisfaction Survey</h2>
          <button>Start Survey</button>
        </div>
      </body></html>
    `);

    const evidence = await gatherPanelEvidence(page, { kind: "in_document" }, [
      "Open the vehicle configurator and select a trim option.",
      "Advance the configuration to the next funnel screen.",
      OBJECTIVE,
    ]);
    assert.ok(evidence?.containerFound);
    assert.equal(evidence.relevance.tier, "reject");
  } finally {
    await page.close();
    await browser.close();
  }
});
