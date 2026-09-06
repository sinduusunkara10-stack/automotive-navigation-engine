import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer, type Server } from "node:http";

import { runTask } from "../../src/core/engine.js";
import type { TaskRequest } from "../../src/types/task-request.js";

/**
 * A generic stand-in for a real OEM configurator page (Opel, Citroën, or any other market)
 * -- CLAUDE.md forbids brand-specific fixtures, so this fixture exercises the same
 * structural shape (interactive controls, a product image, a preloaded font, a media
 * element, an XHR/fetch call, and a dataLayer + GA4 image-beacon pattern matching this
 * repo's own tests/fixtures/start.html) without naming any real site.
 */
interface FixtureHitCounts {
  photo: number;
  font: number;
  clip: number;
  apiData: number;
  ga4Collect: number;
}

async function startConfiguratorFixture(): Promise<{
  baseUrl: string;
  hits: FixtureHitCounts;
  close: () => Promise<void>;
}> {
  const hits: FixtureHitCounts = { photo: 0, font: 0, clip: 0, apiData: 0, ga4Collect: 0 };

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/start.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        `<!doctype html><html><head><title>Configurator</title>
          <link rel="preload" href="/font.woff2" as="font" type="font/woff2" crossorigin>
        </head><body>
          <h1>Configure your vehicle</h1>
          <img src="/photo.jpg" alt="Product photo" />
          <video src="/clip.mp4" preload="auto" muted></video>
          <button id="trim-level-sport">Sport trim</button>
          <button id="trim-level-comfort">Comfort trim</button>
          <a href="/success.html" id="continue-link">Continue</a>
          <script>
            window.dataLayer = window.dataLayer || [];
            window.dataLayer.push({ event: "page_view", page: "configurator_start" });
            fetch("/api/data.json").catch(() => {});
            var ga4Params = new URLSearchParams({ v: "2", tid: "G-FICTIONALTEST1", cid: "1.1", en: "page_view" });
            new Image().src = "/g/collect?" + ga4Params.toString();
          </script>
        </body></html>`,
      );
      return;
    }
    if (path === "/success.html") {
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end("<!doctype html><html><head><title>Success</title></head><body><h1>Success</h1></body></html>");
      return;
    }
    if (path === "/photo.jpg") {
      hits.photo += 1;
      res.writeHead(200, { "Content-Type": "image/jpeg" }).end(Buffer.alloc(20_000, 1));
      return;
    }
    if (path === "/font.woff2") {
      hits.font += 1;
      res.writeHead(200, { "Content-Type": "font/woff2" }).end(Buffer.alloc(8_000, 2));
      return;
    }
    if (path === "/clip.mp4") {
      hits.clip += 1;
      res.writeHead(200, { "Content-Type": "video/mp4" }).end(Buffer.alloc(50_000, 3));
      return;
    }
    if (path === "/api/data.json") {
      hits.apiData += 1;
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (path === "/g/collect") {
      hits.ga4Collect += 1;
      res.writeHead(200, { "Content-Type": "image/gif" }).end(Buffer.alloc(1));
      return;
    }
    res.writeHead(404).end("Not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function buildTask(startUrl: string): TaskRequest {
  return {
    schemaVersion: "1.10.0",
    taskId: "low-memory-mode-task",
    objective: "Reach the success page by following the visible continue control.",
    startUrl,
    allowedDomains: ["127.0.0.1"],
    successCriteria: [
      { id: "reached_success_page", type: "url_pattern", description: "x", config: { pattern: "**success.html" } },
    ],
    captureModules: ["page_visits", "cta_clicks", "journey_path", "data_layer_evidence", "ga4_network_events", "errors"],
    limits: { maxSteps: 5, maxBacktracks: 0, maxRepeatedActions: 3 },
    safety: {
      allowedActions: ["click", "capture", "stop_success", "stop_blocked", "stop_failure"],
      allowFormSubmission: false,
      allowPaymentOrPurchase: false,
      allowPersonalDataEntry: false,
    },
    outputSchemaVersion: "1.9.0",
  };
}

test("without low-memory mode, image/font/media requests reach the origin server normally", async () => {
  const fixture = await startConfiguratorFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const result = await runTask({ page, task: buildTask(`${fixture.baseUrl}/start.html`) });

    assert.equal(result.status, "success");
    assert.ok(fixture.hits.photo > 0, "expected the image to actually be fetched");
    assert.ok(fixture.hits.font > 0, "expected the font to actually be fetched");
    assert.equal(result.diagnostics.resourceRouting, undefined, "no routing diagnostics when the mode is off");
  } finally {
    await browser.close();
    await fixture.close();
  }
});

