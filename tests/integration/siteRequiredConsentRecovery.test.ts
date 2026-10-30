import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { VISUAL_EVIDENCE_REGION_MAX_BASE64_CHARS } from "../../src/diagnostics/visualEvidence.js";
import type { ActionResult } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

// The live 2026-10-30 run after PR #107: phone accepted in national format, dealer committed through
// its selected section, Submit pressed once -- and cancelled, because a Yes/No marketing radio group
// with no required marker, no aria-invalid and no native invalidity was required by the site's own
// validator, which showed error classes and one inline error only after Submit. The engine had
// classified the group ambiguous (its name "optInMkg" and the inflected "promotionnelles" matched
// nothing), and the retry gate read only native/aria invalidity, so it reported nothing to correct.
// tests/fixtures/dealer-locator-widget.html reproduces that shape (consent=...) in light DOM and in
// an open shadow root; every scenario runs in both.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const DEALERS = Array.from({ length: 9 }, (_, i) => ({ id: `D-${1000 + i}`, name: `Garage Exemple ${i + 1}`, city: "Exempleville" }));
const DOMS = ["light", "shadow"] as const;
const LIVE_SHAPE = "locality=empty&dealers=picked&phone=national";

interface Run {
  result: ActionResult;
  leadPosts: Record<string, string>[];
  submitEvents: number;
  dealerChoices: number;
  leadRequests: number;
}

