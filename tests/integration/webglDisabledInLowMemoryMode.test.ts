import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

import { buildLaunchArgs } from "../../src/api/runner.js";

/**
 * Proves the actual effect of buildLaunchArgs's WebGL-disabling flags against real
 * Chromium, not just that the flag strings are present in an array (tests/unit/
 * runnerLaunchArgs.test.ts covers that). --disable-gpu alone does not prevent a WebGL
 * context from being created (Chromium falls back to software rasterization), so this
 * confirms --disable-webgl/--disable-webgl2 are what actually removes it.
 */
async function pageSupportsWebgl(lowMemoryMode: boolean): Promise<boolean> {
  const browser = await chromium.launch({ args: buildLaunchArgs(lowMemoryMode) });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><button id='go'>Continue</button></body></html>");
    return await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      return !!(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    });
  } finally {
    await browser.close();
  }
}

test("without low-memory mode, WebGL remains available (software-rasterized)", async () => {
  assert.equal(await pageSupportsWebgl(false), true);
});

test("with low-memory mode, WebGL is unavailable", async () => {
  assert.equal(await pageSupportsWebgl(true), false);
});

test("with low-memory mode, ordinary DOM interactive elements are unaffected", async () => {
  const browser = await chromium.launch({ args: buildLaunchArgs(true) });
  try {
    const page = await browser.newPage();
    await page.setContent("<!doctype html><html><body><button id='go'>Continue</button></body></html>");
    const clicked = await page
      .locator("#go")
      .click()
      .then(() => true)
      .catch(() => false);
    assert.equal(clicked, true, "a plain DOM button must remain clickable when WebGL is disabled");
  } finally {
    await browser.close();
  }
});
