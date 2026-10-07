import { test } from "node:test";
import assert from "node:assert/strict";

import { firstSelectableOption, isSelectableOption } from "../../src/forms/vehicleSelection.js";

test("isSelectableOption: rejects a disabled option even with a non-empty value", () => {
  assert.equal(isSelectableOption({ value: "a", label: "Model A", disabled: true }, "en"), false);
});

test("isSelectableOption: rejects an empty-value option", () => {
  assert.equal(isSelectableOption({ value: "", label: "Model A" }, "en"), false);
});

test("isSelectableOption: rejects a generic placeholder-wording option", () => {
  assert.equal(isSelectableOption({ value: "0", label: "Please select" }, "en"), false);
  assert.equal(isSelectableOption({ value: "0", label: "Sélectionnez" }, "fr"), false);
});

test("isSelectableOption: accepts a real option even when its label merely contains placeholder-like text as a substring", () => {
  assert.equal(isSelectableOption({ value: "select-edition", label: "Select Edition" }, "en"), true);
});

test("isSelectableOption: accepts an ordinary enabled, non-empty, non-placeholder option", () => {
  assert.equal(isSelectableOption({ value: "a", label: "Model A" }, "en"), true);
});

test("firstSelectableOption: skips a leading disabled placeholder and returns the first real option", () => {
  const options = [
    { value: "", label: "Please select", disabled: true },
    { value: "a", label: "Model A" },
    { value: "b", label: "Model B" },
  ];
  const result = firstSelectableOption(options, "en");
  assert.equal(result?.value, "a");
});

test("firstSelectableOption: returns undefined when no option is selectable", () => {
  const options = [{ value: "", label: "Please select", disabled: true }];
  assert.equal(firstSelectableOption(options, "en"), undefined);
});
