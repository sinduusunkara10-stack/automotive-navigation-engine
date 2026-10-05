import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveMarket, marketDataFor, phoneValueFor, titleFor, FIXED_FIELDS } from "../../src/forms/testData.js";

test("market data selection: an explicit market hint always wins over the language default", () => {
  assert.equal(resolveMarket("fr", "BE"), "BE");
  assert.equal(resolveMarket("de", "AT"), "AT");
  assert.equal(resolveMarket("nl", "LU"), "LU");
});

test("market data selection: an unsupported explicit market falls back to the language default", () => {
  assert.equal(resolveMarket("fr", "ZZ"), "FR");
});

test("market data selection: no hint falls back to the one-market-per-language default", () => {
  assert.equal(resolveMarket("en"), "UK");
  assert.equal(resolveMarket("fr"), "FR");
  assert.equal(resolveMarket("de"), "DE");
  assert.equal(resolveMarket("pt"), "PT");
});

test("per-market postcode/phone fixed data matches the approved values (UK, FR, DE)", () => {
  assert.equal(marketDataFor("UK").postcode, "SW1A 1AA");
  assert.equal(phoneValueFor("UK", "mobile", false), "+44 7700 900123");
  assert.equal(phoneValueFor("UK", "mobile", true), "07700 900123");
  assert.equal(phoneValueFor("UK", "landline", false), "+44 20 7946 0123");

  assert.equal(marketDataFor("FR").postcode, "75001");
  assert.equal(phoneValueFor("FR", "mobile", true), "06 39 98 12 34");
  assert.equal(phoneValueFor("FR", "mobile", false), "+33 6 39 98 12 34");

  assert.equal(marketDataFor("DE").postcode, "10115");
  assert.equal(phoneValueFor("DE", "landline", true), "030 23125 123");
});

test("title selection is keyed by page language, per the approved per-language title list", () => {
  assert.equal(titleFor("en"), "Ms");
  assert.equal(titleFor("fr"), "Mme");
  assert.equal(titleFor("de"), "Frau");
  assert.equal(titleFor("nl"), "Mevr.");
  assert.equal(titleFor("it"), "Sig.ra");
  assert.equal(titleFor("es"), "Sra.");
  assert.equal(titleFor("pl"), "Pani");
  assert.equal(titleFor("pt"), "Sra.");
});

test("fixed free-text fields match the approved values exactly", () => {
  assert.equal(FIXED_FIELDS.firstName, "Test");
  assert.equal(FIXED_FIELDS.lastName, "Test");
  assert.equal(FIXED_FIELDS.email, "test@test.com");
  assert.equal(FIXED_FIELDS.genericRequiredText, "Test");
});