test("with LOW_MEMORY_BROWSER_MODE, image/font/media requests never reach the origin server, while script/xhr/fetch/document/GA4 evidence remains fully observable", async () => {
  const { attachLowMemoryResourceRouting } = await import("../../src/api/browserResourceRouting.js");
  const fixture = await startConfiguratorFixture();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ serviceWorkers: "block" });
    const routing = attachLowMemoryResourceRouting(page);
    const task = buildTask(`${fixture.baseUrl}/start.html`);
    const result = await runTask({ page, task });
    const resourceRouting = routing.diagnostics();
    await routing.detach();

    // --- The run itself still succeeds, and interactive elements are still exposed. ---
    assert.equal(result.status, "success");
    assert.ok(result.steps.length > 0);
    const firstStepElements = result.steps[0]?.observation.interactiveElements ?? [];
    assert.ok(
      firstStepElements.some((el) => /sport trim/i.test(el.accessibleName)),
      "expected the configurator's own trim-selection controls to still be visible as interactive elements",
    );
    assert.ok(
      firstStepElements.some((el) => /continue/i.test(el.accessibleName)),
      "expected the continue control to still be visible as an interactive element",
    );

    // --- Blocked resource types never reached the real origin server. ---
    assert.equal(fixture.hits.photo, 0, "expected the image request to be intercepted, never reaching the server");
    assert.equal(fixture.hits.font, 0, "expected the font request to be intercepted, never reaching the server");
    assert.equal(fixture.hits.clip, 0, "expected the media request to be intercepted, never reaching the server");
    // The GA4 beacon is an <img>-tag request (resourceType "image"), so it too is blocked
    // at the network layer -- this is the core claim under test (see next assertions).
    assert.equal(fixture.hits.ga4Collect, 0, "expected the GA4 beacon's own network delivery to be blocked");

    // --- Allowed resource types (script/document/xhr/fetch) still reached the server. ---
    assert.ok(fixture.hits.apiData > 0, "expected the fetch() call to reach the server normally");

    // --- Despite the GA4 beacon being blocked, capture still observed it being attempted:
    // ga4NetworkEvents.ts listens on page.on("request"), which fires regardless of how
    // routing later resolves the request. This is the key property that makes blocking
    // image-type resources safe for the analytics-capture use case. ---
    assert.ok(result.captures.ga4_network_events && result.captures.ga4_network_events.length > 0);
    assert.equal(result.captures.ga4_network_events?.[0]?.params?.tid, "G-FICTIONALTEST1");

    // --- Other required outputs are unaffected. ---
    assert.ok(result.captures.page_visits && result.captures.page_visits.length > 0);
    assert.ok(result.captures.cta_clicks && result.captures.cta_clicks.length > 0);
    assert.ok(result.captures.journey_path && result.captures.journey_path.length > 0);
    assert.ok(result.captures.data_layer_evidence && result.captures.data_layer_evidence.length > 0);

    // --- Blocking is fulfilled, not aborted, so it never pollutes captures.errors. ---
    const blockedResourceErrors = (result.captures.errors ?? []).filter(
      (e) => e.category === "network_request_failed",
    );
    assert.equal(blockedResourceErrors.length, 0, "expected no network_request_failed noise from blocked resources");

    // --- diagnostics.resourceRouting reports real counts, measured allowed bytes, and
    // estimated (clearly not measured) blocked bytes. ---
    assert.equal(resourceRouting.mode, "low_memory");
    const byType = new Map(resourceRouting.byResourceType.map((e) => [e.resourceType, e]));
    const image = byType.get("image");
    assert.ok(image && image.blockedCount >= 1, "expected at least one blocked image entry");
    assert.ok(image!.blockedBytesEstimated > 0, "expected a non-zero estimate for blocked image bytes");
    const font = byType.get("font");
    assert.ok(font && font.blockedCount >= 1);
    const media = byType.get("media");
    assert.ok(media && media.blockedCount >= 1);
    const documentEntry = byType.get("document");
    assert.ok(documentEntry && documentEntry.allowedCount >= 1, "expected document navigations to be allowed");
  } finally {
    await browser.close();
    await fixture.close();
  }
});
