import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { readElementState, elementLocatorSelector } from "../../src/observation/observationBuilder.js";

/**
 * Coverage for ElementState.coveredBySignature (src/observation/observationBuilder.ts):
 * a compact, generic fingerprint of whatever element is intercepting a target's hit-test
 * point, built purely from the intercepting element's own tag/role/trimmed text -- no
 * brand/site-specific selector, no CMP/vendor attribute. Backs core/loop.ts's blocker-
 * persistence tracking (RunState.lastBlockerSignature).
 */

async function withPage<T>(html: string, run: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(html);
    return await run(page);
  } finally {
    await page.close();
    await browser.close();
  }
}

// Mirrors observationBuilder.ts's own tagging convention closely enough for a direct
// readElementState call in isolation from a full buildObservation scan.
function tag(id: string): string {
  return ` data-nav-engine-id="${id}"`;
}

test("a covered element reports a non-empty coveredBySignature; an uncovered one reports none", async () => {
  const html = `<!doctype html><html><body>
    <button id="covered"${tag("covered")} style="position:absolute;top:10px;left:10px;width:100px;height:30px;">Covered target</button>
    <div style="position:absolute;top:10px;left:10px;width:100px;height:30px;z-index:10;" role="status">Overlay text</div>
    <button id="uncovered"${tag("uncovered")} style="position:absolute;top:200px;left:10px;width:100px;height:30px;">Uncovered target</button>
  </body></html>`;
  await withPage(html, async (page) => {
    const covered = await readElementState(page, "covered");
    assert.equal(covered.covered, true);
    assert.ok(covered.coveredBySignature && covered.coveredBySignature.length > 0);
    assert.match(covered.coveredBySignature, /^div\|status\|/);

    const uncovered = await readElementState(page, "uncovered");
    assert.equal(uncovered.covered, false);
    assert.equal(uncovered.coveredBySignature, undefined);
  });
});

test("the same unchanged overlay produces the identical signature across two separate reads", async () => {
  const html = `<!doctype html><html><body>
    <button id="target"${tag("target")} style="position:absolute;top:10px;left:10px;width:100px;height:30px;">Target</button>
    <div style="position:absolute;top:10px;left:10px;width:100px;height:30px;z-index:10;" role="status">Stable overlay</div>
  </body></html>`;
  await withPage(html, async (page) => {
    const first = await readElementState(page, "target");
    const second = await readElementState(page, "target");
    assert.equal(first.covered, true);
    assert.equal(second.covered, true);
    assert.equal(first.coveredBySignature, second.coveredBySignature);
  });
});

test("a different intercepting element (changed role/text) produces a different signature", async () => {
  const html = `<!doctype html><html><body>
    <button id="target"${tag("target")} style="position:absolute;top:10px;left:10px;width:100px;height:30px;">Target</button>
    <div id="overlay" style="position:absolute;top:10px;left:10px;width:100px;height:30px;z-index:10;" role="status">First overlay</div>
  </body></html>`;
  await withPage(html, async (page) => {
    const first = await readElementState(page, "target");
    await page.evaluate(() => {
      const overlay = document.getElementById("overlay")!;
      overlay.setAttribute("role", "alert");
      overlay.textContent = "A completely different overlay";
    });
    const second = await readElementState(page, "target");
    assert.equal(first.covered, true);
    assert.equal(second.covered, true);
    assert.notEqual(first.coveredBySignature, second.coveredBySignature);
  });
});

test("elementLocatorSelector remains the sole selector mechanism (no coveredBySignature leakage into it)", () => {
  assert.equal(elementLocatorSelector("x"), '[data-nav-engine-id="x"]');
});
