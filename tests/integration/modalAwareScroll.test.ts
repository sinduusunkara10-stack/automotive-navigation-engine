import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { executeScroll } from "../../src/actions/scroll.js";

/**
 * Modal-aware scrolling fix (see CLAUDE.md and docs/architecture.md §18): when a visible,
 * genuinely scrollable dialog/modal surface is present, a scroll action moves the mouse
 * into it before wheeling, so the scroll lands inside the modal rather than the page
 * underneath. Exercised directly against actions/scroll.ts (exported), mirroring
 * tests/integration/overlayClickDetection.test.ts's own convention for testing an executor
 * in isolation. No brand/CTA-specific wording, per CLAUDE.md's non-negotiable design rule.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title><style>` +
          "body { height: 3000px; margin: 0; }" +
          "#modal { position: fixed; inset: 40px; overflow-y: auto; background: white; border: 1px solid black; }" +
          "#modal-content { height: 3000px; }" +
          "</style></head><body>" + body + "</body></html>");

    if (path === "/no-modal.html") {
      return void page("No modal", '<div id="filler">Ordinary long page.</div>');
    }
    if (path === "/with-scrollable-modal.html") {
      return void page(
        "With modal",
        '<div id="filler">Ordinary long background page.</div>' +
          '<div id="modal" role="dialog" aria-modal="true"><div id="modal-content">Modal content.</div></div>',
      );
    }

    res.writeHead(404).end("Not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to determine fixture server address");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test("a scrollable modal being open causes the scroll action to scroll inside the modal, not the background page", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/with-scrollable-modal.html`);

    const beforeBodyScroll = await page.evaluate(() => window.scrollY);
    const beforeModalScroll = await page.evaluate(() => document.getElementById("modal")?.scrollTop ?? 0);
    assert.equal(beforeBodyScroll, 0);
    assert.equal(beforeModalScroll, 0);

    const result = await executeScroll(page, { type: "scroll", params: { deltaY: 400 } });
    assert.equal(result.success, true);
    await page.waitForTimeout(200);

    const afterBodyScroll = await page.evaluate(() => window.scrollY);
    const afterModalScroll = await page.evaluate(() => document.getElementById("modal")?.scrollTop ?? 0);

    assert.ok(afterModalScroll > beforeModalScroll, "expected the modal's own scrollTop to advance");
    assert.equal(afterBodyScroll, 0, "the background page must not scroll while a scrollable modal is open");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("no modal present: scroll behaviour is unchanged -- the document scrolls exactly as before this fix", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/no-modal.html`);

    const beforeScroll = await page.evaluate(() => window.scrollY);
    assert.equal(beforeScroll, 0);

    const result = await executeScroll(page, { type: "scroll", params: { deltaY: 400 } });
    assert.equal(result.success, true);
    await page.waitForTimeout(200);

    const afterScroll = await page.evaluate(() => window.scrollY);
    assert.ok(afterScroll > beforeScroll, "expected the ordinary document to scroll when no modal is present");
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
