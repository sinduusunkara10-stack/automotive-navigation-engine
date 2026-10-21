import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";

import { buildManualSubmitComparisonSnippet } from "../../src/diagnostics/manualSubmitComparison.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

test("manual comparison snippet (Phase 7): a hand-filled Submit yields the same sanitised probe and field-state evidence, without replacing any page function", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto(`${baseUrl}/lead-form-site-validator.html?v=message`);
    await page.fill("#first-name", "Manualfirst");
    await page.fill("#last-name", "Manuallast");
    await page.fill("#email", "manual.person@example-automotive-oem.com");
    await page.evaluate(buildManualSubmitComparisonSnippet());
    await page.click("#submit-lead");
    await page.waitForTimeout(200);
    const out = await page.evaluate(() => (window as unknown as { __navEngineManualComparison: { read: () => string } }).__navEngineManualComparison.read());
    const untouched = await page.evaluate(() => {
      const w = window as unknown as { __pageFetch: unknown; __pagePreventDefault: unknown };
      return window.fetch === w.__pageFetch && Event.prototype.preventDefault === w.__pagePreventDefault;
    });
    assert.equal(untouched, true);
    const parsed = JSON.parse(out) as {
      probe: { submitEventFired: boolean; defaultPrevented: boolean; submitTrusted: boolean; probeMode: string };
      after: { fields: { safeName: string; stateTokens: { category: string }[]; ruleCategory: string }[] };
    };
    assert.equal(parsed.probe.probeMode, "passive");
    assert.equal(parsed.probe.submitEventFired, true);
    assert.equal(parsed.probe.defaultPrevented, true);
    assert.equal(parsed.probe.submitTrusted, true);
    const email = parsed.after.fields.find((f) => f.safeName === "email")!;
    assert.ok(email.stateTokens.some((t) => t.category === "error"));
    assert.equal(email.ruleCategory, "format");
    for (const value of ["Manualfirst", "Manuallast", "manual.person", "Adresse e-mail invalide", "fixture-token"]) assert.ok(!out.includes(value), `snippet output leaks ${value}`);
  } finally {
    await browser?.close();
    await close();
  }
});
