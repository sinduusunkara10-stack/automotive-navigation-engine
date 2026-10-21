import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page, type Route } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import type { SubmissionObservationConfig } from "../../src/actions/submissionObserver.js";
import { discoverConsentGroups, type ConsentGroupMember } from "../../src/forms/consentGroups.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");

const FAST: SubmissionObservationConfig = { baseWindowMs: 1_500, extensionMs: 1_000, hardCapMs: 3_000, pollIntervalMs: 100 };
const OPTIONAL = ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY", "PRIVACY_FLAG_PRFL", "PRIVACY_FLAG_SMS", "PRIVACY_FLAG_PARTNERS_EMAIL"];

type Query = Record<string, string>;

interface Outcome {
  result: Awaited<ReturnType<typeof executeFillForm>>;
  page: Page;
  businessHits: number;
  submitCount: number;
  checked: Record<string, { value: string; id: string } | null>;
}

async function withPage<T>(query: Query, body: (page: Page, hits: () => number) => Promise<T>): Promise<T> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let businessHits = 0;
    await page.route("**/api/lead", async (route: Route) => {
      businessHits += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" }).catch(() => {});
    });
    await page.goto(`${baseUrl}/lead-form-consent-actionability.html?${new URLSearchParams(query).toString()}`);
    return await body(page, () => businessHits);
  } finally {
    await browser?.close();
    await close();
  }
}

async function run<T>(query: Query, flag: boolean, check: (outcome: Outcome) => Promise<T> | T): Promise<T> {
  return withPage(query, async (page, hits) => {
    const result = await executeFillForm({
      page,
      action: { type: "fill_form" },
      captures: {},
      stepIndex: 1,
      captureModules: [],
      submissionObservationConfig: FAST,
      optionalConsentOptInFallbackForTest: flag,
    });
    const state = await page.evaluate(() => {
      const checked: Record<string, { value: string; id: string } | null> = {};
      Array.from(document.querySelectorAll('input[type="radio"]')).forEach((el) => {
        const radio = el as HTMLInputElement;
        if (!(radio.name in checked)) checked[radio.name] = null;
        if (radio.checked) checked[radio.name] = { value: radio.value, id: radio.id };
      });
      return { checked, submitCount: (window as unknown as { __submitCount: number }).__submitCount };
    });
    return check({ result, page, businessHits: hits(), submitCount: state.submitCount, checked: state.checked });
  });
}

const optionalDiagnostics = (result: Outcome["result"]) => (result.formConsentDiagnostics?.consentGroupDiagnostics ?? []).filter((g) => OPTIONAL.includes(g.groupId));
const optionalRejections = (result: Outcome["result"]) => (result.formConsentDiagnostics?.consentGroupRejections ?? []).filter((g) => OPTIONAL.includes(g.groupId));

function assertDeclined(outcome: Outcome, groups = ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY"]) {
  const diagnostics = optionalDiagnostics(outcome.result);
  assert.deepEqual(diagnostics.map((g) => g.groupId).sort(), [...groups].sort());
  for (const group of diagnostics) {
    assert.equal(group.checkedStateVerified, true, group.groupId);
    assert.equal(group.checkedAfter, "negative", group.groupId);
    assert.equal(group.activation?.verificationResult, "verified", group.groupId);
  }
  for (const name of groups) assert.equal(outcome.checked[name]?.value, "0", name);
}

test("actionability 1: a hidden (display:none) native input with a visible label is actionable through the label", async () => {
  await run({ style: "hidden_input" }, false, (outcome) => {
    assertDeclined(outcome);
    for (const group of optionalDiagnostics(outcome.result)) {
      assert.equal(group.activation?.actionableSurface, "label");
      assert.equal(group.activation?.attempts.some((a) => a.clickedElementType === "native_input"), false);
    }
  });
});

test("actionability 2: an off-screen native input (left:-9999px) with an on-screen label is never pointer-clicked; the label commits the decline", async () => {
  await run({ style: "offscreen" }, false, (outcome) => {
    assertDeclined(outcome);
    for (const group of optionalDiagnostics(outcome.result)) {
      assert.equal(group.activation?.actionableSurface, "label");
      assert.equal(group.activation?.clickedElementType, "label");
      assert.equal(group.activation?.attempts.some((a) => a.clickedElementType === "native_input"), false);
    }
  });
});

test("actionability 3: a hidden native input inside a visible component wrapper, with no label, is actionable through the wrapper", async () => {
  await run({ style: "wrapper_only" }, false, (outcome) => {
    assertDeclined(outcome);
    for (const group of optionalDiagnostics(outcome.result)) {
      assert.equal(group.activation?.actionableSurface, "wrapper");
      assert.ok(group.activation?.verificationMethods.includes("selected_class"));
    }
  });
});

test("actionability 4: a group below the viewport of an inner scroll container is scrolled into view, becomes actionable and is declined", async () => {
  await run({ style: "offscreen", scroller: "1", below: "1" }, false, (outcome) => {
    assertDeclined(outcome);
    assert.ok(optionalDiagnostics(outcome.result).some((g) => g.scrolledIntoView), "at least the first group needed a scroll");
    assert.equal(optionalRejections(outcome.result).length, 0);
  });
});

