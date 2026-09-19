import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN, decideSurfaceAdoption } from "../../src/core/surfaceAdoption.js";

/**
 * Surface adoption (Phase 3 PR 3, see CLAUDE.md and docs/architecture.md "Surface
 * adoption"): pure-logic coverage of decideSurfaceAdoption's four required cases (flag off,
 * flag on + domain allowed, flag on + domain rejected, budget exhausted) plus the
 * "extend_trust_from_landing" policy and the unparseable/never-loaded popup URL edge case --
 * no browser, no Page, matching this repo's existing convention for fast unit coverage of
 * core-loop decision logic (e.g. tests/unit/validateClaudeDecision.test.ts).
 */

const ALLOWED = ["127.0.0.1"];

test("flag off: never adopted, regardless of domain or budget", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: false,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: false, reason: "adoption_disabled" });
});

test("flag on + domain allowed (require_allowed_domain, the default): adopted", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1:1234/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: true });
});

test("flag on + domain rejected (require_allowed_domain): never adopted", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: "require_allowed_domain",
    popupUrl: "http://localhost:1234/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: false, reason: "domain_rejected" });
});

test("budget exhausted: rejected even though the domain is allowed", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 5,
    maxAdoptedSurfacesPerRun: 5,
  });
  assert.deepEqual(decision, { adopt: false, reason: "budget_exhausted" });
});

test("budget check uses the engine default (5) when maxAdoptedSurfacesPerRun is omitted", () => {
  const atDefault = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(atDefault, { adopt: false, reason: "budget_exhausted" });

  const underDefault = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN - 1,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(underDefault, { adopt: true });
});

test('a task-configured maxAdoptedSurfacesPerRun narrower than the default is honoured', () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 1,
    maxAdoptedSurfacesPerRun: 1,
  });
  assert.deepEqual(decision, { adopt: false, reason: "budget_exhausted" });
});

test('extend_trust_from_landing: a landing domain outside allowedDomains is adopted, and the extension names that exact hostname', () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: "extend_trust_from_landing",
    popupUrl: "http://localhost:1234/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: true, extendedAllowedDomain: "localhost" });
});

test("extend_trust_from_landing: a landing domain already inside allowedDomains is adopted without an extension (nothing new to trust)", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: "extend_trust_from_landing",
    popupUrl: "http://127.0.0.1/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: true });
});

test("extend_trust_from_landing still respects the per-run budget", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: "extend_trust_from_landing",
    popupUrl: "http://localhost:1234/target.html",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 5,
    maxAdoptedSurfacesPerRun: 5,
  });
  assert.deepEqual(decision, { adopt: false, reason: "budget_exhausted" });
});

test("a popup with no verifiable landing URL is never adopted under either policy", () => {
  for (const domainPolicy of ["require_allowed_domain", "extend_trust_from_landing"] as const) {
    const decision = decideSurfaceAdoption({
      allowSurfaceAdoption: true,
      domainPolicy,
      popupUrl: undefined,
      allowedDomains: ALLOWED,
      adoptedSurfaceCount: 0,
      maxAdoptedSurfacesPerRun: undefined,
    });
    assert.deepEqual(decision, { adopt: false, reason: "domain_rejected" }, `policy ${domainPolicy}`);
  }
});

test("an unparseable popup URL is never adopted", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "not a url at all",
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: false, reason: "domain_rejected" });
});

test("budget is checked before the domain policy: an exhausted budget rejects even an otherwise-allowed domain without needing a valid popupUrl", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: undefined,
    allowedDomains: ALLOWED,
    adoptedSurfaceCount: DEFAULT_MAX_ADOPTED_SURFACES_PER_RUN,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: false, reason: "budget_exhausted" });
});

test("a subdomain of an allowed domain is treated as allowed (isAllowedHost's existing suffix rule)", () => {
  const decision = decideSurfaceAdoption({
    allowSurfaceAdoption: true,
    domainPolicy: undefined,
    popupUrl: "https://offers.example-competitor-oem.com/deal",
    allowedDomains: ["example-competitor-oem.com"],
    adoptedSurfaceCount: 0,
    maxAdoptedSurfacesPerRun: undefined,
  });
  assert.deepEqual(decision, { adopt: true });
});
