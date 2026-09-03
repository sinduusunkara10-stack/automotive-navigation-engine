import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { buildObservation } from "../../src/observation/observationBuilder.js";

/**
 * Coverage for the generic observation-evidence widening (src/observation/
 * observationBuilder.ts): a broader interactive-element selector (tabs, options, radio/
 * checkbox-style controls, submit/button inputs), ARIA selection/toggle-state and disabled
 * flags, heading levels h1-h4, and generic progress-indicator text -- all read verbatim
 * from whatever markup the page itself uses, never a brand/site-specific selector. No
 * iframe/shadow-DOM traversal is added here (still document.querySelectorAll only) -- see
 * docs/architecture.md "Observation evidence" for why.
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

test("widened interactive selector picks up tab/option/radio/checkbox roles and submit/button inputs, not just anchors and buttons", async () => {
  const html = `<!doctype html><html><body>
    <div role="tab" aria-selected="true">Colour</div>
    <div role="option">Blue</div>
    <div role="radio" aria-checked="false">Petrol</div>
    <div role="checkbox" aria-checked="true">Extra warranty</div>
    <input type="submit" value="Continue" />
    <input type="button" value="Cancel" />
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const roles = observation.interactiveElements.map((el) => el.role).sort();
    assert.deepEqual(roles, ["checkbox", "input", "input", "option", "radio", "tab"]);
  });
});

test("visible ARIA selection/toggle-state attributes are surfaced verbatim on interactiveElements, never normalised", async () => {
  const html = `<!doctype html><html><body>
    <button role="tab" aria-selected="true" aria-current="step">Step 2</button>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const el = observation.interactiveElements.find((e) => e.accessibleName === "Step 2");
    assert.ok(el);
    assert.deepEqual(el?.ariaState, { "aria-selected": "true", "aria-current": "step" });
  });
});

test("a disabled control is flagged disabled but still offered as a candidate", async () => {
  const html = `<!doctype html><html><body>
    <button disabled>Continue</button>
    <button aria-disabled="true">Also disabled</button>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    assert.equal(observation.interactiveElements.length, 2);
    assert.ok(observation.interactiveElements.every((el) => el.disabled === true));
  });
});

test("an element with no ARIA state attributes and not disabled carries neither field at all", async () => {
  const html = `<!doctype html><html><body><button>Plain</button></body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const el = observation.interactiveElements[0];
    assert.ok(el);
    assert.equal(el.disabled, undefined);
    assert.equal(el.ariaState, undefined);
  });
});

test("notableText now includes h3/h4, not just h1/h2", async () => {
  const html = `<!doctype html><html><body>
    <h1>Configure Your Vehicle</h1>
    <h3>Trim Level</h3>
    <h4>Exterior Colour</h4>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    assert.deepEqual(observation.notableText, ["Configure Your Vehicle", "Trim Level", "Exterior Colour"]);
  });
});

test("generic progress-indicator text is surfaced when the page marks one up via role or ARIA progress attributes", async () => {
  const html = `<!doctype html><html><body>
    <div role="progressbar" aria-valuenow="2">Step 2 of 4</div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    assert.deepEqual(observation.progressIndicatorText, ["Step 2 of 4"]);
  });
});

test("progressIndicatorText is absent (not an empty array) when the page has no progress markup", async () => {
  const html = `<!doctype html><html><body><h1>Plain page</h1></body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    assert.equal(observation.progressIndicatorText, undefined);
  });
});
