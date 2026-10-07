import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyRadioGroup, resolveJourneyIntentOption, resolvePrivateCustomerOption } from "../../src/forms/radioGroupClassifier.js";

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