async function runForm(query: string, options: { visualEvidence?: boolean } = {}): Promise<Run> {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const previous = process.env.FORM_DISCOVERY_DIAGNOSTIC;
  const previousVisual = process.env.FORM_VISUAL_EVIDENCE;
  process.env.FORM_DISCOVERY_DIAGNOSTIC = "1";
  if (options.visualEvidence) process.env.FORM_VISUAL_EVIDENCE = "1";
  else delete process.env.FORM_VISUAL_EVIDENCE;
  let leadRequests = 0;
  try {
    await page.route("**/api/localities*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ localities: [] }) }));
    await page.route("**/api/dealers*", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dealers: DEALERS }) }));
    await page.route("**/api/lead", (route) => {
      leadRequests += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${baseUrl}/dealer-locator-widget.html?${query}`);
    const result = (await executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "site-required-consent" })) as ActionResult;
    const counters = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return { leadPosts: w.__leadPosts as Record<string, string>[], submitEvents: w.__submitEvents as number, dealerChoices: w.__dealerChoices as number };
    });
    return { result, ...counters, leadRequests };
  } finally {
    if (previous === undefined) delete process.env.FORM_DISCOVERY_DIAGNOSTIC;
    else process.env.FORM_DISCOVERY_DIAGNOSTIC = previous;
    if (previousVisual === undefined) delete process.env.FORM_VISUAL_EVIDENCE;
    else process.env.FORM_VISUAL_EVIDENCE = previousVisual;
    await page.close();
    await browser.close();
    await close();
  }
}

function context(run: Run): string {
  const post = run.result.formPostSubmitDiagnostics;
  return JSON.stringify({
    outcome: run.result.formFillOutcome,
    retry: post?.retryDecision,
    recovery: post?.siteRejectedConsentRecovery,
    consent: run.result.formConsentDiagnostics?.consentGroupDiagnostics?.map((g) => ({ id: g.groupId, purpose: g.purpose, interaction: g.interaction, after: g.checkedAfter })),
    submitEvents: run.submitEvents,
    leadPosts: run.leadPosts.length,
  });
}

function consentGroup(run: Run, groupId: string) {
  const group = run.result.formConsentDiagnostics?.consentGroupDiagnostics?.find((g) => g.groupId === groupId);
  assert.ok(group, context(run));
  return group!;
}

/** Phone and dealer stay as PR #107 left them: national phone accepted, dealer committed once and never clicked again. */
function assertPhoneAndDealerUntouched(run: Run): void {
  const phone = run.result.formDiscoveryDiagnostics?.phoneValidationDiagnostics ?? [];
  assert.equal(phone.length, 1, context(run));
  assert.equal(phone[0]!.finalState, "no_rejection_observed", context(run));
  assert.equal(run.result.formDealerSearchDiagnostics?.dealerVerificationEvidence, "selected_result_shown_in_separate_selected_section", context(run));
  assert.equal(run.dealerChoices, 1, `the dealer is chosen once and never again -- ${context(run)}`);
}

/** The hidden routing fields are never written by the engine. */
function assertNoHiddenValueInjected(run: Run): void {
  for (const post of run.leadPosts) {
    assert.match(post["dealer.id"] ?? "", /^D-10\d\d$/, "only the widget writes the dealer fields");
  }
  for (const evidence of run.result.formPostSubmitDiagnostics?.hiddenFieldEvidence ?? []) {
    if (evidence.purpose !== "dealer_or_location_selection") assert.equal(evidence.changed, false, JSON.stringify(evidence));
  }
}

for (const dom of DOMS) {
  test(`site-required consent (${dom} DOM): a camelCase opt-in name with a marketing abbreviation is declined before Submit -- Submit once`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=named`);
    const group = consentGroup(run, "prefs.optInMkg");
    assert.equal(group.purpose, "optional_marketing", context(run));
    assert.match(group.purposeEvidence, /name_token\("mkg"\)/, context(run));
    assert.equal(group.interaction, "selected_decline", context(run));
    assert.equal(group.checkedAfter, "negative", context(run));
    assert.equal(run.submitEvents, 1, context(run));
    assert.equal(run.leadPosts.length, 1, context(run));
    assert.equal(run.leadPosts[0]!["prefs.optInMkg"], "0", "the decline option is what the site received");
    assert.equal(run.result.formFillOutcome, "submitted", context(run));
    assert.equal(run.result.formPostSubmitDiagnostics?.siteRejectedConsentRecovery, undefined, "nothing to recover");
    assertPhoneAndDealerUntouched(run);
    assertNoHiddenValueInjected(run);
  });

  test(`site-required consent (${dom} DOM): an inflected marketing word in the question is declined before Submit -- Submit once`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=text`);
    const group = consentGroup(run, "q7");
    assert.equal(group.purpose, "optional_marketing", context(run));
    assert.match(group.purposeEvidence, /text\("promot"\)/, context(run));
    assert.equal(group.checkedAfter, "negative", context(run));
    assert.equal(run.submitEvents, 1, context(run));
    assert.equal(run.leadPosts.length, 1, context(run));
    assert.equal(run.result.formFillOutcome, "submitted", context(run));
  });

  test(`site-required consent (${dom} DOM): a group whose purpose only the site's post-Submit error states is declined once, read back, and Submit runs exactly once more`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=late`);
    assert.equal(consentGroup(run, "q7").purpose, "ambiguous", "nothing says what the group is for before Submit");
    const post = run.result.formPostSubmitDiagnostics!;
    const recovery = post.siteRejectedConsentRecovery;
    assert.ok(recovery, context(run));
    assert.equal(recovery!.groups.length, 1, context(run));
    const rejected = recovery!.groups[0]!;
    assert.equal(rejected.groupId, "q7");
    assert.ok(rejected.rejectionLinks.includes("member_validator_invalid"), context(run));
    assert.equal(rejected.purpose, "optional_marketing", context(run));
    assert.equal(rejected.action, "declined_optional_commercial", context(run));
    assert.equal(rejected.checkedBefore, "none");
    assert.equal(rejected.checkedAfter, "negative", "exactly the decline option is checked");
    assert.equal(rejected.checkedStateVerified, true);
    assert.equal(recovery!.allRejectedGroupsAnswered, true);
    assert.deepEqual(recovery!.readinessFailuresAfterRecovery, []);
    assert.equal(run.submitEvents, 2, `one Submit, then exactly one after the recovery -- ${context(run)}`);
    assert.equal(post.submitAttemptSummary.totalSubmitAttempts, 2, context(run));
    assert.equal(run.leadPosts.length, 1, context(run));
    assert.equal(run.leadRequests, 1, `one business request, never a duplicate -- ${context(run)}`);
    assert.equal(run.leadPosts[0]!.q7, "0");
    assert.equal(run.result.formFillOutcome, "submitted", context(run));
    assert.match(post.retryDecision, /^retried 1\/\d: declined q7 after the site's validator required an answer/, context(run));
    assertPhoneAndDealerUntouched(run);
    assertNoHiddenValueInjected(run);
  });

  test(`site-required consent (${dom} DOM): the site's custom invalidity is caught although no field is natively invalid or aria-invalid`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=ambiguous`);
    const post = run.result.formPostSubmitDiagnostics!;
    assert.deepEqual(post.invalidFieldIds, [], "no native invalidity");
    assert.deepEqual(post.ariaInvalidFieldIds, [], "no aria-invalid");
    const attempt = post.submitCancellationDiagnostics!.attempts[0]!;
    const before = attempt.preSubmitSnapshot!.filter((c) => c.safeName === "q7");
    assert.equal(before.length, 2);
    for (const control of before) {
      assert.equal(control.requiredHtml || control.requiredAria || control.requiredClientMetadata, false, "nothing marks the group required before Submit");
      assert.equal(control.validityCategory, "valid");
    }
    const rejectedIds = (attempt.siteRejectedFields ?? []).filter((f) => f.safeName === "q7");
    assert.equal(rejectedIds.length, 2, JSON.stringify(attempt.siteRejectedFields));
    for (const field of rejectedIds) {
      assert.equal(field.markedBeforeSubmit, false);
      assert.ok(field.evidence.includes("error_class"), JSON.stringify(field));
    }
    const recovery = post.siteRejectedConsentRecovery!;
    assert.deepEqual(recovery.groups[0]!.rejectionLinks, ["member_validator_invalid"]);
    assert.deepEqual([...recovery.groups[0]!.memberFieldIds].sort(), rejectedIds.map((f) => f.fieldId).sort(), "the rejected fields are exactly the group's members");
  });

  test(`site-required consent (${dom} DOM): genuinely ambiguous consent the site requires stays unanswered and blocked -- no guess, no second Submit`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=ambiguous`);
    assert.equal(consentGroup(run, "q7").interaction, "left_untouched");
    const recovery = run.result.formPostSubmitDiagnostics!.siteRejectedConsentRecovery!;
    assert.equal(recovery.groups[0]!.purpose, "ambiguous", context(run));
    assert.equal(recovery.groups[0]!.action, "left_unanswered_purpose_not_proven");
    assert.equal(recovery.groups[0]!.checkedAfter, "none", "neither option was clicked");
    assert.equal(recovery.allRejectedGroupsAnswered, false);
    assert.equal(run.submitEvents, 1, context(run));
    assert.equal(run.leadPosts.length, 0);
    assert.notEqual(run.result.formFillOutcome, "submitted");
    assert.match(run.result.formPostSubmitDiagnostics!.retryDecision, /^not retried: the site rejected q7 \(ambiguous: left_unanswered_purpose_not_proven\)/, context(run));
    assertPhoneAndDealerUntouched(run);
  });

  test(`site-required consent (${dom} DOM): a group-level error rendered outside the group's block is still tied to that group`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=ambiguous&consentError=outside`);
    const recovery = run.result.formPostSubmitDiagnostics!.siteRejectedConsentRecovery!;
    assert.equal(recovery.groups.length, 1, context(run));
    assert.equal(recovery.groups[0]!.groupId, "q7");
    assert.deepEqual(recovery.groups[0]!.rejectionLinks, ["group_error_surface"], context(run));
    assert.equal(recovery.groups[0]!.action, "left_unanswered_purpose_not_proven");
    assert.equal(run.submitEvents, 1);
  });

  test(`site-required consent (${dom} DOM): with visual evidence on, the rejected group and the Submit control are captured as crops under the downstream size limit`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=late`, { visualEvidence: true });
    const shots = run.result.formVisualEvidence?.shots ?? [];
    const byStage = (stage: string) => shots.filter((s) => s.stage === stage);
    for (const stage of ["consent_validation_rejected", "consent_after_recovery", "submit_before_click", "submit_outcome"]) {
      const found = byStage(stage);
      assert.ok(found.length > 0, `${stage} captured -- ${JSON.stringify(shots.map((s) => [s.stage, s.area, s.dataBase64.length]))}`);
      if (stage === "submit_outcome" && found.every((s) => s.area === "viewport")) continue;
      for (const shot of found.filter((s) => s.area === "region")) {
        assert.ok(shot.dataBase64.length <= VISUAL_EVIDENCE_REGION_MAX_BASE64_CHARS, `${stage}: ${shot.dataBase64.length} chars`);
      }
    }
    assert.equal(byStage("consent_validation_rejected")[0]!.area, "region");
    assert.equal(byStage("consent_after_recovery")[0]!.area, "region");
    assert.equal(run.submitEvents, 2);
  });

  test(`site-required consent (${dom} DOM): visual evidence stays off in a normal run`, async () => {
    const run = await runForm(`dom=${dom}&${LIVE_SHAPE}&consent=late`);
    assert.equal(run.result.formVisualEvidence, undefined);
    assert.equal(run.submitEvents, 2);
  });
}
