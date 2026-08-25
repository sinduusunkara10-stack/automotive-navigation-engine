import { test } from "node:test";
import assert from "node:assert/strict";

import { computeDomainDiscovery, type DomainDiscoveryInput } from "../../src/discovery/domainDiscovery.js";
import type { CandidateAnchor } from "../../src/discovery/pageSignals.js";

function baseInput(overrides: Partial<DomainDiscoveryInput> = {}): DomainDiscoveryInput {
  return {
    startUrl: "https://www.example-automotive-oem.com/",
    finalUrl: "https://www.example-automotive-oem.com/",
    redirectChain: ["https://www.example-automotive-oem.com/"],
    anchors: [],
    objective: "Reach the configurator and complete a build.",
    ...overrides,
  };
}

test("exact start host is always trusted", () => {
  const result = computeDomainDiscovery(baseInput());
  assert.deepEqual(
    result.trustedDomains.find((d) => d.hostname === "www.example-automotive-oem.com"),
    { hostname: "www.example-automotive-oem.com", reason: "exact_start_host", sourceUrl: "https://www.example-automotive-oem.com/" },
  );
  assert.ok(result.proposedAllowedDomains.includes("www.example-automotive-oem.com"));
});

test("a same-registrable-domain subdomain found via a nav anchor is auto-trusted", () => {
  const anchors: CandidateAnchor[] = [
    { url: "https://configurator.example-automotive-oem.com/build", accessibleName: "Configurator", evidenceType: "nav_anchor" },
  ];
  const result = computeDomainDiscovery(baseInput({ anchors, objective: "Browse the site." }));
  const trusted = result.trustedDomains.find((d) => d.hostname === "configurator.example-automotive-oem.com");
  assert.ok(trusted, "expected the same-registrable-domain subdomain to be trusted");
  assert.equal(trusted?.reason, "same_registrable_domain_subdomain");
  assert.equal(trusted?.evidenceType, "nav_anchor");
  assert.equal(result.externalCandidates.length, 0);
  assert.ok(result.proposedAllowedDomains.includes("configurator.example-automotive-oem.com"));
});

test("a different registrable domain found via a visible anchor is never auto-trusted", () => {
  const anchors: CandidateAnchor[] = [
    { url: "https://www.some-ad-network.example/pixel", accessibleName: "Sponsored", evidenceType: "visible_anchor" },
  ];
  const result = computeDomainDiscovery(baseInput({ anchors, objective: "Browse the site." }));
  assert.equal(result.trustedDomains.some((d) => d.hostname === "www.some-ad-network.example"), false);
  const external = result.externalCandidates.find((c) => c.hostname === "www.some-ad-network.example");
  assert.ok(external, "expected the external-domain link to be surfaced as a candidate, not trusted");
  assert.equal(external?.registrableDomain, "some-ad-network.example");
  assert.equal(external?.evidenceType, "visible_anchor");
  assert.ok(!result.proposedAllowedDomains.includes("www.some-ad-network.example"));
});

test("an anchor whose text matches the objective is tagged objective_candidate_anchor, overriding its structural evidence type", () => {
  const anchors: CandidateAnchor[] = [
    { url: "https://configurator.example-automotive-oem.com/build", accessibleName: "Start configurator", evidenceType: "nav_anchor" },
    { url: "https://careers.example-automotive-oem.com/", accessibleName: "Careers", evidenceType: "nav_anchor" },
  ];
  const result = computeDomainDiscovery(baseInput({ anchors, objective: "Reach the configurator and complete a build." }));
  const configuratorEntry = result.trustedDomains.find((d) => d.hostname === "configurator.example-automotive-oem.com");
  assert.equal(configuratorEntry?.evidenceType, "objective_candidate_anchor");
  const careersEntry = result.trustedDomains.find((d) => d.hostname === "careers.example-automotive-oem.com");
  assert.equal(careersEntry?.evidenceType, "nav_anchor");
});

test("rejects candidates with unsupported protocols, localhost, loopback, and link-local addresses", () => {
  const anchors: CandidateAnchor[] = [
    { url: "javascript:void(0)", accessibleName: "noop", evidenceType: "visible_anchor" },
    { url: "http://localhost:9999/admin", accessibleName: "Admin", evidenceType: "visible_anchor" },
    { url: "http://127.0.0.1/internal", accessibleName: "Internal", evidenceType: "visible_anchor" },
    { url: "http://169.254.169.254/latest/meta-data", accessibleName: "Metadata", evidenceType: "visible_anchor" },
  ];
  const result = computeDomainDiscovery(baseInput({ anchors, objective: "Browse the site." }));
  assert.equal(result.rejectedCandidates.length, 4);
  const reasons = result.rejectedCandidates.map((c) => c.reason).sort();
  assert.deepEqual(reasons, ["link_local_address", "localhost", "loopback_address", "unsupported_protocol"]);
  assert.equal(result.trustedDomains.length, 1, "only the exact start host should be trusted");
  assert.equal(result.externalCandidates.length, 0);
});

