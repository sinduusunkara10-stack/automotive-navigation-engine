import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium, type Browser, type Page } from "playwright";

import { executeScroll } from "../../src/actions/scroll.js";
import { dispatchAction } from "../../src/actions/index.js";
import type { ScrollDiagnostics } from "../../src/types/task-response.js";

const BASE_STYLE =
  "body{margin:0;} .tall{height:3000px;} .scroller{width:300px;height:200px;} .inner-content{height:1500px;}";

const PAGES: Record<string, string> = {
  "/window.html": `<div class="tall"><button>Anchor</button></div>`,
  "/auto-container.html": `<div style="height:1200px"><div id="c" class="scroller" style="overflow-y:auto;position:absolute;left:500px;top:300px"><div class="inner-content"><button data-nav-engine-id="t1">Deep</button></div></div></div>`,
  "/scroll-container.html": `<div style="height:1200px"><div id="c" class="scroller" style="overflow-y:scroll;position:absolute;left:500px;top:300px"><div class="inner-content"><button data-nav-engine-id="t1">Deep</button></div></div></div>`,
  "/nested.html": `<div id="outer" class="scroller" style="overflow-y:auto;height:400px;width:500px;margin:100px"><div style="height:2500px"><div id="inner" class="scroller" style="overflow-y:auto;height:200px"><div class="inner-content"><button data-nav-engine-id="t1">Deep</button></div></div></div></div>`,
  "/target-below.html": `<div style="height:4000px"><button data-nav-engine-id="t1" style="position:absolute;top:2000px">Far</button></div>`,
  "/target-above.html": `<div style="height:4000px"><button data-nav-engine-id="t1" style="position:absolute;top:500px">Early</button></div>`,
  "/non-scrollable-ancestor.html": `<div style="height:3000px"><div id="wrap" style="overflow-y:auto;height:300px"><button data-nav-engine-id="t1">Short</button></div></div>`,
  "/focus-region.html": `<div style="height:3000px"><div id="c" class="scroller" style="overflow-y:auto;position:absolute;left:500px;top:300px"><div class="inner-content"><input id="f" /></div></div></div>`,
  "/unrelated-scroller.html": `<div style="height:3000px"><div id="c" class="scroller" style="overflow-y:auto;position:absolute;left:500px;top:300px"><div class="inner-content">x</div></div></div>`,
  "/covered-container.html": `<div style="height:3000px"><div id="c" class="scroller" style="overflow-y:auto;position:absolute;left:500px;top:300px"><div class="inner-content"><button data-nav-engine-id="t1">Deep</button></div></div><div style="position:fixed;left:480px;top:280px;width:340px;height:240px;background:rgba(0,0,0,.1)"></div></div>`,
  "/dialog.html": `<div class="tall"></div><div id="modal" role="dialog" aria-modal="true" style="position:fixed;inset:40px;overflow-y:auto;background:white"><div style="height:3000px">Modal</div></div>`,
};

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const body = PAGES[(req.url ?? "/").split("?")[0] ?? ""];
    if (body === undefined) return void res.writeHead(404).end("Not found");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
      `<!doctype html><html><head><title>t</title><style>${BASE_STYLE}</style></head><body>${body}</body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function withPage(path: string, run: (page: Page) => Promise<void>): Promise<void> {
  const { baseUrl, close } = await startServer();
  const browser: Browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}${path}`);
    await run(page);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
}

async function scroll(page: Page, deltaY: number, target?: string): Promise<ScrollDiagnostics> {
  const result = await executeScroll(page, { type: "scroll", ...(target ? { target } : {}), params: { deltaY } });
  assert.equal(result.success, true);
  assert.ok(result.scrollDiagnostics, "scroll must report scrollDiagnostics");
  return result.scrollDiagnostics;
}

const containerTop = (page: Page, id = "c") => page.evaluate((i) => document.getElementById(i)?.scrollTop ?? -1, id);

test("document scroll: no target and no active region scrolls the window", async () => {
  await withPage("/window.html", async (page) => {
    const d = await scroll(page, 400);
    assert.equal(d.containerSelectionSource, "document_fallback");
    assert.equal(d.scrollTargetType, "window");
    assert.equal(d.movementVerified, true);
    assert.ok(d.windowScrollY.after > d.windowScrollY.before);
    assert.equal(d.atTopBefore, true);
    assert.equal(d.atTopAfter, false);
  });
});

for (const [name, path] of [
  ["overflow-y:auto", "/auto-container.html"],
  ["overflow-y:scroll", "/scroll-container.html"],
] as const) {
  test(`target-aware scroll uses the target's ${name} ancestor`, async () => {
    await withPage(path, async (page) => {
      const d = await scroll(page, 300, "t1");
      assert.equal(d.containerSelectionSource, "target_ancestor");
      assert.equal(d.scrollTargetType, "scrollable_container");
      assert.equal(d.movementVerified, true);
      assert.ok(d.afterScrollTop > d.beforeScrollTop);
      assert.equal(await page.evaluate(() => window.scrollY), 0, "the window must not scroll");
      assert.equal(d.dispatchMethod, "mouse_wheel");
    });
  });
}

test("pointer starting outside the container is moved inside it before the wheel", async () => {
  await withPage("/auto-container.html", async (page) => {
    await page.mouse.move(5, 5);
    const d = await scroll(page, 300, "t1");
    assert.equal(d.movementVerified, true);
    assert.ok((await containerTop(page)) > 0);
  });
});

