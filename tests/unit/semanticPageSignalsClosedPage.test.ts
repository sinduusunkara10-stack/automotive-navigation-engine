import { test } from "node:test";
import assert from "node:assert/strict";
import type { Page } from "playwright";

import { gatherSemanticPageSignals, scoreSemanticPageMatch } from "../../src/core/semanticPageMatch.js";

const CLOSED_ERROR = "page.title: Target page, context or browser has been closed";

function fakePage(options: { closedFromStart: boolean; closeDuringRead: boolean }): Page {
  let closed = options.closedFromStart;
  return {
    isClosed: () => closed,
    title: async () => {
      if (options.closeDuringRead) {
        closed = true;
      }
      throw new Error(CLOSED_ERROR);
    },
  } as unknown as Page;
}

test("a page that is already closed yields empty signals instead of throwing", async () => {
  const signals = await gatherSemanticPageSignals(fakePage({ closedFromStart: true, closeDuringRead: false }), { emptyWhenClosed: true });
  assert.deepEqual(signals, { title: "", headings: [], interactiveText: [] });
  assert.equal(scoreSemanticPageMatch("Quote request form", signals, ["title", "headings", "interactiveElements"]).overall, 0, "never a match");
});

test("a page that closes while being read yields empty signals instead of throwing", async () => {
  const signals = await gatherSemanticPageSignals(fakePage({ closedFromStart: false, closeDuringRead: true }), { emptyWhenClosed: true });
  assert.deepEqual(signals, { title: "", headings: [], interactiveText: [] });
});

test("without the option, a closed page still throws (surface-relevance scoring is unchanged)", async () => {
  await assert.rejects(gatherSemanticPageSignals(fakePage({ closedFromStart: true, closeDuringRead: false })));
});

test("an error on a page that is still open is not swallowed", async () => {
  await assert.rejects(
    gatherSemanticPageSignals(fakePage({ closedFromStart: false, closeDuringRead: false }), { emptyWhenClosed: true }),
    new RegExp(CLOSED_ERROR.replace(/[.,]/g, "\\$&")),
  );
});
