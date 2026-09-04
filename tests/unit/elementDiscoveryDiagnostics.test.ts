import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Page } from "playwright";

import { buildObservation } from "../../src/observation/observationBuilder.js";

/**
 * REGRESSION (real production run: an Opel configurator page reported
 * visibleInteractiveElementsCount = 0 while a manual inspection of the same URL immediately
 * afterwards showed a large, visible, clickable CTA -- "the engine thinks the page has
 * nothing to click, but a human can see and click something"). Before this fix,
 * buildObservation's zero-candidate result carried no evidence of *why*: whether the
 * selector genuinely matched nothing, matched things that were all excluded as hidden, or
 * couldn't see candidates at all because they live inside a shadow root (a generic DOM
 * encapsulation mechanism `document.querySelectorAll` cannot pierce, open or closed --
 * see docs/architecture.md "Observation evidence"). These tests cover
 * Observation.elementDiscoveryDiagnostics, the bounded, generic diagnostic evidence that
 * now closes that gap -- see src/observation/observationBuilder.ts.
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

test("rawElementCount/buttonLikeCount/linkLikeCount/otherRoleCount/visibleElementCount are correct for a plain mixed page", async () => {
  const html = `<!doctype html><html><body>
    <button>Continue</button>
    <button>Cancel</button>
    <a href="/next">Next</a>
    <div role="tab">Colour</div>
    <div role="option">Blue</div>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics?.rawElementCount, 5);
    assert.equal(diagnostics?.buttonLikeCount, 2);
    assert.equal(diagnostics?.linkLikeCount, 1);
    assert.equal(diagnostics?.otherRoleCount, 2);
    assert.equal(diagnostics?.visibleElementCount, 5);
    assert.equal(diagnostics?.visibleElementCount, observation.interactiveElements.length);
  });
});

test("a genuinely empty page reports rawElementCount: 0 and shadowHostCount: 0 (the baseline, non-buggy zero)", async () => {
  const html = `<!doctype html><html><body><p>Nothing clickable here.</p></body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    assert.deepEqual(observation.elementDiscoveryDiagnostics, {
      rawElementCount: 0,
      buttonLikeCount: 0,
      linkLikeCount: 0,
      otherRoleCount: 0,
      visibleElementCount: 0,
      excludedZeroSizeCount: 0,
      excludedDisplayNoneCount: 0,
      excludedVisibilityHiddenCount: 0,
      shadowHostCount: 0,
    });
  });
});

test("excluded elements are bucketed by reason: zero-size, display:none, visibility:hidden", async () => {
  const html = `<!doctype html><html><body>
    <button style="width:0;height:0;padding:0;border:0;">Zero size</button>
    <button style="display:none;">Hidden via display</button>
    <button style="visibility:hidden;">Hidden via visibility</button>
    <button>Visible</button>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics?.rawElementCount, 4);
    assert.equal(diagnostics?.visibleElementCount, 1);
    // A display:none element's own bounding rect is also 0x0, so it is correctly counted
    // under BOTH excludedZeroSizeCount and excludedDisplayNoneCount -- these buckets are
    // not mutually exclusive (see ElementDiscoveryDiagnostics's own doc comment), which is
    // exactly why excludedZeroSizeCount is 2 here (the explicitly zero-sized button, plus
    // the display:none one) rather than 1.
    assert.equal(diagnostics?.excludedZeroSizeCount, 2);
    assert.equal(diagnostics?.excludedDisplayNoneCount, 1);
    assert.equal(diagnostics?.excludedVisibilityHiddenCount, 1);
    assert.equal(observation.interactiveElements.length, 1);
    assert.equal(observation.interactiveElements[0]?.accessibleName, "Visible");
  });
});

// ---------------------------------------------------------------------------------------
// shadowHostCount: the concrete, generic mechanism this run's investigation flagged as a
// plausible root cause -- document.querySelectorAll cannot see into any shadow root, open
// or closed, so a page whose real controls live inside one scans as if they don't exist at
// all, with no prior signal distinguishing that from a genuinely empty page.
// ---------------------------------------------------------------------------------------

test("a CTA inside an OPEN shadow root is invisible to interactiveElements, but shadowHostCount proves the page is not actually empty", async () => {
  const html = `<!doctype html><html><body>
    <div id="host"></div>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "open" });
      const button = document.createElement("button");
      button.textContent = "Weiter & Extras";
      root.appendChild(button);
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    // The exact bug reported in production: zero candidates from the normal scan...
    assert.equal(diagnostics?.rawElementCount, 0);
    assert.equal(observation.interactiveElements.length, 0);
    // ...but shadowHostCount is the generic tell that the page is not actually empty --
    // something this scan cannot see is hosting a shadow root.
    assert.equal(diagnostics?.shadowHostCount, 1);
  });
});

test("a CLOSED shadow root cannot be detected at all -- shadowHostCount stays 0, documenting the fundamental limitation", async () => {
  const html = `<!doctype html><html><body>
    <div id="host"></div>
    <script>
      const host = document.getElementById("host");
      const root = host.attachShadow({ mode: "closed" });
      const button = document.createElement("button");
      button.textContent = "Weiter & Extras";
      root.appendChild(button);
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics?.rawElementCount, 0);
    assert.equal(observation.interactiveElements.length, 0);
    // The DOM API gives no way to detect a closed shadow root's presence from outside the
    // component that created it -- this is a real, permanent gap, not a bug in the count.
    assert.equal(diagnostics?.shadowHostCount, 0);
  });
});

test("a page with ordinary interactive elements alongside an unrelated shadow-hosting element reports both correctly", async () => {
  const html = `<!doctype html><html><body>
    <button>Ordinary button</button>
    <div id="host"></div>
    <script>
      document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = "<button>Encapsulated</button>";
    </script>
  </body></html>`;
  await withPage(html, async (page) => {
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics?.rawElementCount, 1);
    assert.equal(observation.interactiveElements.length, 1);
    assert.equal(observation.interactiveElements[0]?.accessibleName, "Ordinary button");
    assert.equal(diagnostics?.shadowHostCount, 1);
  });
});

test("diagnostics are summed across the main document and an accessible same-origin child frame", async () => {
  const html = `<!doctype html><html><body>
    <button>Main button</button>
    <button style="display:none;">Main hidden</button>
    <iframe srcdoc="&lt;button&gt;Frame button&lt;/button&gt;&lt;button style=&#39;visibility:hidden&#39;&gt;Frame hidden&lt;/button&gt;"></iframe>
  </body></html>`;
  await withPage(html, async (page) => {
    await page.waitForTimeout(200);
    const observation = await buildObservation(page);
    const diagnostics = observation.elementDiscoveryDiagnostics;
    assert.ok(diagnostics);
    assert.equal(diagnostics?.rawElementCount, 4);
    assert.equal(diagnostics?.visibleElementCount, 2);
    assert.equal(diagnostics?.excludedDisplayNoneCount, 1);
    assert.equal(diagnostics?.excludedVisibilityHiddenCount, 1);
    assert.equal(observation.interactiveElements.length, 2);
  });
});
