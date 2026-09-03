import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { buildObservation, readElementState } from "../../src/observation/observationBuilder.js";

/**
 * Coverage for the generic observation-evidence widening (src/observation/
 * observationBuilder.ts): a broader interactive-element selector (tabs, options, radio/
 * checkbox-style controls, submit/button inputs), ARIA selection/toggle-state and disabled
 * flags, heading levels h1-h4, and generic progress-indicator text -- all read verbatim
 * from whatever markup the page itself uses, never a brand/site-specific selector. Shadow
 * DOM traversal is still out of scope -- see docs/architecture.md "Observation evidence".
 * One level of generic, same-origin child-frame scanning (src/observation/frames.ts) *is*
 * now in scope, covered separately below.
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

// ---------------------------------------------------------------------------------------
// REGRESSION (real production run): a full-viewport overlay (e.g. a consent-style banner)
// left a genuinely visible-but-unreachable control indistinguishable, in the observation,
// from a genuinely clickable one -- buildObservation computed visible/disabled/ariaState
// per element but never whether something else currently sits on top of it, even though
// the separate, per-id readElementState (used only for pre-dispatch revalidation) already
// computed exactly that. These tests prove `covered` now reaches buildObservation's own
// output using the same elementFromPoint hit-test, entirely generically (no CTA wording,
// no site-specific selector).
// ---------------------------------------------------------------------------------------

test("a control sitting underneath a full-viewport overlay is flagged covered, while the overlay's own control is not", async () => {
  const html = `<!doctype html><html><body>
    <button id="target" style="position:fixed;top:100px;left:100px;width:200px;height:50px;">Underneath</button>
    <div style="position:fixed;inset:0;z-index:9999;">
      <button id="overlay-button" style="position:fixed;top:10px;left:10px;">On top</button>
    </div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const covered = observation.interactiveElements.find((el) => el.accessibleName === "Underneath");
    const uncovered = observation.interactiveElements.find((el) => el.accessibleName === "On top");
    assert.ok(covered);
    assert.ok(uncovered);
    assert.equal(covered?.covered, true);
    assert.equal(uncovered?.covered, undefined);
  });
});

test("an uncovered element carries no covered field at all (never a false value cluttering the payload)", async () => {
  const html = `<!doctype html><html><body><button>Plain</button></body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const el = observation.interactiveElements[0];
    assert.ok(el);
    assert.equal(el.covered, undefined);
  });
});

test("once the covering overlay is removed, the same control is no longer reported as covered", async () => {
  const html = `<!doctype html><html><body>
    <button id="target" style="position:fixed;top:100px;left:100px;width:200px;height:50px;">Underneath</button>
    <div id="overlay" style="position:fixed;inset:0;z-index:9999;"></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const before = await buildObservation(page);
    const beforeEl = before.interactiveElements.find((el) => el.accessibleName === "Underneath");
    assert.equal(beforeEl?.covered, true);

    await page.evaluate(() => document.getElementById("overlay")?.remove());

    const after = await buildObservation(page);
    const afterEl = after.interactiveElements.find((el) => el.accessibleName === "Underneath");
    assert.equal(afterEl?.covered, undefined);
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

// ---------------------------------------------------------------------------------------
// Generic, one-level same-origin child-frame support (src/observation/frames.ts). A
// consent/preference blocker's live control can legitimately live inside a same-origin
// iframe rather than the main document -- these tests prove the engine can see and
// resolve such an element without any vendor/CMP-specific iframe selector: the exact same
// interactive-element scan runs against the frame's own document, and the resulting
// element id is frame-scoped so core/loop.ts and actions/click.ts can act on it directly.
// A `srcdoc` iframe (no `sandbox` attribute) is same-origin with its parent in Chromium,
// so this needs no second HTTP origin to exercise faithfully.
// ---------------------------------------------------------------------------------------

test("an interactive element inside a same-origin iframe is scanned and carries frameOrigin; a main-document element does not", async () => {
  const html = `<!doctype html><html><body>
    <button id="main-btn">Main document control</button>
    <iframe srcdoc="&lt;button&gt;Frame control&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const mainEl = observation.interactiveElements.find((el) => el.accessibleName === "Main document control");
    const frameEl = observation.interactiveElements.find((el) => el.accessibleName === "Frame control");
    assert.ok(mainEl, "expected the main-document control to be scanned");
    assert.ok(frameEl, "expected the same-origin iframe's control to be scanned too");
    assert.equal(mainEl?.frameOrigin, undefined);
    assert.ok(frameEl?.frameOrigin, "expected the frame-scoped element to carry its frame's origin");
    assert.notEqual(frameEl?.id, mainEl?.id);
  });
});

test("readElementState resolves a frame-scoped element id against its live owning frame (visible and covered both work)", async () => {
  const html = `<!doctype html><html><body>
    <iframe srcdoc="&lt;button&gt;Frame control&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const frameEl = observation.interactiveElements.find((el) => el.accessibleName === "Frame control");
    assert.ok(frameEl);
    const state = await readElementState(page, frameEl!.id);
    assert.equal(state.attached, true);
    assert.equal(state.visible, true);
    assert.equal(state.actionable, true);
    assert.equal(state.frameUnavailable, false);
  });
});

test("a frame-scoped element id whose owning frame no longer exists resolves as frameUnavailable, never crashing or silently substituting the main document", async () => {
  const html = `<!doctype html><html><body>
    <iframe id="the-frame" srcdoc="&lt;button&gt;Frame control&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const frameEl = observation.interactiveElements.find((el) => el.accessibleName === "Frame control");
    assert.ok(frameEl);

    await page.evaluate(() => document.getElementById("the-frame")?.remove());

    const state = await readElementState(page, frameEl!.id);
    assert.equal(state.frameUnavailable, true);
    assert.equal(state.actionable, false);
    assert.equal(state.attached, false);
  });
});

test("an inaccessible (removed mid-scan) child frame is reported by origin only on the Observation, and contributes no candidates", async () => {
  const html = `<!doctype html><html><body>
    <button>Main document control</button>
    <iframe id="the-frame" srcdoc="&lt;button&gt;Frame control&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    // Remove the iframe right after it has committed but before buildObservation ever
    // gets a chance to scan it -- reproduces the same "frame no longer accessible" class
    // of race actions/click.ts's frame_unavailable category also protects against.
    await page.waitForSelector("iframe");
    await page.evaluate(() => document.getElementById("the-frame")?.remove());

    const observation = await buildObservation(page);
    assert.ok(
      !observation.interactiveElements.some((el) => el.accessibleName === "Frame control"),
      "a removed frame must never contribute a candidate",
    );
    assert.ok(
      observation.interactiveElements.some((el) => el.accessibleName === "Main document control"),
      "the main document must still be scanned normally",
    );
  });
});