test("actionability 5: when the input and every visible surface of the option are hidden, the group is rejected as not rendered and never touched", async () => {
  await run({ style: "both_hidden" }, false, ({ result, checked }) => {
    assert.equal(optionalDiagnostics(result).length, 0);
    const rejections = optionalRejections(result);
    assert.equal(rejections.length, 2);
    for (const r of rejections) {
      assert.equal(r.rejectionStage, "member_visibility");
      assert.equal(r.rejectionReason, "not_rendered");
      assert.equal(r.nativeInput.visible, false);
      assert.equal(r.label.found, true);
      assert.equal(r.label.visible, false);
      assert.equal(r.actionableMemberCount, 0);
    }
    assert.equal(checked.PRIVACY_FLAG_MRKT, null);
  });
});

test("actionability 6: an inactive responsive copy plus a visible copy -- only the visible copy is answered", async () => {
  await run({ style: "offscreen", dup: "responsive" }, false, (outcome) => {
    assertDeclined(outcome);
    for (const group of optionalDiagnostics(outcome.result)) {
      assert.equal(group.optionCount, 4);
      assert.equal(group.visibleOptionCount, 2);
      assert.equal(group.hiddenDuplicateCount, 2);
    }
    for (const name of ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY"]) assert.equal(outcome.checked[name]?.id.endsWith("-m"), false, `${name}: the inactive copy was never checked`);
  });
});

test("actionability 7: of two rendered copies only the hit-testable one is used; the covered copy is a non-actionable duplicate", async () => {
  await run({ style: "offscreen", dup: "covered" }, false, (outcome) => {
    assertDeclined(outcome);
    for (const group of optionalDiagnostics(outcome.result)) {
      assert.equal(group.optionCount, 4);
      assert.equal(group.visibleOptionCount, 2);
      assert.equal(group.hiddenDuplicateCount, 2);
    }
    for (const name of ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY"]) assert.equal(outcome.checked[name]?.id.endsWith("-a"), false, `${name}: the covered copy was never chosen`);
  });
});

test("actionability 8: a label whose for= resolves to an inactive duplicate does not count as the visible copy's label", async () => {
  await withPage({ style: "offscreen", dup: "shared_ids" }, async (page) => {
    const groups = await discoverConsentGroups(page.locator("#lead-form"), { scroll: true });
    for (const name of ["PRIVACY_FLAG_MRKT", "PRIVACY_FLAG_THIRDPARTY"]) {
      const group = groups.find((g) => g.groupId === name);
      assert.ok(group, name);
      assert.equal(group.members.length, 4);
      const [hiddenYes, hiddenNo, visibleYes, visibleNo] = group.members as [ConsentGroupMember, ConsentGroupMember, ConsentGroupMember, ConsentGroupMember];
      for (const inactive of [hiddenYes, hiddenNo]) {
        assert.equal(inactive.actionable, false, "the inactive copy never counts, even though the visible label points at it");
        assert.equal(inactive.visible, false);
      }
      for (const visible of [visibleYes, visibleNo]) {
        assert.equal(visible.labelSurface.found, false, "the other copy's label is not this input's label");
        assert.equal(visible.activationSurface, "wrapper");
      }
    }
  });
});

test("actionability 9 and 12: five detected groups with none actionable give five rejection records and bounded rescans", async () => {
  await run({ style: "both_hidden", groups: "5" }, false, ({ result }) => {
    const consent = result.formConsentDiagnostics;
    assert.ok(consent);
    assert.equal(optionalRejections(result).length, 5);
    assert.equal(optionalDiagnostics(result).length, 0);
    assert.equal(consent.consentGroupsDetected, consent.consentGroupDiagnostics.length + consent.consentGroupRejections.length, "no detected group disappears");
    assert.equal(consent.consentGroupsDiscoveredNonActionable, 5);
    assert.equal(consent.consentRescanCount, 5, "every non-actionable group earns the bounded rescans");
    assert.deepEqual([...consent.unresolvedOptionalConsentGroups].sort(), [...OPTIONAL].sort());
    assert.equal(result.formPostSubmitDiagnostics?.submitAttemptSummary.firstAttemptConsentMode, "optional_consent_groups_not_actionable");
  });
});

test("actionability 10: the pre-submit scan sees no actionable optional group, the fallback rediscovers them live and the verified opt-in follows", async () => {
  await run({ style: "offscreen", site: "requires_optin", obscure: "1", uncoverOnSubmit: "1" }, true, ({ result, businessHits, submitCount, checked }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.ok(summary);
    assert.equal(summary.firstAttemptConsentMode, "optional_consent_groups_not_actionable");
    assert.ok(summary.optionalGroupRediscoveryCount >= 2, "rediscovery plus the opt-in's own live read");
    assert.equal(summary.actionableOptionalGroupCount, 2);
    assert.equal(summary.nonActionableOptionalGroupCount, 0);
    assert.equal(summary.fallbackEligibilityChecks?.optionalConsentGroupsActionable, true);
    assert.equal(summary.fallbackUsed, true);
    assert.equal(summary.fallbackNotUsedReason, null);
    assert.equal(summary.secondAttemptConsentCommitted, true);
    assert.equal(summary.totalSubmitAttempts, 2);
    assert.equal(submitCount, 2);
    assert.equal(businessHits, 1);
    assert.equal(checked.PRIVACY_FLAG_MRKT?.value, "1");
    assert.equal(checked.processing?.value, "1", "required processing untouched by the opt-in");
    assert.equal(result.success, true);
  });
});

test("actionability 10b: an optional group of another form variant that never renders is reported but does not hold the verified fallback back", async () => {
  await run({ style: "offscreen", site: "requires_optin", inactiveVariant: "1" }, true, ({ result, submitCount, checked }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.ok(summary);
    assert.equal(summary.firstAttemptConsentMode, "decline");
    assert.equal(summary.actionableOptionalGroupCount, 2);
    assert.equal(summary.nonActionableOptionalGroupCount, 1);
    assert.equal(summary.nonActionableOptionalGroups[0]?.rejectionReason, "not_rendered");
    assert.equal(summary.fallbackEligibilityChecks?.optionalConsentGroupsActionable, true);
    assert.equal(summary.fallbackUsed, true);
    assert.equal(submitCount, 2);
    assert.equal(checked.PRIVACY_FLAG_PROFILE_VARIANT, null, "the never-rendered variant is never touched");
    assert.equal(result.success, true);
  });
});

test("actionability 11 and 12: consent controls that appear only after an earlier selection are found on rescan and declined", async () => {
  await run({ style: "offscreen", reveal: "on_select" }, false, (outcome) => {
    assertDeclined(outcome);
    const consent = outcome.result.formConsentDiagnostics;
    assert.ok(consent);
    assert.ok(consent.consentRescanCount >= 1);
    assert.equal(consent.consentGroupRejections.filter((r) => OPTIONAL.includes(r.groupId)).length, 0);
  });
});

test("actionability 16: with the flag on but the optional groups still covered after live rediscovery, no second Submit and the precise reason", async () => {
  await run({ style: "offscreen", site: "requires_optin", obscure: "1" }, true, ({ result, submitCount, businessHits }) => {
    const summary = result.formPostSubmitDiagnostics?.submitAttemptSummary;
    assert.ok(summary);
    assert.equal(summary.fallbackFlagEnabled, true);
    assert.equal(summary.fallbackUsed, false);
    assert.equal(summary.fallbackNotUsedReason, "optional_consent_groups_detected_but_not_actionable");
    assert.equal(summary.fallbackEligibilityChecks?.optionalConsentGroupPresent, true);
    assert.equal(summary.fallbackEligibilityChecks?.optionalConsentGroupsActionable, false);
    assert.equal(summary.optionalGroupRediscoveryCount, 3);
    assert.equal(summary.nonActionableOptionalGroupCount, 2);
    for (const r of summary.nonActionableOptionalGroups) {
      assert.equal(r.rejectionStage, "actionable_filter");
      assert.equal(r.rejectionReason, "obscured_by_other_element");
      assert.equal(r.label.onScreen, true);
      assert.equal(r.nativeInput.onScreen, false);
    }
    assert.equal(summary.totalSubmitAttempts, 1);
    assert.equal(submitCount, 1);
    assert.equal(businessHits, 0);
  });
});

test("actionability 23: rejection and actionability diagnostics carry no question text, option label or typed value", async () => {
  await run({ style: "both_hidden", groups: "5" }, false, ({ result }) => {
    const serialized = JSON.stringify({ consent: result.formConsentDiagnostics, summary: result.formPostSubmitDiagnostics?.submitAttemptSummary });
    for (const fragment of ["Souhaitez-vous", "Acceptez-vous", "\"Oui\"", "\"Non\"", "politique de confidentialité", "@"]) assert.equal(serialized.includes(fragment), false, fragment);
  });
});

test("actionability 24: the rejection records and the new summary fields validate against the response schema's actionResult", async () => {
  const require = createRequire(import.meta.url);
  const Ajv2020 = require("ajv/dist/2020.js");
  const addFormats = require("ajv-formats");
  const schema = JSON.parse(await readFile(join(__dirname, "..", "..", "schemas", "task-response.schema.json"), "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.compile({ $ref: `${schema.$id}#/$defs/actionResult` });
  for (const [query, flag] of [[{ style: "both_hidden", groups: "5" }, false], [{ style: "offscreen", site: "requires_optin", obscure: "1" }, true]] as const) {
    await run({ ...query }, flag, ({ result }) => {
      const wire = JSON.parse(JSON.stringify({ ...result, interactionOutcome: "IN_PAGE_STATE_CHANGE" }));
      assert.equal(validate(wire), true, `${JSON.stringify(query)}: ${ajv.errorsText(validate.errors)}`);
    });
  }
});
