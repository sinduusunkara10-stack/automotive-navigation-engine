import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { assessInitialNavigationRecovery } from "../../src/core/initialNavigation.js";

function fakePage(params: {
  url: string;
  title?: string;
  bodyText?: string;
  interactiveCount?: number;
}): Page {
  const { url, title = "", bodyText = "", interactiveCount = 0 } = params;
  return {
    url: () => url,
    title: async () => title,
    evaluate: async (fn: unknown) => {
      const source = String(fn);
      if (source.includes("innerText")) {
        return bodyText;
      }
      return interactiveCount;
    },
  } as unknown as Page;
}

test("a usable document on an allowed host is recoverable", async () => {
  const page = fakePage({ url: "https://example-automotive-oem.com/config", title: "Configurator" });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, true);
  assert.equal(result.url, "https://example-automotive-oem.com/config");
});

test("recoverable when only body text is present (no title)", async () => {
  const page = fakePage({ url: "https://example-automotive-oem.com/config", bodyText: "Some rendered content" });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, true);
});

test("recoverable when only interactive elements are present", async () => {
  const page = fakePage({ url: "https://example-automotive-oem.com/config", interactiveCount: 2 });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, true);
});

test("a completely blank document is not recoverable", async () => {
  const page = fakePage({ url: "https://example-automotive-oem.com/config" });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, false);
});

test("a usable document reached outside allowedDomains is not recoverable (disallowed redirects stay blocked)", async () => {
  const page = fakePage({
    url: "https://not-an-allowed-host.example/config",
    title: "Somewhere else entirely",
    bodyText: "Fully rendered off-allowlist content",
    interactiveCount: 5,
  });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, false);
});

test("a non-http(s) URL (no real navigation happened) is not recoverable", async () => {
  const page = fakePage({ url: "about:blank", title: "" });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, false);
});

test("an unparseable URL is not recoverable", async () => {
  const page = fakePage({ url: "" });
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, false);
});

test("a page.url() that throws is not recoverable", async () => {
  const page = {
    url: () => {
      throw new Error("boom");
    },
    title: async () => "",
    evaluate: async () => "",
  } as unknown as Page;
  const result = await assessInitialNavigationRecovery(page, ["example-automotive-oem.com"]);
  assert.equal(result.recoverable, false);
});
