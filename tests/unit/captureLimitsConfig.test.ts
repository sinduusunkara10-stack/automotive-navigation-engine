import { test } from "node:test";
import assert from "node:assert/strict";

import {
  InvalidEvidenceRetentionLimitError,
  MAX_SCREENSHOTS_PER_RUN_DEFAULT,
  MAX_STORED_STEPS_DEFAULT,
  MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_DEFAULT,
  readMaxScreenshotsPerRun,
  readMaxStoredSteps,
  readMaxStoredInteractiveElementsPerObservation,
} from "../../src/config/captureLimits.js";

test("readMaxScreenshotsPerRun defaults when unset", () => {
  assert.equal(readMaxScreenshotsPerRun({}), MAX_SCREENSHOTS_PER_RUN_DEFAULT);
});

test("readMaxScreenshotsPerRun honours a valid override", () => {
  assert.equal(readMaxScreenshotsPerRun({ MAX_SCREENSHOTS_PER_RUN: "5" }), 5);
});

test("readMaxScreenshotsPerRun fails clearly on a non-integer value", () => {
  assert.throws(() => readMaxScreenshotsPerRun({ MAX_SCREENSHOTS_PER_RUN: "not-a-number" }), InvalidEvidenceRetentionLimitError);
});

test("readMaxScreenshotsPerRun fails clearly above its hard ceiling", () => {
  assert.throws(() => readMaxScreenshotsPerRun({ MAX_SCREENSHOTS_PER_RUN: "999999" }), InvalidEvidenceRetentionLimitError);
});

test("readMaxStoredSteps defaults when unset", () => {
  assert.equal(readMaxStoredSteps({}), MAX_STORED_STEPS_DEFAULT);
});

test("readMaxStoredSteps honours a valid override", () => {
  assert.equal(readMaxStoredSteps({ MAX_STORED_STEPS: "3" }), 3);
});

test("readMaxStoredSteps fails clearly on an invalid value", () => {
  assert.throws(() => readMaxStoredSteps({ MAX_STORED_STEPS: "-1" }), InvalidEvidenceRetentionLimitError);
});

test("readMaxStoredInteractiveElementsPerObservation defaults when unset", () => {
  assert.equal(
    readMaxStoredInteractiveElementsPerObservation({}),
    MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION_DEFAULT,
  );
});

test("readMaxStoredInteractiveElementsPerObservation honours a valid override", () => {
  assert.equal(readMaxStoredInteractiveElementsPerObservation({ MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION: "7" }), 7);
});

test("readMaxStoredInteractiveElementsPerObservation fails clearly on an invalid value", () => {
  assert.throws(
    () => readMaxStoredInteractiveElementsPerObservation({ MAX_STORED_INTERACTIVE_ELEMENTS_PER_OBSERVATION: "0" }),
    InvalidEvidenceRetentionLimitError,
  );
});
