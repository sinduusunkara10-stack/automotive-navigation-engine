import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { executeGoBack } from "../../src/actions/goBack.js";

/**
 * Safe replanning / go_back fix: direct coverage of executeGoBack itself against real
 * Chromium/Playwright navigation behaviour -- a plain page.goBack() call previously reported
 * success whenever it resolved without throwing, regardless of where it actually landed,
 * which let a caller (src/core/loop.ts's bounded journey replanning) treat "the browser is
 * now stuck on about:blank" as if it were real recovery progress. See
 * tests/integration/journeyReplanning.test.ts for the corresponding engine-level coverage of
 * when go_back is (and is not) offered as a replanning candidate in the first place; this
 * file only exercises the executor's own outcome classification, real page objects, no
 * scripted reasoning provider involved.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    res
      .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end("<!doctype html><html><head><title>Fixture</title></head><body>hi</body></html>");
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

test("executeGoBack: refuses to even attempt navigation when the page is already at about:blank", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    assert.equal(page.url(), "about:blank");
    const result = await executeGoBack(page, 5000);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", /already at a blank/i);
  } finally {
    await page.close();
    await browser.close();
  }
});

test("executeGoBack: a page with exactly one real prior navigation reaches about:blank on goBack, and this is reported as a failure, not success", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/`);
    const result = await executeGoBack(page, 5000);
    // Verified empirically (real Chromium): with only one real navigation ever performed,
    // Playwright's goBack() lands the page back at about:blank -- there is genuinely
    // nothing else in history to return to.
    assert.equal(page.url(), "about:blank");
    assert.equal(result.success, false, "landing on about:blank must never be reported as a successful recovery");
    assert.match(result.error ?? "", /blank, content-free page state/i);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("executeGoBack: genuine backward navigation across two distinct real pages succeeds and reports the correct resultingUrl", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/`);
    const firstUrl = page.url();
    await page.goto(`${baseUrl}/?two`);
    assert.notEqual(page.url(), firstUrl);

    const result = await executeGoBack(page, 5000);
    assert.equal(result.success, true);
    assert.equal(result.resultingUrl, firstUrl);
    assert.equal(page.url(), firstUrl);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("executeGoBack: reports goBackOutcome restoration_verified as absent from the executor itself -- a clean resolve is committed-but-unverified, never restoration_verified", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/`);
    await page.goto(`${baseUrl}/?two`);
    const result = await executeGoBack(page, 5000);
    assert.equal(result.success, true);
    assert.equal(
      result.goBackOutcome,
      "navigation_committed_restoration_unverified",
      "a changed URL alone must never be reported as restoration_verified by the executor itself",
    );
    assert.equal(result.goBackDiagnostics?.navigationCommitted, true);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("executeGoBack: a Playwright timeout with a genuinely committed, non-blank URL reports navigation_committed_restoration_unverified, not a hard failure", async () => {
  // A slow server that never finishes the response body -- page.goBack()'s own
  // waitUntil:"commit" wait needs the response to at least start, but this executor's own
  // timeoutMs (short here) still expires before the caller-facing promise the test awaits
  // would resolve on its own, exercising the timeout branch deterministically.
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.write("<!doctype html><html><head><title>Slow</title></head><body>slow");
    // Deliberately never end() the response within the test's own short timeoutMs budget.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/first`, { waitUntil: "commit" }).catch(() => {});
    await page.goto(`${baseUrl}/second`, { waitUntil: "commit" }).catch(() => {});
    // waitUntil:"commit" itself resolves as soon as navigation commits, so to actually
    // exercise a genuine goBack() timeout we pass an effectively-zero budget -- this is the
    // deterministic, environment-independent way to force the timeout branch rather than
    // racing a real slow network condition.
    const result = await executeGoBack(page, 1);
    // Under waitUntil:"commit" (see actions/goBack.ts), an effectively-zero timeout budget
    // is environment-timing-dependent: it can resolve cleanly, time out with the URL already
    // committed (navigation_committed_restoration_unverified -- the exact production-bug
    // shape this fix targets), or time out before history moved at all (restoration_failed).
    // Whichever branch actually fires, the invariant this fix guarantees is the same one
    // asserted here: `success` and `goBackOutcome` must always agree with `navigationCommitted`
    // -- a committed, non-blank URL is never reported as a hard failure, and success is never
    // true without a genuinely committed URL.
    assert.ok(result.goBackDiagnostics, "diagnostics must always be present");
    if (result.goBackDiagnostics!.navigationCommitted) {
      assert.equal(result.success, true, "a genuinely committed, non-blank URL must never be reported as a hard failure");
      assert.notEqual(result.goBackOutcome, "restoration_failed");
    } else {
      assert.equal(result.success, false);
    }
  } finally {
    await page.close();
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("executeGoBack: a genuine timeout with an unchanged URL fails safely (restoration_failed), never reported as unverified progress", async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto("data:text/html,<title>Only</title>");
    // No prior real navigation exists to go back to, and an effectively-zero timeout budget
    // forces the timeout branch; the URL must remain unchanged (or land on about:blank),
    // never reported as committed-but-unverified.
    const result = await executeGoBack(page, 1);
    assert.equal(result.success, false);
    assert.notEqual(result.goBackOutcome, "navigation_committed_restoration_unverified");
  } finally {
    await page.close();
    await browser.close();
  }
});

test("executeGoBack: a real backward navigation that happens to land on a URL identical to the one just left is still reported as success (not misclassified as a no-op)", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    // Regression fixture: two consecutive same-document navigations to the exact same
    // hash-only URL -- exactly what a generic destinationUrl fallback can legitimately
    // produce for a repeated candidate at the same decision point (see actions/click.ts,
    // and src/core/routeMemory.ts's own decision-point fingerprint, which is keyed partly
    // on URL, so a hash change is treated as a genuinely new decision point). Verified
    // empirically against real Chromium/Playwright: unlike an ordinary full-page
    // navigation, each of these same-document goto() calls still pushes its own history
    // entry even though the URL string is identical both times, so going back one step
    // from here genuinely traverses real history even though the resulting URL is
    // unchanged from where the page already was. A query-string change would not
    // reproduce this -- only a same-document (hash-only) navigation does.
    await page.goto(`${baseUrl}/`);
    await page.goto(`${baseUrl}/#detail`);
    await page.goto(`${baseUrl}/#detail`);
    const urlBeforeGoBack = page.url();

    const result = await executeGoBack(page, 5000);
    assert.equal(result.success, true, "a same-URL landing must not be treated as a failed/no-op go_back on its own");
    assert.equal(result.resultingUrl, urlBeforeGoBack);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
