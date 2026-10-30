import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyConsentPurpose, classifyRadioGroup, identifierTokens, resolveJourneyIntentOption, resolvePrivateCustomerOption } from "../../src/forms/radioGroupClassifier.js";

test("classifyRadioGroup: marketing-consent question text (English) classifies as marketing_consent", () => {
  const result = classifyRadioGroup(
    { questionText: "Would you like to receive marketing communications from us?", memberLabels: ["Yes", "No"] },
    "en",
  );
  assert.equal(result.classification, "marketing_consent");
});

test("classifyRadioGroup: marketing-consent vocabulary merged from fieldKeywords (partners/personalised) still classifies as marketing_consent", () => {
  const result = classifyRadioGroup(
    { questionText: "Souhaitez-vous bénéficier des offres de nos partenaires ?", memberLabels: ["Oui", "Non"] },
    "fr",
  );
  assert.equal(result.classification, "marketing_consent");
});

test("classifyRadioGroup: a question naming the private/business distinction classifies as customer_qualification", () => {
  const result = classifyRadioGroup(
    { questionText: "Are you a private individual or a business customer?", memberLabels: ["Private", "Business"] },
    "en",
  );
  assert.equal(result.classification, "customer_qualification");
});

test("classifyRadioGroup: options alone matching private+business vocabulary classify as customer_qualification even with generic question text", () => {
  const result = classifyRadioGroup({ questionText: "Please select an option", memberLabels: ["Individual", "Company"] }, "en");
  assert.equal(result.classification, "customer_qualification");
});

test("classifyRadioGroup: at least two options matching distinct journey-purpose categories classify as journey_intent", () => {
  const result = classifyRadioGroup(
    { questionText: "What would you like to do?", memberLabels: ["Request a quote", "Book a test drive"] },
    "en",
  );
  assert.equal(result.classification, "journey_intent");
});

test("classifyRadioGroup: a single purpose-keyword match on only one option is not enough to classify as journey_intent", () => {
  const result = classifyRadioGroup({ questionText: "Please select an option", memberLabels: ["Get a quote", "Something else"] }, "en");
  assert.notEqual(result.classification, "journey_intent");
});

test("classifyRadioGroup: no recognisable vocabulary anywhere classifies as ambiguous", () => {
  const result = classifyRadioGroup({ questionText: "Please choose an option", memberLabels: ["Option 1", "Option 2"] }, "en");
  assert.equal(result.classification, "ambiguous");
});

test("resolveJourneyIntentOption: resolves to the option matching the task's own objective text", () => {
  const resolution = resolveJourneyIntentOption(
    ["Request a quote", "Book a test drive"],
    { objective: "Get a price quote for the new model" },
    "en",
  );
  assert.ok(resolution);
  assert.equal(resolution?.index, 0);
});

test("resolveJourneyIntentOption: resolves to the test-drive option when the objective mentions a test drive", () => {
  const resolution = resolveJourneyIntentOption(
    ["Request a quote", "Book a test drive"],
    { activeMilestoneTexts: ["Book a test drive at a local dealer"] },
    "en",
  );
  assert.ok(resolution);
  assert.equal(resolution?.index, 1);
});

test("resolveJourneyIntentOption: returns undefined (leave unresolved) when the journey context carries no usable anchor text", () => {
  const resolution = resolveJourneyIntentOption(["Request a quote", "Book a test drive"], {}, "en");
  assert.equal(resolution, undefined);
});

test("resolveJourneyIntentOption: returns undefined (leave unresolved) when no option scores above the confidence floor", () => {
  const resolution = resolveJourneyIntentOption(["Request a quote", "Book a test drive"], { objective: "Unrelated page navigation task" }, "en");
  assert.equal(resolution, undefined);
});

test("resolvePrivateCustomerOption: selects the option matching private-customer vocabulary regardless of any workflow customer-type input", () => {
  const resolution = resolvePrivateCustomerOption(["Business", "Private individual"], "en");
  assert.ok(resolution);
  assert.equal(resolution?.index, 1);
});

test("resolvePrivateCustomerOption: returns undefined (leave unresolved) when no option matches private-customer vocabulary at all", () => {
  const resolution = resolvePrivateCustomerOption(["Type A", "Type B"], "en");
  assert.equal(resolution, undefined);
});

test("identifierTokens: camelCase, dotted and snake_case names split into words plus each adjacent pair joined", () => {
  assert.deepEqual(identifierTokens("lead.privacy.optInMkg"), ["lead", "privacy", "opt", "in", "mkg", "leadprivacy", "privacyopt", "optin", "inmkg"]);
  assert.ok(identifierTokens("consent_opt_out").includes("optout"));
  assert.deepEqual(identifierTokens(undefined), []);
});

test("classifyConsentPurpose: a camelCase opt-in name carrying a generic marketing abbreviation is optional marketing", () => {
  for (const groupName of ["privacy.optInMkg", "optInMktg", "OPT_IN_MKT", "newsletterOptIn", "consent.mktng"]) {
    const result = classifyConsentPurpose({ questionText: "", memberLabels: ["Yes", "No"], groupName });
    assert.equal(result?.purpose, "optional_marketing", groupName);
    assert.match(result!.evidence, /name_token/, groupName);
  }
});

test("classifyConsentPurpose: a promotion stem matches its inflections in any language, from a word start only", () => {
  for (const questionText of [
    "I agree to receive promotional emails",
    "Recevoir nos communications promotionnelles",
    "Ricevere comunicazioni promozionali",
    "Recibir comunicaciones promocionales",
    "Promotions and news by email",
  ]) {
    assert.equal(classifyConsentPurpose({ questionText, memberLabels: ["Yes", "No"] })?.purpose, "optional_marketing", questionText);
  }
  assert.equal(classifyConsentPurpose({ questionText: "Was the demonstration helpful to you", memberLabels: ["Yes", "No"] }), undefined, "never inside another word");
});

test("classifyConsentPurpose: a required acknowledgement bundled with a promotional purpose stays ambiguous", () => {
  const result = classifyConsentPurpose({ questionText: "I have read the privacy policy and agree to receive promotional offers", memberLabels: ["Yes", "No"] });
  assert.equal(result?.purpose, "ambiguous");
});

test("classifyRadioGroup: a Yes/No group with no purpose in its question, labels or name stays ambiguous", () => {
  const result = classifyRadioGroup({ questionText: "Please tell us your choice", memberLabels: ["Yes", "No"], groupName: "q7" }, "en");
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.purpose, "ambiguous");
});

test("classifyRadioGroup: a name that only says opt-in and terms is not turned into marketing over the terms token", () => {
  const result = classifyRadioGroup({ questionText: "", memberLabels: ["Yes", "No"], groupName: "termsAccepted" }, "en");
  assert.equal(result.purpose, "terms_and_conditions");
});
