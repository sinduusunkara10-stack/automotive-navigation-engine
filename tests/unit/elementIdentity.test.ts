import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { buildObservation, readElementState } from "../../src/observation/observationBuilder.js";
import { dispatchAction } from "../../src/actions/index.js";
import { buildClickIdentityKey, computeCandidateIdentity } from "../../src/core/routeMemory.js";
import { computeCandidateIdentitiesAtAnchor } from "../../src/core/recoveryAnchors.js";
import type { Captures } from "../../src/types/task-response.js";

/**
 * Element-identity fix (corrective pass, see CLAUDE.md "Fix the element-ID collision at its
 * source"): coverage for observation/observationBuilder.ts's raw `data-nav-engine-id`
 * assignment (a monotonically increasing, never-reused counter -- see that file's own doc
 * comment on the fix) and for core/routeMemory.ts's structural candidate identity
 * (buildClickIdentityKey -- destinationUrl, then nearestHeadingText, then bare
 * role+accessibleName), which is what Alternative Route Exploration/recovery-anchor
 * bookkeeping actually key exhaustion and anchor-candidate records on. The two layers are
 * complementary: the raw id is what a click actually executes against; the structural
 * identity is what the engine reasons about across re-observations. Every scenario here is
 * generic HTML, never brand/site-specific.
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

function emptyCaptures(): Captures {
  return {};
}

test("1. duplicate CTA labels on different cards get distinct element ids", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle A</h3><button>View Offer Details</button></div>
    <div><h3>Vehicle B</h3><button>View Offer Details</button></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "View Offer Details");
    assert.equal(els.length, 2);
    assert.notEqual(els[0]!.id, els[1]!.id);
  });
});

test("2. same role/name across different surfaces (a background card and a modal reusing the identical label) get distinct ids", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle listing</h3><button>Confirm</button></div>
    <div role="dialog" aria-modal="true"><h2>Finance options</h2><button>Confirm</button></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "Confirm");
    assert.equal(els.length, 2);
    assert.notEqual(els[0]!.id, els[1]!.id);
    // Structural candidate identity (what exhaustion/anchor bookkeeping actually keys on)
    // must also stay distinct -- the nearest-heading context disambiguates the two surfaces.
    assert.notEqual(buildClickIdentityKey(els[0]!), buildClickIdentityKey(els[1]!));
  });
});

test("3. a model-selected element id resolves to, and dispatch executes against, the same DOM control -- never a same-labelled sibling", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle A</h3><button id="btnA">View Offer Details</button></div>
    <div><h3>Vehicle B</h3><button id="btnB">View Offer Details</button></div>
    <script>
      document.getElementById('btnA').addEventListener('click', function () {
        var m = document.createElement('div'); m.id = 'clicked-a'; document.body.appendChild(m);
      });
      document.getElementById('btnB').addEventListener('click', function () {
        var m = document.createElement('div'); m.id = 'clicked-b'; document.body.appendChild(m);
      });
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "View Offer Details");
    assert.equal(els.length, 2);
    const cardAEl = await page.locator(`[data-nav-engine-id="${els[0]!.id}"]`).getAttribute("id");
    const targetForCardA = cardAEl === "btnA" ? els[0]! : els[1]!;

    const state = await readElementState(page, targetForCardA.id);
    assert.equal(state.actionable, true);

    await dispatchAction({
      page,
      action: { type: "click", target: targetForCardA.id },
      captures: emptyCaptures(),
      stepIndex: 0,
      captureModules: [],
      allowedDomains: [],
      actionNavigationTimeoutMs: 5000,
    });

    assert.equal(await page.locator("#clicked-a").count(), 1, "expected exactly the intended card's own control to have been clicked");
    assert.equal(await page.locator("#clicked-b").count(), 0, "the sibling card's identically-labelled control must never have been clicked instead");
  });
});

test("4. re-observation after an earlier element is removed and a new, unrelated one is appended never lets the new element inherit the removed element's id", async () => {
  const html = `<!doctype html><html><body>
    <div id="banner"><button id="dismiss">Accept All Cookies</button></div>
    <div id="host"></div>
    <script>
      function removeBanner() { document.getElementById('banner').remove(); }
      function addNewControl() {
        var b = document.createElement('button');
        b.id = 'new-control';
        b.textContent = 'Alternative CTA A';
        document.getElementById('host').appendChild(b);
      }
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const before = await buildObservation(page);
    const dismissEl = before.interactiveElements.find((el) => el.accessibleName === "Accept All Cookies");
    assert.ok(dismissEl, "expected the banner's own control to be scanned first");
    const staleId = dismissEl!.id;

    // Removes the earlier-scanned element, then appends a brand-new, entirely unrelated
    // control -- reproducing exactly the freed-index scenario the fix addresses (see
    // observationBuilder.ts's own doc comment on the counter-based id assignment).
    await page.evaluate(() => {
      // @ts-expect-error -- page-context globals declared inline above
      removeBanner();
      // @ts-expect-error -- page-context globals declared inline above
      addNewControl();
    });

    const after = await buildObservation(page);
    const newEl = after.interactiveElements.find((el) => el.accessibleName === "Alternative CTA A");
    assert.ok(newEl, "expected the newly-appended control to be scanned");
    assert.notEqual(newEl!.id, staleId, "a brand-new control must never inherit a removed element's now-unused id");

    // The stale id must resolve as genuinely gone, never silently redirected to the new element.
    const staleState = await readElementState(page, staleId);
    assert.equal(staleState.attached, false);
  });
});

test("5. candidate exhaustion for one CTA does not suppress a different CTA that happens to share the same visible label", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle A</h3><button>View Offer Details</button></div>
    <div><h3>Vehicle B</h3><button>View Offer Details</button></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "View Offer Details");
    assert.equal(els.length, 2);

    const candidateA = computeCandidateIdentity({ type: "click", target: els[0]!.id }, observation);
    const candidateB = computeCandidateIdentity({ type: "click", target: els[1]!.id }, observation);
    assert.ok(candidateA);
    assert.ok(candidateB);
    // The exact property Route Memory's exhaustion tracking (core/state.ts's
    // getExhaustedCandidates, keyed by this same id) depends on: two same-labelled controls
    // from different cards must never collapse to one exhaustable identity.
    assert.notEqual(candidateA!.id, candidateB!.id);
  });
});

test("6. recovery-anchor candidate records (computeCandidateIdentitiesAtAnchor) point to distinct, correct logical controls for duplicate-labelled cards", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle A</h3><button>View Offer Details</button></div>
    <div><h3>Vehicle B</h3><button>View Offer Details</button></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const identities = computeCandidateIdentitiesAtAnchor(observation);
    const matching = identities.filter((id) => id.includes("View Offer Details"));
    assert.equal(matching.length, 2, "expected both cards' controls to be recorded as distinct anchor candidates");
    assert.notEqual(matching[0], matching[1]);
  });
});

test("7. frame-scoped controls never collide with a main-frame control sharing the same role and accessible name", async () => {
  const html = `<!doctype html><html><body>
    <button>Continue</button>
    <iframe srcdoc="&lt;button&gt;Continue&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "Continue");
    assert.equal(els.length, 2);
    assert.notEqual(els[0]!.id, els[1]!.id);
    const [mainEl, frameEl] = els[0]!.frameOrigin ? [els[1]!, els[0]!] : [els[0]!, els[1]!];
    assert.equal(mainEl.frameOrigin, undefined);
    assert.ok(frameEl.frameOrigin, "expected the iframe control to carry a frameOrigin distinguishing it from the main frame");
    assert.notEqual(buildClickIdentityKey(mainEl), buildClickIdentityKey(frameEl));
  });
});

test("8. reordering unrelated siblings never redirects an existing control's own id to a different element", async () => {
  const html = `<!doctype html><html><body>
    <div id="list">
      <a href="#a">Filler A</a>
      <button id="target">Alternative CTA A</button>
      <a href="#b">Filler B</a>
    </div>
    <script>
      function reorder() {
        var list = document.getElementById('list');
        var fillerB = list.lastElementChild;
        list.insertBefore(fillerB, list.firstElementChild);
      }
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const before = await buildObservation(page);
    const target = before.interactiveElements.find((el) => el.accessibleName === "Alternative CTA A");
    assert.ok(target);
    const originalId = target!.id;

    await page.evaluate(() => {
      // @ts-expect-error -- page-context global declared inline above
      reorder();
    });

    const after = await buildObservation(page);
    const targetAfter = after.interactiveElements.find((el) => el.accessibleName === "Alternative CTA A");
    assert.ok(targetAfter);
    assert.equal(targetAfter!.id, originalId, "an existing control's own id must survive unrelated sibling reordering unchanged");

    const state = await readElementState(page, originalId);
    assert.equal(state.attached, true);
    assert.equal(state.actionable, true);
  });
});

test("9. diagnostics (nearestHeadingText) carry enough context to distinguish duplicate-labelled controls from each other", async () => {
  const html = `<!doctype html><html><body>
    <div><h3>Vehicle A</h3><button>View Offer Details</button></div>
    <div><h3>Vehicle B</h3><button>View Offer Details</button></div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const els = observation.interactiveElements.filter((el) => el.accessibleName === "View Offer Details");
    assert.equal(els.length, 2);
    assert.ok(els[0]!.nearestHeadingText, "expected per-card heading context on each duplicate-labelled control");
    assert.ok(els[1]!.nearestHeadingText);
    assert.notEqual(els[0]!.nearestHeadingText, els[1]!.nearestHeadingText);
    assert.deepEqual(new Set([els[0]!.nearestHeadingText, els[1]!.nearestHeadingText]), new Set(["Vehicle A", "Vehicle B"]));
  });
});
