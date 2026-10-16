import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeXmlStructure, classifyRequestPurpose, isLookupLikePurpose } from "../../src/actions/dealerLookupNetwork.js";
import { detectHiddenCommit } from "../../src/actions/dealerLookupProbe.js";

function classify(overrides: Partial<Parameters<typeof classifyRequestPurpose>[0]>) {
  return classifyRequestPurpose({
    endpointPattern: "https://www.example-automotive-oem.com/api/unknown",
    resourceType: "xhr",
    status: 200,
    contentType: "application/json",
    resultCategory: "unknown",
    structureElementNames: [],
    xmlRootElement: null,
    ...overrides,
  });
}

test("analyzeXmlStructure: repeated non-leaf records under the root are counted, names only", () => {
  const result = analyzeXmlStructure('<?xml version="1.0"?><dealers><dealer><name>Garage Alpha</name><id>DLR-1</id></dealer><dealer><name>Garage Beta</name><id>DLR-2</id></dealer></dealers>');
  assert.equal(result.root, "dealers");
  assert.equal(result.recordCount, 2);
  assert.ok(result.recurringNames.includes("dealer"));
  assert.equal(JSON.stringify(result).includes("Garage"), false, "element text must never leak into structure evidence");
  assert.equal(JSON.stringify(result).includes("DLR-1"), false);
});

test("analyzeXmlStructure: records under a single wrapper element are counted", () => {
  const result = analyzeXmlStructure("<response><results><item><k>1</k></item><item><k>2</k></item><item><k>3</k></item></results></response>");
  assert.equal(result.root, "response");
  assert.equal(result.recordCount, 3);
});

test("analyzeXmlStructure: an empty root, or a lone leaf status element, is never a record", () => {
  assert.equal(analyzeXmlStructure("<dealers/>").recordCount, 0);
  assert.equal(analyzeXmlStructure("<dealers></dealers>").recordCount, 0);
  const statusOnly = analyzeXmlStructure("<response><message>no records</message></response>");
  assert.equal(statusOnly.recordCount, 0);
  assert.equal(statusOnly.errorSignal, false);
});

test("analyzeXmlStructure: an error/fault element with no records is an error signal", () => {
  assert.equal(analyzeXmlStructure('<response><error code="E1"/></response>').errorSignal, true);
  assert.equal(analyzeXmlStructure("<soap:Envelope><soap:Body><soap:Fault><faultcode>x</faultcode></soap:Fault></soap:Body></soap:Envelope>").errorSignal, true);
});

test("classifyRequestPurpose: tracking transport, status classes and generic path vocabulary, never a brand endpoint name", () => {
  assert.equal(classify({ resourceType: "image", contentType: "image/gif" }).purpose, "unrelated_tracking");
  assert.equal(classify({ endpointPattern: "https://cdn.example-tracker.com/log/unip", status: 204 }).purpose, "unrelated_tracking");
  assert.equal(classify({ status: 503 }).purpose, "server_error");
  assert.equal(classify({ status: 422 }).purpose, "validation_error");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/services/emailvalidation" }).purpose, "email_validation");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/api/dealers/search", resultCategory: "records" }).purpose, "dealer_results");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/api/dealers/search", resultCategory: "empty" }).purpose, "empty_results");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/geo/autocomplete", resultCategory: "records" }).purpose, "location_results");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/api/form/config", resultCategory: "empty" }).purpose, "form_configuration");
});

test("classifyRequestPurpose: an undecidable path stays 'unknown' unless its own structure says empty or carries record names", () => {
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/services/getdata", resultCategory: "records" }).purpose, "unknown");
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/services/getdata", resultCategory: "empty" }).purpose, "empty_results");
  assert.equal(
    classify({ endpointPattern: "https://www.example-automotive-oem.com/services/getdata", resultCategory: "records", structureElementNames: ["outlet"], xmlRootElement: "outlets" }).purpose,
    "dealer_results",
  );
  assert.equal(classify({ endpointPattern: "https://www.example-automotive-oem.com/services/getdata", resultCategory: "error" }).purpose, "validation_error");
});

test("classifyRequestPurpose: short tracking words only match a whole path token", () => {
  assert.notEqual(classify({ endpointPattern: "https://www.example-automotive-oem.com/catalog/models" }).purpose, "unrelated_tracking");
  assert.notEqual(classify({ endpointPattern: "https://www.example-automotive-oem.com/login" }).purpose, "unrelated_tracking");
});

test("isLookupLikePurpose: tracking, email validation and configuration never count as lookup activity", () => {
  assert.equal(isLookupLikePurpose("unrelated_tracking"), false);
  assert.equal(isLookupLikePurpose("email_validation"), false);
  assert.equal(isLookupLikePurpose("form_configuration"), false);
  assert.equal(isLookupLikePurpose("unknown"), true);
  assert.equal(isLookupLikePurpose("location_lookup"), true);
});

test("detectHiddenCommit: keyed comparison survives an inserted hidden input, and unrelated plumbing never counts", () => {
  const before = [
    { key: "h0", nonEmpty: false, purpose: "dealer_identifier" as const },
    { key: "h1", nonEmpty: false, purpose: "unrelated" as const },
  ];
  const insertedPlusCommit = [
    { key: "h0", nonEmpty: true, purpose: "dealer_identifier" as const },
    { key: "h1", nonEmpty: false, purpose: "unrelated" as const },
    { key: "h2", nonEmpty: true, purpose: "unclassified" as const },
  ];
  assert.deepEqual(detectHiddenCommit(before, insertedPlusCommit), { committed: true, purposes: ["dealer_identifier"] });

  const onlyTokenChanged = [
    { key: "h0", nonEmpty: false, purpose: "dealer_identifier" as const },
    { key: "h1", nonEmpty: true, purpose: "unrelated" as const },
  ];
  assert.equal(detectHiddenCommit(before, onlyTokenChanged).committed, false);

  const insertedUnclassified = [...before, { key: "h2", nonEmpty: true, purpose: "unclassified" as const }];
  assert.equal(detectHiddenCommit(before, insertedUnclassified).committed, false, "an inserted, already-populated hidden input counts only when it is semantically a dealer/location identifier");

  const insertedDealer = [...before, { key: "h2", nonEmpty: true, purpose: "dealer_identifier" as const }];
  assert.equal(detectHiddenCommit(before, insertedDealer).committed, true);
});
