import { test } from "node:test";
import assert from "node:assert/strict";

import { readJourneyMemoryFlags } from "../../src/config/journeyMemoryConfig.js";

/**
 * Issue 4 (feature-flag truth table, binding acceptance-issue contract): one test per row
 * of the required table. Every case constructs its own isolated env object -- never mutates
 * process.env -- so these tests can run in any order/parallel with the rest of the suite.
 */

test("row 1: ENABLED unset -> fully inert (no reads, no writes)", () => {
  const flags = readJourneyMemoryFlags({});
  assert.deepEqual(flags, { enabled: false, readEnabled: false, writeEnabled: false });
});

test("row 1b: ENABLED=false with READ/WRITE set true -> still fully inert", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "false",
    JOURNEY_MEMORY_READ_ENABLED: "true",
    JOURNEY_MEMORY_WRITE_ENABLED: "true",
  });
  assert.deepEqual(flags, { enabled: false, readEnabled: false, writeEnabled: false });
});

test("row 2: ENABLED=true, READ/WRITE unset -> both default enabled (full behaviour)", () => {
  const flags = readJourneyMemoryFlags({ JOURNEY_MEMORY_ENABLED: "true" });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: true });
});

test("row 3: ENABLED=true, READ=false, WRITE=true -> write-only", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "true",
    JOURNEY_MEMORY_READ_ENABLED: "false",
    JOURNEY_MEMORY_WRITE_ENABLED: "true",
  });
  assert.deepEqual(flags, { enabled: true, readEnabled: false, writeEnabled: true });
});

test("row 4: ENABLED=true, READ=true, WRITE=false -> read-only", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "true",
    JOURNEY_MEMORY_READ_ENABLED: "true",
    JOURNEY_MEMORY_WRITE_ENABLED: "false",
  });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: false });
});

test("row 5: ENABLED=true, READ=true(explicit default), WRITE=true(explicit default) -> full behaviour", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "true",
    JOURNEY_MEMORY_READ_ENABLED: "true",
    JOURNEY_MEMORY_WRITE_ENABLED: "true",
  });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: true });
});

test("row 6: ENABLED has an invalid value -> fails safe to fully disabled, never silently enabled", () => {
  const flags = readJourneyMemoryFlags({ JOURNEY_MEMORY_ENABLED: "yes" });
  assert.deepEqual(flags, { enabled: false, readEnabled: false, writeEnabled: false });
});

test("row 6b: ENABLED='1' is accepted (explicit truthy form)", () => {
  const flags = readJourneyMemoryFlags({ JOURNEY_MEMORY_ENABLED: "1" });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: true });
});

test("row 6c: ENABLED true but READ has an invalid value -> READ fails safe to disabled (not silently kept at its true default)", () => {
  const flags = readJourneyMemoryFlags({ JOURNEY_MEMORY_ENABLED: "true", JOURNEY_MEMORY_READ_ENABLED: "" + "1yes" });
  assert.deepEqual(flags, { enabled: true, readEnabled: false, writeEnabled: true });
});

test("row 6d: ENABLED true but WRITE is an empty-string-like invalid token -> WRITE fails safe to disabled", () => {
  // A literal empty string is treated as "unset" (uses the true default); "  " (whitespace
  // only) trims to empty too and is therefore also "unset", not "invalid" -- only a
  // non-empty, unrecognised token counts as invalid.
  const flags = readJourneyMemoryFlags({ JOURNEY_MEMORY_ENABLED: "true", JOURNEY_MEMORY_WRITE_ENABLED: "nope" });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: false });
});

test("empty-string env values are treated as unset, not invalid", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "true",
    JOURNEY_MEMORY_READ_ENABLED: "",
    JOURNEY_MEMORY_WRITE_ENABLED: "  ",
  });
  assert.deepEqual(flags, { enabled: true, readEnabled: true, writeEnabled: true });
});

test("case-insensitive and whitespace-tolerant true/false spellings are accepted", () => {
  const flags = readJourneyMemoryFlags({
    JOURNEY_MEMORY_ENABLED: "  TRUE  ",
    JOURNEY_MEMORY_READ_ENABLED: "False",
    JOURNEY_MEMORY_WRITE_ENABLED: "0",
  });
  assert.deepEqual(flags, { enabled: true, readEnabled: false, writeEnabled: false });
});
