import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeHost, isSameRegistrableDomain } from "../../src/discovery/registrableDomain.js";

test("analyzeHost resolves a simple two-label registrable domain", () => {
  const result = analyzeHost("configurator.example-automotive-oem.com");
  assert.equal(result.registrableDomain, "example-automotive-oem.com");
  assert.equal(result.isIp, false);
});

test("analyzeHost resolves a multi-label public suffix (PSL-backed, not last-two-labels string splitting)", () => {
  // "co.uk" is a multi-label public suffix -- a naive last-two-labels split would wrongly
  // report "co.uk" as the registrable domain here.
  const result = analyzeHost("shop.example.co.uk");
  assert.equal(result.registrableDomain, "example.co.uk");
});

test("analyzeHost reports no registrable domain for a bare IP", () => {
  const result = analyzeHost("127.0.0.1");
  assert.equal(result.registrableDomain, null);
  assert.equal(result.isIp, true);
});

test("analyzeHost reports no registrable domain for localhost", () => {
  const result = analyzeHost("localhost");
  assert.equal(result.registrableDomain, null);
});

test("isSameRegistrableDomain is true for sibling subdomains", () => {
  assert.equal(isSameRegistrableDomain("www.example.com", "configurator.example.com"), true);
  assert.equal(isSameRegistrableDomain("example.com", "deep.nested.example.com"), true);
});

test("isSameRegistrableDomain is false across different registrable domains", () => {
  assert.equal(isSameRegistrableDomain("www.example.com", "www.example.net"), false);
});

test("isSameRegistrableDomain is false when either side has no registrable domain, even if textually identical", () => {
  assert.equal(isSameRegistrableDomain("127.0.0.1", "127.0.0.1"), false);
  assert.equal(isSameRegistrableDomain("localhost", "localhost"), false);
});
