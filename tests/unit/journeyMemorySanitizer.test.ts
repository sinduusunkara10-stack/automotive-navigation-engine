import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildSemanticSignature,
  extractAllowlistedFields,
  normalizePath,
  sanitizePageIdentity,
} from "../../src/core/journeyMemory/sanitizer.js";

test("normalizePath collapses trailing slashes and replaces numeric segments with a generic placeholder", () => {
  assert.equal(normalizePath("/configurator/12345/summary/"), "/configurator/{id}/summary");
  assert.equal(normalizePath("/"), "/");
  assert.equal(normalizePath(""), "/");
});

test("extractAllowlistedFields only extracts explicitly allowlisted param names, never a raw passthrough", () => {
  const url = new URL("https://example.com/configurator?step=3&session_id=abc123&utm_source=x&ref=y#stage=trim");
  const fields = extractAllowlistedFields(url);
  assert.deepEqual(fields, { step: "3", stage: "trim" });
  assert.equal(Object.prototype.hasOwnProperty.call(fields ?? {}, "session_id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields ?? {}, "utm_source"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(fields ?? {}, "ref"), false);
});

test("extractAllowlistedFields returns undefined when nothing allowlisted is present", () => {
  const url = new URL("https://example.com/configurator?session_id=abc123&utm_source=x");
  assert.equal(extractAllowlistedFields(url), undefined);
});

test("sanitizePageIdentity never persists the raw query string, fragment, or full page text", () => {
  const identity = sanitizePageIdentity(
    "https://example-automotive-oem.com/configurator?model=xyz&session_id=SECRET-TOKEN-123#panel=finance",
    ["Configure & Price your Vehicle", "Personalise Your Finance"],
  );
  assert.equal(identity.registrableDomain, "example-automotive-oem.com");
  assert.equal(identity.normalizedPath, "/configurator");
  assert.ok(!JSON.stringify(identity).includes("SECRET-TOKEN-123"));
  assert.ok(!JSON.stringify(identity).includes("session_id"));
  assert.ok(identity.semanticSignature.length > 0);
});

test("sanitizePageIdentity falls back gracefully on an unparseable URL, never throwing", () => {
  const identity = sanitizePageIdentity("not-a-valid-url", ["Some page"]);
  assert.equal(identity.registrableDomain, "invalid");
  assert.equal(identity.normalizedPath, "/");
});

test("buildSemanticSignature is bounded and deterministic (sorted, deduplicated tokens)", () => {
  const a = buildSemanticSignature(["Configure & Price", "Price Configure"]);
  const b = buildSemanticSignature(["Price Configure", "Configure & Price"]);
  assert.equal(a, b);
  assert.ok(a.split(" ").length <= 24);
});
