import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyBusinessRequest, selectBusinessRequests } from "../../src/actions/submissionObserver.js";
import { optionPolarity } from "../../src/forms/consentGroups.js";
import { classifyConsentPurpose, classifyRadioGroup } from "../../src/forms/radioGroupClassifier.js";

const PAGE = "https://www.example-automotive-oem.com/request-a-quote";

test("classifyConsentPurpose: optional purposes from text in several languages", () => {
  assert.equal(classifyConsentPurpose({ questionText: "Je souhaite recevoir des offres commerciales", memberLabels: ["Oui", "Non"] })?.purpose, "optional_marketing");
  assert.equal(classifyConsentPurpose({ questionText: "Personalisierte Werbung auf Basis meiner Interessen", memberLabels: [] })?.purpose, "optional_profiling");
  assert.equal(classifyConsentPurpose({ questionText: "Condividere i miei dati con terzi", memberLabels: [] })?.purpose, "optional_third_party");
});

test("classifyConsentPurpose: generic group-name tokens decide when no question text exists", () => {
  assert.equal(classifyConsentPurpose({ questionText: "", memberLabels: ["Oui", "Non"], groupName: "PRIVACY_FLAG_THIRDPARTY" })?.purpose, "optional_third_party");
  assert.equal(classifyConsentPurpose({ questionText: "", memberLabels: [], groupName: "optinMktg" })?.purpose, "optional_marketing");
  assert.equal(classifyConsentPurpose({ questionText: "", memberLabels: [], groupName: "privacyFlag" }), undefined, "a bare privacy prefix is no purpose evidence");
});

test("classifyConsentPurpose: required processing and terms; bundled wording is ambiguous; substrings never match", () => {
  assert.equal(classifyConsentPurpose({ questionText: "J'ai lu la politique de confidentialité", memberLabels: [] })?.purpose, "required_privacy_processing");
  assert.equal(classifyConsentPurpose({ questionText: "Ich akzeptiere die AGB", memberLabels: [] })?.purpose, "terms_and_conditions");
  assert.equal(classifyConsentPurpose({ questionText: "I accept the privacy policy and want to receive marketing e-mails", memberLabels: [] })?.purpose, "ambiguous");
  assert.equal(classifyConsentPurpose({ questionText: "Des nombres entiers uniquement", memberLabels: [] }), undefined, "\"tiers\" inside \"entiers\" is not a third-party purpose");
});

test("classifyRadioGroup: maps purposes onto the coarse classification", () => {
  assert.equal(classifyRadioGroup({ questionText: "I have read the privacy notice", memberLabels: ["Yes", "No"] }, "en").classification, "required_consent");
  assert.equal(classifyRadioGroup({ questionText: "", memberLabels: ["Yes", "No"], groupName: "consent_partner" }, "en").classification, "marketing_consent");
});

test("optionPolarity: negative wording wins, whole words only, value attribute as fallback", () => {
  assert.equal(optionPolarity("Non", ""), "negative");
  assert.equal(optionPolarity("Nie zgadzam się", ""), "negative");
  assert.equal(optionPolarity("Je n'accepte pas", ""), "negative");
  assert.equal(optionPolarity("Oui", ""), "positive");
  assert.equal(optionPolarity("Ja, gerne", ""), "positive");
  assert.equal(optionPolarity("Innovation", ""), "unknown");
  assert.equal(optionPolarity("", "false"), "negative");
  assert.equal(optionPolarity("", "1"), "positive");
});

test("classifyBusinessRequest: tracking and third-party hosts are never the business request", () => {
  const ctx = { pageUrl: PAGE, formActionUrl: null };
  assert.equal(classifyBusinessRequest({ method: "POST", endpointPattern: "https://analytics.example-tracker.com/i/collect", resourceType: "fetch", purpose: "unknown" }, ctx).business, false);
  assert.equal(classifyBusinessRequest({ method: "POST", endpointPattern: "https://www.example-automotive-oem.com/pixel", resourceType: "ping", purpose: "unrelated_tracking" }, ctx).business, false);
  const sameSite = classifyBusinessRequest({ method: "POST", endpointPattern: "https://api.example-automotive-oem.com/leads", resourceType: "xhr", purpose: "unknown" }, ctx);
  assert.deepEqual([sameSite.business, sameSite.tier], [true, "primary"]);
});

test("classifyBusinessRequest: the form's own action host qualifies even when third-party, and a same-site read is only a secondary tier", () => {
  const viaAction = classifyBusinessRequest(
    { method: "POST", endpointPattern: "https://forms.example-lead-service.com/submit", resourceType: "document", purpose: "unknown" },
    { pageUrl: PAGE, formActionUrl: "https://forms.example-lead-service.com/submit" },
  );
  assert.equal(viaAction.tier, "primary");
  const ctx = { pageUrl: PAGE, formActionUrl: null };
  const read = { method: "GET", endpointPattern: "https://www.example-automotive-oem.com/check", resourceType: "fetch", purpose: "unknown" as const };
  const write = { method: "POST", endpointPattern: "https://www.example-automotive-oem.com/lead", resourceType: "fetch", purpose: "unknown" as const };
  const lookup = { method: "GET", endpointPattern: "https://www.example-automotive-oem.com/dealers", resourceType: "fetch", purpose: "dealer_lookup" as const };
  assert.equal(classifyBusinessRequest(read, ctx).tier, "secondary");
  assert.equal(classifyBusinessRequest(lookup, ctx).business, false);
  assert.deepEqual(selectBusinessRequests([read, write], ctx), [write]);
  assert.deepEqual(selectBusinessRequests([read], ctx), [read]);
});
