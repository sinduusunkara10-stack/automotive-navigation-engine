import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { chromium } from "playwright";

import { executeClick } from "../../src/actions/click.js";
import { buildObservation } from "../../src/observation/observationBuilder.js";
import type { Captures } from "../../src/types/task-response.js";

/**
 * Fallback-verification fix (see CLAUDE.md and docs/architecture.md §18): the generic
 * destinationUrl navigation fallback (actions/click.ts) is only trustworthy on its own
 * terms when it reaches a materially different page (an ordinary GET navigation) --
 * verified here directly at the actions/click.ts level for full control and determinism,
 * mirroring tests/integration/overlayClickDetection.test.ts's own convention for exercising
 * the executor directly. Every fixture below is purely synthetic, no brand/CTA-specific
 * wording, per CLAUDE.md's non-negotiable design rule.
 */
async function startFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    const page = (title: string, body: string) =>
      res
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(`<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`);

    if (path === "/unverified-start.html") {
      // A permanent, full-viewport transparent overlay forces the generic destinationUrl
      // fallback (mirrors tests/integration/actionExecutionConsistency.test.ts's own
      // /intercepted-overlay.html). The anchor's href is hash-only on the *same* page, and
      // nothing on this page reacts to it -- the fallback can never produce any evidence of
      // real progress beyond the URL itself changing.
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="#detail">View Details</a>',
      );
    }

    if (path === "/verified-cross-page-start.html") {
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="/verified-cross-page-done.html">View Details</a>',
      );
    }
    if (path === "/verified-cross-page-done.html") {
      return void page("Done", "<h1>Done</h1>");
    }

    if (path === "/verified-hash-with-effect-start.html") {
      // Same-document hash-only href, but this time the destination hash *does* correspond
      // to genuine, generically-detectable evidence (a dialog present once the fallback
      // lands there) -- a legitimate case where the fallback should be verified, even
      // though it's still only a raw page.goto() and not a real click. Models a site that
      // *does* support deep-linking a modal open via its own hash-reading bootstrap code
      // (unlike the click-handler-only case this whole fix is about).
      return void page(
        "Start",
        '<div style="position: fixed; inset: 0; z-index: 9999; background: transparent"></div>' +
          '<a href="#open">View Details</a>' +
          "<script>" +
          "if (location.hash === '#open') {" +
          "  var d = document.createElement('div');" +
          "  d.setAttribute('role', 'dialog');" +
          "  d.setAttribute('aria-modal', 'true');" +
          "  d.innerHTML = '<button type=\"button\">Deep-linked control</button>';" +
          "  document.body.appendChild(d);" +
          "}" +
          "window.addEventListener('hashchange', function () {" +
          "  if (location.hash === '#open' && !document.querySelector('[role=\"dialog\"]')) {" +
          "    var d = document.createElement('div');" +
          "    d.setAttribute('role', 'dialog');" +
          "    d.setAttribute('aria-modal', 'true');" +
          "    d.innerHTML = '<button type=\"button\">Deep-linked control</button>';" +
          "    document.body.appendChild(d);" +
          "  }" +
          "});" +
          "</script>",
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

async function clickFirst(page: import("playwright").Page, allowedDomains: string[], name: string) {
  const observation = await buildObservation(page);
  const target = observation.interactiveElements.find((el) => el.accessibleName === name);
  assert.ok(target, `expected to find "${name}" in the observation`);
  const captures: Captures = {};
  const result = await executeClick({
    page,
    action: { type: "click", target: target!.id },
    allowedDomains,
    timeoutMs: 5000,
    captures,
    stepIndex: 0,
    captureModules: ["errors"],
  });
  return { result, errors: captures.errors ?? [] };
}

test("an unverified same-document hash-only destinationUrl fallback is reported as a failed, staleTarget-classified action, not a successful one", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/unverified-start.html`);
    const { result, errors } = await clickFirst(page, ["127.0.0.1"], "View Details");

    // Target-attributable click-success fix: fallbackVerified is no longer diagnostic-only.
    // A hash-only change with no target-attributable evidence must not be reported as a
    // successful action -- it falls through to the same bounded staleTarget recovery any
    // other stale-target failure uses, giving the reasoning layer a further chance instead
    // of silently reporting unverified progress as journey success.
    assert.equal(result.success, false, "an unverified fallback must not be reported as a successful action");
    assert.equal(result.fallbackVerified, false, "a hash-only change with no further evidence must not be verified");
    assert.equal(result.fallbackVerificationReason, "unverified_hash_or_query_only_change");
    assert.equal(result.staleTarget, true, "an unverified fallback is classified the same as any other stale-target failure");
    assert.equal(result.resultingUrl, `${baseUrl}/unverified-start.html#detail`, "the URL the fallback actually reached is still reported for diagnostics");

    const diagnostic = errors.find((e) => /fallback changed the URL but produced no target-attributable evidence/.test(e.message));
    assert.ok(diagnostic);
    assert.equal(diagnostic?.recoverable, true);
    assert.equal(diagnostic?.stoppedRun, false);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("an ordinary cross-page destinationUrl fallback (a genuine GET navigation) remains fallbackVerified: true -- ordinary href navigation stays fully compatible", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/verified-cross-page-start.html`);
    const { result, errors } = await clickFirst(page, ["127.0.0.1"], "View Details");

    assert.equal(result.success, true);
    assert.equal(result.resultingUrl, `${baseUrl}/verified-cross-page-done.html`);
    assert.equal(result.fallbackVerified, true);

    const diagnostic = errors.find((e) => /fallbackNavigationUsed=true/.test(e.message));
    assert.ok(diagnostic);
    assert.match(diagnostic?.message ?? "", /fallbackVerified=true/);
    assert.match(diagnostic?.message ?? "", /fallbackVerificationReason=path_changed/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("a same-document hash-only fallback that DOES land on genuine, generically-detectable evidence (a dialog the destination page itself renders) is still verified", async () => {
  const { baseUrl, close } = await startFixtureServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/verified-hash-with-effect-start.html`);
    const { result, errors } = await clickFirst(page, ["127.0.0.1"], "View Details");

    assert.equal(result.success, true);
    assert.equal(result.fallbackVerified, true, "generic post-fallback evidence of a real interaction surface must still count as verified");

    const diagnostic = errors.find((e) => /fallbackNavigationUsed=true/.test(e.message));
    assert.ok(diagnostic);
    assert.match(diagnostic?.message ?? "", /fallbackVerified=true/);
    assert.match(diagnostic?.message ?? "", /fallbackVerificationReason=dialog_appeared/);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});