test("nested containers: the nearest scrollable ancestor is used, then the outer one once the inner is exhausted", async () => {
  await withPage("/nested.html", async (page) => {
    const first = await scroll(page, 300, "t1");
    assert.equal(first.containerSelectionSource, "target_ancestor");
    assert.ok((await containerTop(page, "inner")) > 0);
    assert.equal(await containerTop(page, "outer"), 0);

    await page.evaluate(() => {
      const inner = document.getElementById("inner")!;
      inner.scrollTop = inner.scrollHeight;
    });
    const second = await scroll(page, 300, "t1");
    assert.equal(second.movementVerified, true);
    assert.ok((await containerTop(page, "outer")) > 0, "an exhausted inner scroller defers to the outer one");
  });
});

test("target below the viewport becomes viewport-visible after a positive scroll", async () => {
  await withPage("/target-below.html", async (page) => {
    const d = await scroll(page, 1800, "t1");
    assert.equal(d.containerSelectionSource, "document_fallback");
    assert.equal(d.targetViewportVisibleBefore, false);
    assert.equal(d.targetViewportVisibleAfter, true);
    assert.equal(d.movementVerified, true);
  });
});

test("target above the viewport becomes viewport-visible after a negative scroll", async () => {
  await withPage("/target-above.html", async (page) => {
    await page.evaluate(() => window.scrollTo(0, 2000));
    const d = await scroll(page, -1800, "t1");
    assert.equal(d.targetViewportVisibleBefore, false);
    assert.equal(d.targetViewportVisibleAfter, true);
    assert.equal(d.movementVerified, true);
    assert.ok(d.scrollDeltaObserved < 0);
  });
});

test("a scroll that moves the page counts as movement even when the control set is identical", async () => {
  await withPage("/window.html", async (page) => {
    const result = await dispatchAction({
      page,
      action: { type: "scroll", params: { deltaY: 400 } },
      captures: {} as never,
      stepIndex: 0,
      captureModules: [],
      allowedDomains: ["127.0.0.1"],
      actionNavigationTimeoutMs: 5000,
    });
    assert.equal(result.scrollDiagnostics?.movementVerified, true);
    assert.equal(result.interactionOutcome, "IN_PAGE_STATE_CHANGE");
  });
});

test("top boundary with a negative delta is a deterministic no-movement result", async () => {
  await withPage("/window.html", async (page) => {
    const d = await scroll(page, -400);
    assert.equal(d.movementVerified, false);
    assert.equal(d.movementFailureReason, "at_top_boundary");
    assert.equal(d.atTopBefore, true);
  });
});

test("bottom boundary with a positive delta is a deterministic no-movement result and stays NO_OBSERVABLE_CHANGE", async () => {
  await withPage("/window.html", async (page) => {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const result = await dispatchAction({
      page,
      action: { type: "scroll", params: { deltaY: 400 } },
      captures: {} as never,
      stepIndex: 0,
      captureModules: [],
      allowedDomains: ["127.0.0.1"],
      actionNavigationTimeoutMs: 5000,
    });
    assert.equal(result.scrollDiagnostics?.movementVerified, false);
    assert.equal(result.scrollDiagnostics?.movementFailureReason, "at_bottom_boundary");
    assert.equal(result.interactionOutcome, "NO_OBSERVABLE_CHANGE");
  });
});

test("a non-scrollable ancestor is skipped and the document is used", async () => {
  await withPage("/non-scrollable-ancestor.html", async (page) => {
    const d = await scroll(page, 400, "t1");
    assert.equal(d.containerSelectionSource, "document_fallback");
    assert.equal(d.scrollTargetType, "window");
    assert.equal(d.movementVerified, true);
  });
});

test("an unresolvable target never invents a container", async () => {
  await withPage("/auto-container.html", async (page) => {
    const d = await scroll(page, 300, "does-not-exist");
    assert.equal(d.containerSelectionSource, "document_fallback");
    assert.equal(d.targetBoundingRectBefore, undefined);
  });
});

test("exploratory scroll uses the active region's scroller when focus is inside one", async () => {
  await withPage("/focus-region.html", async (page) => {
    await page.focus("#f");
    const d = await scroll(page, 300);
    assert.equal(d.containerSelectionSource, "active_region");
    assert.equal(d.scrollTargetType, "scrollable_container");
    assert.ok((await containerTop(page)) > 0);
  });
});

test("exploratory scroll with no active region ignores an unrelated scrollable div and scrolls the window", async () => {
  await withPage("/unrelated-scroller.html", async (page) => {
    await page.mouse.move(5, 5);
    const d = await scroll(page, 300);
    assert.equal(d.containerSelectionSource, "document_fallback");
    assert.equal(await containerTop(page), 0);
    assert.ok((await page.evaluate(() => window.scrollY)) > 0);
  });
});

test("an open scrollable dialog is still scrolled and reported as the active region", async () => {
  await withPage("/dialog.html", async (page) => {
    const d = await scroll(page, 400);
    assert.equal(d.containerSelectionSource, "active_region");
    assert.equal(d.movementVerified, true);
    assert.ok((await containerTop(page, "modal")) > 0);
    assert.equal(await page.evaluate(() => window.scrollY), 0);
  });
});

test("a container whose every probe point is covered is scrolled programmatically and still verified", async () => {
  await withPage("/covered-container.html", async (page) => {
    const d = await scroll(page, 300, "t1");
    assert.equal(d.containerSelectionSource, "target_ancestor");
    assert.equal(d.dispatchMethod, "programmatic");
    assert.equal(d.movementVerified, true);
  });
});
