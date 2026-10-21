import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";

import { installSubmitProbe } from "../../src/actions/submitCancellationProbe.js";

const ORIGIN = "https://www.example-automotive-oem.com";

const PAGE = `<!doctype html><html><head><title>Demande d'essai</title></head><body>
<form id="f" action="/api/lead" method="post"><input name="a" value="1" /><button type="submit" id="s">Envoyer</button></form>
<script>
  window.jQuery = function () {};
  window.jQuery.fn = {
    serialize() { return "len=" + this.length; },
    serializeArray() { throw new RangeError("bad form"); },
  };
</script></body></html>`;

/** Exercises every recorded surface and returns what the page itself observes. A string source, so no compiled helper names leak into the page. */
const EXERCISE_SOURCE = `(async () => {
  const out = {};
  const log = [];
  const errName = (fn) => {
    try {
      fn();
      return "none";
    } catch (e) {
      return e.name;
    }
  };
  let unhandled = 0;
  window.addEventListener("unhandledrejection", () => {
    unhandled += 1;
  });

  log.push("before-fetch");
  const p = fetch("/api/echo");
  log.push("after-fetch");
  out.fetchReturnsPromise = p instanceof Promise;
  out.fetchStatus = (await p).status;
  out.fetchIllegalThis = errName(() => window.fetch.call({}, "/api/echo"));
  out.fetchToString = Function.prototype.toString.call(window.fetch).includes("[native code]");
  fetch("https://unreachable.invalid/x");
  await new Promise((r) => setTimeout(r, 300));
  out.unhandledRejections = unhandled;

  const xhr = new XMLHttpRequest();
  out.sendBeforeOpen = errName(() => xhr.send());
  out.openReturn = String(xhr.open("GET", "/api/echo", false));
  out.sendReturn = String(xhr.send());
  out.syncStatusRightAfterSend = xhr.status;
  out.xhrProto = Object.getPrototypeOf(xhr) === XMLHttpRequest.prototype;

  out.beaconReturn = navigator.sendBeacon("/api/beacon", "x");
  out.beaconIllegalThis = errName(() => navigator.sendBeacon.call({}, "/api/beacon"));

  const form = document.getElementById("f");
  document.addEventListener("submit", () => log.push("doc-capture"), true);
  form.addEventListener("submit", (e) => {
    log.push("form-target");
    e.preventDefault();
  });
  document.addEventListener("submit", (e) => log.push("doc-bubble:" + e.defaultPrevented));
  form.requestSubmit();
  log.push("after-requestSubmit");
  out.requestSubmitBadSubmitter = errName(() => form.requestSubmit(document.body));

  out.preventDefaultIllegalThis = errName(() => Event.prototype.preventDefault.call({}));
  const cancellable = new Event("x", { cancelable: true });
  out.preventDefaultReturn = String(cancellable.preventDefault());
  out.preventDefaultApplied = cancellable.defaultPrevented;
  out.preventDefaultToString = Function.prototype.toString.call(Event.prototype.preventDefault).includes("[native code]");
  const stopped = new Event("y", { bubbles: true });
  out.stopPropagationReturn = String(stopped.stopPropagation());
  out.serialize = window.jQuery.fn.serialize.call({ length: 3 });
  out.serializeArrayThrows = errName(() => window.jQuery.fn.serializeArray.call({ length: 1 }));
  out.log = log;
  return out;
})()`;

async function exercise(page: Page): Promise<unknown> {
  return page.evaluate(EXERCISE_SOURCE);
}

async function withPage<T>(body: (page: Page) => Promise<T>): Promise<T> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") return route.fulfill({ status: 200, contentType: "text/html", body: PAGE });
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.route("https://unreachable.invalid/**", (route) => route.abort());
    await page.goto(`${ORIGIN}/`);
    return await body(page);
  } finally {
    await browser?.close();
  }
}

test("probe preservation (test 31): with the probe installed and armed, every wrapped call returns, throws, binds and orders exactly as without it", async () => {
  const baseline = await withPage((page) => exercise(page));
  const instrumented = await withPage(async (page) => {
    assert.equal(await installSubmitProbe(page), true);
    await page.evaluate(() => (window as unknown as { __navEngineSubmitProbe: { begin: (n: number) => boolean } }).__navEngineSubmitProbe.begin(1));
    return exercise(page);
  });
  assert.deepEqual(instrumented, baseline);
  const b = baseline as Record<string, unknown>;
  assert.equal(b.fetchStatus, 200);
  assert.equal(b.syncStatusRightAfterSend, 200);
  assert.ok((b.unhandledRejections as number) >= 1, "a rejected page promise stays unhandled");
  assert.equal(b.serializeArrayThrows, "RangeError");
  assert.deepEqual(b.log, ["before-fetch", "after-fetch", "doc-capture", "form-target", "doc-bubble:true", "after-requestSubmit"]);
});

test("probe preservation: installing twice wraps once, and an armed probe records without changing the page's own results", async () => {
  await withPage(async (page) => {
    await installSubmitProbe(page);
    await installSubmitProbe(page);
    await page.evaluate(() => {
      document.getElementById("f")!.setAttribute("data-nav-engine-probe-form", "1");
      document.getElementById("s")!.setAttribute("data-nav-engine-probe-submit", "1");
      (window as unknown as { __navEngineSubmitProbe: { begin: (n: number) => boolean } }).__navEngineSubmitProbe.begin(1);
    });
    const status = await page.evaluate(async () => {
      document.getElementById("f")!.addEventListener("submit", (e) => e.preventDefault());
      document.getElementById("s")!.click();
      const r = await fetch("/api/lead", { method: "POST", body: "a=1" });
      return r.status;
    });
    assert.equal(status, 200);
    await page.waitForTimeout(50);
    const rec = (await page.evaluate(() => (window as unknown as { __navEngineSubmitProbe: { read: () => unknown } }).__navEngineSubmitProbe.read())) as {
      dispatches: { transport: string; method: string; endpoint: string }[];
      submitEventFired: boolean;
      defaultPrevented: boolean;
    };
    assert.equal(rec.submitEventFired, true);
    assert.equal(rec.defaultPrevented, true);
    assert.deepEqual(
      rec.dispatches.map((d) => `${d.transport}:${d.method}:${d.endpoint}`),
      [`fetch:POST:${ORIGIN}/api/lead`],
    );
  });
});
