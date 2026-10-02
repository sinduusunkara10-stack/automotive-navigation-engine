import { test } from "node:test";
import assert from "node:assert/strict";

import { matchLeadFormField, detectPageLanguage } from "../../src/forms/fieldMapper.js";

test("field mapping: English labels map to the correct generic field keys", () => {
  assert.equal(matchLeadFormField({ label: "First name" }), "firstName");
  assert.equal(matchLeadFormField({ label: "Last name" }), "lastName");
  assert.equal(matchLeadFormField({ label: "Email address" }), "email");
  assert.equal(matchLeadFormField({ label: "Postcode" }), "postcode");
  assert.equal(matchLeadFormField({ label: "Mobile" }), "mobilePhone");
  assert.equal(matchLeadFormField({ label: "Landline" }), "landlinePhone");
});

test("field mapping: French labels map to the correct generic field keys", () => {
  assert.equal(matchLeadFormField({ label: "Prénom" }), "firstName");
  assert.equal(matchLeadFormField({ label: "Nom de famille" }), "lastName");
  assert.equal(matchLeadFormField({ label: "Adresse e-mail" }), "email");
  assert.equal(matchLeadFormField({ label: "Code postal" }), "postcode");
  assert.equal(matchLeadFormField({ placeholder: "Téléphone portable" }), "mobilePhone");
  assert.equal(matchLeadFormField({ placeholder: "Téléphone fixe" }), "landlinePhone");
});

test("field mapping: landline vs mobile distinguished across languages, never collapsed to the generic phone key when a specific one matches", () => {
  const landlineCases = [
    { label: "Festnetz" },
    { label: "Vaste telefoon" },
    { label: "Telefono fisso" },
    { label: "Teléfono fijo" },
  ];
  for (const hints of landlineCases) {
    assert.equal(matchLeadFormField(hints), "landlinePhone", JSON.stringify(hints));
  }
  const mobileCases = [{ label: "Handy" }, { label: "Mobiele telefoon" }, { label: "Cellulare" }, { label: "Número móvil" }];
  for (const hints of mobileCases) {
    assert.equal(matchLeadFormField(hints), "mobilePhone", JSON.stringify(hints));
  }
});

test("field mapping: an unrecognised generic phone label falls back to genericPhone", () => {
  assert.equal(matchLeadFormField({ label: "Phone number" }), "genericPhone");
});

test("field mapping: no keyword match returns undefined rather than guessing", () => {
  assert.equal(matchLeadFormField({ label: "Preferred appointment comments" }), undefined);
  assert.equal(matchLeadFormField({}), undefined);
});

test("detectPageLanguage: reads the primary subtag and falls back to English for unsupported/missing languages", () => {
  assert.equal(detectPageLanguage("fr"), "fr");
  assert.equal(detectPageLanguage("fr-FR"), "fr");
  assert.equal(detectPageLanguage("de_DE"), "de");
  assert.equal(detectPageLanguage("ja"), "en");
  assert.equal(detectPageLanguage(undefined), "en");
});
