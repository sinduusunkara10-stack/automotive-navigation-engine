import { test } from "node:test";
import assert from "node:assert/strict";
import { isPhoneFieldKey, normalisePhoneForInput, phoneValueForField } from "../../src/forms/phoneFormat.js";
import { SUPPORTED_MARKETS, marketDataFor } from "../../src/forms/testData.js";

const PHONE_KINDS = ["landlineNational", "landlineInternational", "mobileNational", "mobileInternational"] as const;

for (const market of SUPPORTED_MARKETS) {
  for (const kind of PHONE_KINDS) {
    const configured = marketDataFor(market)[kind];
    const expected = configured.replace(/\s/g, "");
    test(`normalisePhoneForInput: ${market} ${kind} "${configured}" -> "${expected}"`, () => {
      assert.equal(normalisePhoneForInput(configured), expected);
      assert.match(expected, kind.endsWith("International") ? /^\+\d+$/ : /^\d+$/);
      assert.equal(normalisePhoneForInput(expected), expected, "already compact stays unchanged");
      assert.equal(phoneValueForField(configured), expected, "unconstrained field gets the compact form");
    });
  }
}

const FORMATTED_CASES: Array<[string, string]> = [
  ["06 39 98 12 34", "0639981234"],
  ["+33 6 39 98 12 34", "+33639981234"],
  ["0639981234", "0639981234"],
  ["+33639981234", "+33639981234"],
  ["06.39.98.12.34", "0639981234"],
  ["06-39-98-12-34", "0639981234"],
  ["(030) 23125/123", "03023125123"],
  ["+33 6 39 98 12 34", "+33639981234"],
  ["  0639981234 ", "0639981234"],
];
for (const [input, expected] of FORMATTED_CASES) {
  test(`normalisePhoneForInput: ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
    assert.equal(normalisePhoneForInput(input), expected);
  });
}

for (const unsafe of ["SW1A 1AA", "Test", "test@test.com", "06 39 98 12 34 ext 5", "+33 +6 39", "0033 6 39 98 12 34 x", "", "   ", "abc-def"]) {
  test(`normalisePhoneForInput: non-phone value ${JSON.stringify(unsafe)} is returned unchanged`, () => {
    assert.equal(normalisePhoneForInput(unsafe), unsafe);
    assert.equal(phoneValueForField(unsafe, { pattern: "\\d+" }), unsafe);
  });
}

test("phoneValueForField: a pattern that demands the formatted form keeps the configured value", () => {
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "\\d{2}( \\d{2}){4}" }), "06 39 98 12 34");
  assert.equal(phoneValueForField("+44 7700 900123", { pattern: "\\+44 \\d{4} \\d{6}" }), "+44 7700 900123");
});

test("phoneValueForField: a pattern accepting the compact form gets the compact form", () => {
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "0[1-9][0-9]{8}" }), "0639981234");
  assert.equal(phoneValueForField("+33 6 39 98 12 34", { pattern: "\\+?[0-9]{9,15}" }), "+33639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "[0-9 ]+" }), "0639981234");
});

test("phoneValueForField: maxlength/minlength choose the form that fits", () => {
  assert.equal(phoneValueForField("06 39 98 12 34", { maxLength: 10 }), "0639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { maxLength: -1, minLength: -1 }), "0639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { minLength: 14 }), "06 39 98 12 34");
});

test("phoneValueForField: compact form wins when neither form satisfies the constraints, or the pattern is invalid", () => {
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "[a-z]+" }), "0639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "([" }), "0639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: "" }), "0639981234");
  assert.equal(phoneValueForField("06 39 98 12 34", { pattern: null }), "0639981234");
});

test("isPhoneFieldKey: only the phone field purposes are normalised", () => {
  for (const key of ["landlinePhone", "mobilePhone", "genericPhone"]) {
    assert.equal(isPhoneFieldKey(key), true, key);
  }
  for (const key of ["firstName", "lastName", "email", "postcode", "genericRequiredText", "dealerSearch", "title", "claude_resolved", ""]) {
    assert.equal(isPhoneFieldKey(key), false, key);
  }
});
