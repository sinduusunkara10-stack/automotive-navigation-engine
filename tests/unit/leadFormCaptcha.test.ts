import { test } from "node:test";
import assert from "node:assert/strict";

import { detectCaptcha } from "../../src/forms/captcha.js";

test("captcha detection: a reCAPTCHA iframe is detected", () => {
  assert.equal(
    detectCaptcha({ iframeSrcs: ["https://www.google.com/recaptcha/api2/anchor"], elementAttributes: [], visibleText: "" }),
    true,
  );
});

test("captcha detection: a g-recaptcha div attribute is detected even with no iframe yet rendered", () => {
  assert.equal(detectCaptcha({ iframeSrcs: [], elementAttributes: ["g-recaptcha"], visibleText: "" }), true);
});

test("captcha detection: a data-sitekey attribute is detected", () => {
  assert.equal(detectCaptcha({ iframeSrcs: [], elementAttributes: ["data-sitekey"], visibleText: "" }), true);
});

test("captcha detection: human-verification text is detected", () => {
  assert.equal(detectCaptcha({ iframeSrcs: [], elementAttributes: [], visibleText: "Please verify you are human before continuing." }), true);
});

test("captcha detection: an ordinary form page reports no captcha", () => {
  assert.equal(
    detectCaptcha({ iframeSrcs: ["https://maps.google.com/embed"], elementAttributes: ["form-group"], visibleText: "Contact us" }),
    false,
  );
});
