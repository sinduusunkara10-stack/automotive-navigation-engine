import { test } from "node:test";
import assert from "node:assert/strict";

import { planField, type FormFieldDescriptor, type FillPlanContext } from "../../src/forms/fillPlan.js";

const CTX: FillPlanContext = { language: "en", market: "UK", hasCountryCodeSelector: false };

function field(overrides: Partial<FormFieldDescriptor>): FormFieldDescriptor {
  return {
    id: "0",
    tagName: "input",
    required: true,
    visible: true,
    currentValue: "",
    ...overrides,
  };
}

test("fill rules: a pre-filled text field is left untouched (skip, prefilled)", () => {
  const result = planField(field({ label: "Email", currentValue: "already@set.com" }), CTX);
  assert.deepEqual(result.decision, { kind: "skip", reason: "prefilled" });
});

test("fill rules: a pre-checked checkbox is left untouched (skip, prefilled)", () => {
  const result = planField(field({ type: "checkbox", label: "Stay in touch", currentValue: "true" }), CTX);
  assert.deepEqual(result.decision, { kind: "skip", reason: "prefilled" });
});

test("fill rules: a hidden field is never filled, even if required (skip, hidden) -- honeypot protection", () => {
  const result = planField(field({ label: "Email", visible: false, type: "hidden" }), CTX);
  assert.deepEqual(result.decision, { kind: "skip", reason: "hidden" });
  const invisible = planField(field({ label: "Email", visible: false }), CTX);
  assert.deepEqual(invisible.decision, { kind: "skip", reason: "hidden" });
});

test("fill rules: an optional (non-required) field is left blank even when mapped", () => {
  const result = planField(field({ label: "First name", required: false }), CTX);
  assert.deepEqual(result.decision, { kind: "skip", reason: "optional" });
});

test("fill rules: required mapped text fields resolve to the fixed test-data value", () => {
  assert.deepEqual(planField(field({ label: "First name" }), CTX).decision, { kind: "fill_text", field: "firstName", value: "Test" });
  assert.deepEqual(planField(field({ label: "Last name" }), CTX).decision, { kind: "fill_text", field: "lastName", value: "Test" });
  assert.deepEqual(planField(field({ label: "Email" }), CTX).decision, { kind: "fill_text", field: "email", value: "test@test.com" });
  assert.deepEqual(planField(field({ label: "Postcode" }), CTX).decision, { kind: "fill_text", field: "postcode", value: "SW1A 1AA" });
});

test("fill rules: a required marketing-consent checkbox is ticked; an optional one is left unchecked", () => {
  const requiredConsent = planField(field({ type: "checkbox", label: "Stay in touch", required: true }), CTX);
  assert.deepEqual(requiredConsent.decision, { kind: "tick_checkbox" });

  const optionalConsent = planField(field({ type: "checkbox", label: "Stay in touch", required: false }), CTX);
  assert.deepEqual(optionalConsent.decision, { kind: "skip", reason: "optional" });
});

test("fill rules: an unset marketing-consent select defaults to the localized negative option", () => {
  const result = planField(
    field({
      tagName: "select",
      label: "Personalised offers",
      options: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
    }),
    CTX,
  );
  assert.deepEqual(result.decision, { kind: "select_negative_option" });
});

test("fill rules: a required yes/no dropdown with no explicit mapping (e.g. company car) defaults to its negative option", () => {
  const result = planField(
    field({
      tagName: "select",
      label: "Do you have a company car?",
      options: [
        { value: "y", label: "Yes" },
        { value: "n", label: "No" },
      ],
    }),
    CTX,
  );
  assert.deepEqual(result.decision, { kind: "select_negative_option" });
});

test("fill rules: a required dropdown with no negative option (e.g. enquiry type, dealer) chooses the first valid option", () => {
  const result = planField(
    field({
      tagName: "select",
      label: "Enquiry type",
      options: [
        { value: "", label: "Please select" },
        { value: "general", label: "General enquiry" },
        { value: "test_drive", label: "Test drive" },
      ],
    }),
    CTX,
  );
  assert.deepEqual(result.decision, { kind: "choose_first_valid_option" });
});

test("fill rules: a dealer-search field is filled with the market postcode and flagged for the search flow", () => {
  const result = planField(field({ label: "Find a dealer (postcode or city)" }), CTX);
  assert.deepEqual(result.decision, { kind: "dealer_search", postcode: "SW1A 1AA" });
});

test("fill rules: a plainly-labelled postcode field is upgraded to dealer_search when IT SPECIFICALLY has a structurally-adjacent lookup control", () => {
  const withTrigger = field({ label: "Postcode", dealerLookupTriggerIndex: "trigger-0" });
  const result = planField(withTrigger, CTX);
  assert.deepEqual(result, {
    descriptor: withTrigger,
    matchedField: "dealerSearch",
    decision: { kind: "dealer_search", postcode: "SW1A 1AA", triggerIndex: "trigger-0" },
  });
});

test("fill rules: a plainly-labelled postcode field stays a plain fill_text when it has no structurally-adjacent lookup control", () => {
  const result = planField(field({ label: "Postcode" }), CTX);
  assert.deepEqual(result.decision, { kind: "fill_text", field: "postcode", value: "SW1A 1AA" });
});

test("fill rules: two postcode-purpose fields on the same form are judged independently -- only the one with its own adjacent lookup control is upgraded", () => {
  const customerPostcode = field({ id: "0", label: "Code postal" });
  const dealerPostcode = field({ id: "1", label: "CP ou ville", dealerLookupTriggerIndex: "trigger-3" });
  assert.deepEqual(planField(customerPostcode, CTX).decision, { kind: "fill_text", field: "postcode", value: "SW1A 1AA" });
  assert.deepEqual(planField(dealerPostcode, CTX).decision, { kind: "dealer_search", postcode: "SW1A 1AA", triggerIndex: "trigger-3" });
});

test("fill rules: landline vs mobile use the right per-market value, national vs international by country-code-selector presence", () => {
  const mobileIntl = planField(field({ label: "Mobile" }), CTX);
  assert.deepEqual(mobileIntl.decision, { kind: "fill_text", field: "mobilePhone", value: "+44 7700 900123" });

  const withSelector: FillPlanContext = { ...CTX, hasCountryCodeSelector: true };
  const mobileNational = planField(field({ label: "Mobile" }), withSelector);
  assert.deepEqual(mobileNational.decision, { kind: "fill_text", field: "mobilePhone", value: "07700 900123" });
});

test("fill rules: an unmapped required free-text field needs the one optional Claude call", () => {
  const result = planField(field({ label: "Preferred callback time" }), CTX);
  assert.deepEqual(result.decision, { kind: "needs_claude" });
});