test("a canonical URL on the same registrable domain is trusted; on a different one it's an external candidate", () => {
  const sameOrg = computeDomainDiscovery(
    baseInput({ canonicalUrl: "https://m.example-automotive-oem.com/", objective: "Browse the site." }),
  );
  assert.ok(sameOrg.trustedDomains.some((d) => d.hostname === "m.example-automotive-oem.com" && d.evidenceType === "canonical_url"));

  const differentOrg = computeDomainDiscovery(
    baseInput({ canonicalUrl: "https://www.a-different-brand.example/", objective: "Browse the site." }),
  );
  assert.equal(differentOrg.trustedDomains.some((d) => d.hostname === "www.a-different-brand.example"), false);
  assert.ok(differentOrg.externalCandidates.some((c) => c.hostname === "www.a-different-brand.example" && c.evidenceType === "canonical_url"));
});

test("a redirect to a different-but-safe registrable domain is trusted and becomes an additional home domain", () => {
  const result = computeDomainDiscovery(
    baseInput({
      finalUrl: "https://shop.newbrand.example/",
      redirectChain: ["https://www.example-automotive-oem.com/", "https://shop.newbrand.example/"],
      anchors: [{ url: "https://configurator.newbrand.example/", accessibleName: "Configurator", evidenceType: "nav_anchor" }],
      objective: "Browse the site.",
    }),
  );
  assert.ok(result.trustedDomains.some((d) => d.hostname === "shop.newbrand.example" && d.reason === "redirect_landing_host"));
  assert.ok(
    result.trustedDomains.some((d) => d.hostname === "configurator.newbrand.example" && d.reason === "same_registrable_domain_subdomain"),
  );
});

test("a redirect landing on an unsafe host (loopback) blocks the run and is recorded as rejected", () => {
  const result = computeDomainDiscovery(
    baseInput({
      startUrl: "https://www.example-automotive-oem.com/",
      finalUrl: "http://127.0.0.1:9999/internal",
      redirectChain: ["https://www.example-automotive-oem.com/", "http://127.0.0.1:9999/internal"],
      objective: "Browse the site.",
    }),
  );
  assert.ok(result.blockedReason);
  assert.ok(result.rejectedCandidates.some((c) => c.evidenceType === "redirect_landing_host" && c.reason === "loopback_address"));
  assert.equal(result.trustedDomains.some((d) => d.hostname === "127.0.0.1"), false);
});

test("caller-supplied allowedDomains are recorded as trusted but excluded from proposedAllowedDomains", () => {
  const result = computeDomainDiscovery(
    baseInput({ callerAllowedDomains: ["www.a-competitor.example"], objective: "Browse the site." }),
  );
  assert.ok(result.trustedDomains.some((d) => d.hostname === "www.a-competitor.example" && d.reason === "caller_supplied"));
  assert.ok(!result.proposedAllowedDomains.includes("www.a-competitor.example"));
  assert.ok(result.proposedAllowedDomains.includes("www.example-automotive-oem.com"));
});

test("the start host itself has no registrable domain (an IP) -- no subdomain expansion occurs", () => {
  const anchors: CandidateAnchor[] = [
    { url: "http://127.0.0.1:4173/other", accessibleName: "Other page", evidenceType: "visible_anchor" },
  ];
  const result = computeDomainDiscovery(
    baseInput({
      startUrl: "http://127.0.0.1:4173/start.html",
      finalUrl: "http://127.0.0.1:4173/start.html",
      redirectChain: ["http://127.0.0.1:4173/start.html"],
      anchors,
      objective: "Browse the site.",
    }),
  );
  assert.equal(result.startRegistrableDomain, null);
  // Same host as start -- trusted (it's literally the start host), but for the reason
  // that it equals the start hostname, not because of any registrable-domain expansion.
  assert.equal(result.trustedDomains.length, 1);
  assert.equal(result.trustedDomains[0]?.hostname, "127.0.0.1");
});
