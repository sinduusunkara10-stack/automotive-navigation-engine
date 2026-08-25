import { test } from "node:test";
import assert from "node:assert/strict";

import { assessUrlSafety, isSafeUrl } from "../../src/discovery/hostSafety.js";

test("accepts a normal https URL", () => {
  assert.deepEqual(assessUrlSafety("https://www.example.com/path"), { safe: true });
});

test("accepts a normal http URL", () => {
  assert.deepEqual(assessUrlSafety("http://www.example.com/"), { safe: true });
});

test("rejects an unparseable URL", () => {
  assert.equal(assessUrlSafety("not a url").reason, "unparseable_url");
});

for (const protocol of ["mailto:someone@example.com", "tel:+15551234567", "javascript:alert(1)", "ftp://example.com/file", "data:text/html,hi"]) {
  test(`rejects unsupported protocol: ${protocol}`, () => {
    assert.equal(assessUrlSafety(protocol).reason, "unsupported_protocol");
  });
}

test("rejects localhost", () => {
  assert.equal(assessUrlSafety("http://localhost:3000/").reason, "localhost");
  assert.equal(assessUrlSafety("http://api.localhost/").reason, "localhost");
});

test("rejects loopback IPv4 and IPv6", () => {
  assert.equal(assessUrlSafety("http://127.0.0.1/").reason, "loopback_address");
  assert.equal(assessUrlSafety("http://127.5.5.5/").reason, "loopback_address");
  assert.equal(assessUrlSafety("http://[::1]/").reason, "loopback_address");
});

test("rejects link-local IPv4 and IPv6", () => {
  assert.equal(assessUrlSafety("http://169.254.169.254/latest/meta-data").reason, "link_local_address");
  assert.equal(assessUrlSafety("http://[fe80::1]/").reason, "link_local_address");
});

test("allowLoopbackAndLinkLocal exempts loopback/localhost/link-local but never the protocol check", () => {
  assert.equal(isSafeUrl("http://127.0.0.1:4173/start.html", { allowLoopbackAndLinkLocal: true }), true);
  assert.equal(isSafeUrl("http://localhost:4173/start.html", { allowLoopbackAndLinkLocal: true }), true);
  assert.equal(isSafeUrl("http://169.254.169.254/", { allowLoopbackAndLinkLocal: true }), true);
  assert.equal(isSafeUrl("javascript:alert(1)", { allowLoopbackAndLinkLocal: true }), false);
});

test("a normal external host is unaffected by allowLoopbackAndLinkLocal", () => {
  assert.equal(isSafeUrl("https://www.example.com/", { allowLoopbackAndLinkLocal: true }), true);
});
