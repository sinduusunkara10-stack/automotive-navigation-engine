import { test } from "node:test";
import assert from "node:assert/strict";
import { isPhoneFieldKey, normalisePhoneForInput } from "../../src/forms/phoneFormat.js";
import { SUPPORTED_MARKETS, marketDataFor } from "../../src/forms/testData.js";

test("normalisePhoneForInput: strips presentation spaces from a national number", () => {
  assert.equal(normalisePhoneForInput("06 39 98 12 34"), "0639981234");
});

test("normalisePhoneForInput: keeps the leading + of an international number", () => {
  assert.equal(normalisePhoneForInput("+33 6 39 98 12 34"), "+33639981234");
});

test("normalisePhoneForInput: already-normalised numbers are unchanged", () => {
  assert.equal(normalisePhoneForInput("0639981234"), "0639981234");
  assert.equal(normalisePhoneForInput("+33639981234"), "+33639981234");
});

test("normalisePhoneForInput: other common separators and non-breaking spaces are removed", () => {
  assert.equal(normalisePhoneForInput("06.39.98.12.34"), "0639981234");
  assert.equal(normalisePhoneForInput("06-39-98-12-34"), "0639981234");
  assert.equal(normalisePhoneForInput("(030) 23125/123"), "03023125123");
  assert.equal(normalisePhoneForInput("+33 6 39 98 12 34"), "+33639981234");
  assert.equal(normalisePhoneForInput("  0639981234 "), "0639981234");
});

test("normalisePhoneForInput: values that are not plain phone numbers are returned untouched", () => {
  for (const value of ["SW1A 1AA", "Test", "test@test.com", "06 39 98 12 34 ext 5", "+33 +6 39", "", "   "]) {
    assert.equal(normalisePhoneForInput(value), value);
  }
});

test("normalisePhoneForInput: every configured market phone value reduces to digits with an optional leading +", () => {
  for (const market of SUPPORTED_MARKETS) {
    const data = marketDataFor(market);
    for (const raw of [data.landlineNational, data.mobileNational]) {
      const out = normalisePhoneForInput(raw);
      assert.match(out, /^0?\d+$/, `${market} national ${raw}`);
      assert.equal(out, raw.replace(/\s/g, ""), `${market} national ${raw}`);
    }
    for (const raw of [data.landlineInternational, data.mobileInternational]) {
      const out = normalisePhoneForInput(raw);
      assert.match(out, /^\+\d+$/, `${market} international ${raw}`);
      assert.equal(out, raw.replace(/\s/g, ""), `${market} international ${raw}`);
    }
  }
});

test("isPhoneFieldKey: only the phone field purposes are normalised", () => {
  for (const key of ["landlinePhone", "mobilePhone", "genericPhone"]) {
    assert.equal(isPhoneFieldKey(key), true, key);
  }
  for (const key of ["firstName", "lastName", "email", "postcode", "genericRequiredText", "dealerSearch", "title"]) {
    assert.equal(isPhoneFieldKey(key), false, key);
  }
});
