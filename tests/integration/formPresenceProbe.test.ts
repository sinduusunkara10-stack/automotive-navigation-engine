import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

import { executeFillForm } from "../../src/actions/fillForm.js";
import { dispatchAction } from "../../src/actions/index.js";
import { observeLateFormRender, probeFormPresence } from "../../src/diagnostics/formPresenceProbe.js";
import type { ActionResult } from "../../src/types/task-response.js";
import { startStaticServer } from "../helpers/staticServer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, "..", "fixtures");
const schemaPath = join(__dirname, "..", "..", "schemas", "task-response.schema.json");
const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020.js");
const addFormats = require("ajv-formats");

const HEADER = '<header><a href="#a">Models</a><button>Menu</button></header>';
const FIELDS = '<label>First name <input name="f"></label><label>Email <input type="email" name="e"></label><select name="s"><option>A</option></select>';

const PAGES = {
  semantic: `${HEADER}<main><form>${FIELDS}<button type="submit">Send</button></form></main>`,
  nonSemantic: `${HEADER}<main><div class="lead">${FIELDS}<div role="button">Send</div></div></main>`,
  none: `${HEADER}<main><h1>Request a quote</h1><p>Loading</p></main>`,
  hidden: `${HEADER}<main><form style="display:none">${FIELDS}</form></main>`,
  shadow: `${HEADER}<main><lead-form></lead-form></main><script>
    customElements.define("lead-form", class extends HTMLElement {
      constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = '<form>${FIELDS}</form>'; }
    });
  </script>`,
  frame: `${HEADER}<main><iframe srcdoc='<form>${FIELDS.replace(/'/g, "&#39;")}</form>' style="width:600px;height:400px"></iframe></main>`,
  delayed: `${HEADER}<main id="m"><p>Loading</p></main><script>
    setTimeout(() => { document.getElementById("m").innerHTML = '<form>${FIELDS}<button type="submit">Send</button></form>'; }, 1500);
  </script>`,
  pendingComponent: `${HEADER}<main><lead-app aria-busy="true"></lead-app><div style="position:fixed;inset:0;background:#fff8">Please wait</div></main>`,
};

async function withEnv<T>(values: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`);
    return await fn(page);
  } finally {
    await page.close();
    await browser.close();
  }
}

async function assertActionResultValid(result: Omit<ActionResult, "interactionOutcome"> & { interactionOutcome?: ActionResult["interactionOutcome"] }): Promise<void> {
  const schema = JSON.parse(await readFile(schemaPath, "utf-8")) as { $id: string };
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/actionResult`);
  assert.ok(validate);
  assert.ok(validate({ interactionOutcome: "NO_OBSERVABLE_CHANGE", ...result }), ajv.errorsText(validate.errors));
}

test("form presence: each page shape is classified from DOM evidence alone", async () => {
  const expected: Record<keyof typeof PAGES, string> = {
    semantic: "semantic_form_with_fields",
    nonSemantic: "fields_without_semantic_form",
    none: "no_fields_detected",
    hidden: "fields_only_hidden",
    shadow: "fields_in_open_shadow_dom",
    frame: "fields_in_child_frame",
    delayed: "no_fields_detected",
    pendingComponent: "no_fields_detected",
  };
  for (const [name, html] of Object.entries(PAGES) as [keyof typeof PAGES, string][]) {
    const probe = await withPage(html, (page) => probeFormPresence(page));
    assert.equal(probe.classification, expected[name], name);
  }
});

test("form presence: counts separate hidden, shadow, framed, non-semantic and not-yet-upgraded components", async () => {
  const nonSemantic = await withPage(PAGES.nonSemantic, (page) => probeFormPresence(page));
  assert.equal(nonSemantic.main?.formElements, 0);
  assert.equal(nonSemantic.main?.fillableVisible, 3);
  assert.equal(nonSemantic.main?.fillableVisibleOutsideAnyForm, 3);

  const hidden = await withPage(PAGES.hidden, (page) => probeFormPresence(page));
  assert.equal(hidden.main?.formElements, 1);
  assert.equal(hidden.main?.fillableVisible, 0);
  assert.equal(hidden.main?.fillableHiddenByStyle, 3);

  const shadow = await withPage(PAGES.shadow, (page) => probeFormPresence(page));
  assert.equal(shadow.main?.formElements, 0);
  assert.equal(shadow.main?.formsInOpenShadowDom, 1);
  assert.equal(shadow.main?.fillableInOpenShadowDom, 3);

  const framed = await withPage(PAGES.frame, (page) => probeFormPresence(page));
  assert.equal(framed.main?.iframeElements, 1);
  assert.equal(framed.frames.length, 1);
  assert.equal(framed.frames[0]?.accessible, true);
  assert.equal(framed.frames[0]?.counts?.fillableVisible, 3);

  const pending = await withPage(PAGES.pendingComponent, (page) => probeFormPresence(page));
  assert.equal(pending.main?.undefinedCustomElements, 1);
  assert.equal(pending.main?.ariaBusyElements, 1);
  assert.equal(pending.main?.viewportCoveredByOverlay, true);
  assert.equal(pending.main?.readyState, "complete");
});

test("form presence: the late watch reports when a form renders, and stops at its bound when nothing does", async () => {
  const delayed = await withPage(PAGES.delayed, (page) => observeLateFormRender(page, 6000));
  assert.ok(delayed.formElementAppearedAtMs !== null && delayed.formElementAppearedAtMs >= 500);
  assert.ok(delayed.visibleFillableAppearedAtMs !== null);
  assert.ok(delayed.watchedMs < 6000);
  assert.equal(delayed.finalProbe.classification, "semantic_form_with_fields");

  const none = await withPage(PAGES.none, (page) => observeLateFormRender(page, 1500));
  assert.equal(none.formElementAppearedAtMs, null);
  assert.equal(none.visibleFillableAppearedAtMs, null);
  assert.ok(none.watchedMs >= 1500 && none.watchedMs < 4000);
});

test("form presence: no_form_found keeps its result and, with the flags on, carries the probe, the late watch and screenshots", async () => {
  const run = (env: Record<string, string | undefined>) =>
    withPage(PAGES.delayed, (page) =>
      withEnv(env, () => executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "presence" })),
    );
  const baseline = await run({ FORM_DISCOVERY_DIAGNOSTIC: undefined, FORM_VISUAL_EVIDENCE: undefined });
  assert.equal(baseline.error, "no_form_found");
  assert.equal(baseline.formDiscoveryDebug, undefined);
  assert.equal(baseline.formVisualEvidence, undefined);

  const result = await run({ FORM_DISCOVERY_DIAGNOSTIC: "1", FORM_VISUAL_EVIDENCE: "1" });
  assert.equal(result.success, false);
  assert.equal(result.error, "no_form_found");
  const presence = result.formDiscoveryDebug?.formPresence;
  assert.ok(presence);
  assert.equal(presence.atDiscovery.classification, "no_fields_detected");
  assert.ok(presence.lateRender?.formElementAppearedAtMs !== null);
  assert.deepEqual(
    result.formVisualEvidence?.shots.map((s) => s.stage),
    ["form_not_found", "form_not_found_after_late_watch"],
  );
  await assertActionResultValid(result);
});

test("form presence: an existing semantic form flow is unchanged and carries no no-form evidence", async () => {
  const { baseUrl, close } = await startStaticServer(fixturesDir);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`${baseUrl}/lead-form-dealer-xml-lookup.html`);
    await page.route("**/api/dealers/search*", (route) =>
      route.fulfill({ status: 200, contentType: "text/xml", body: '<?xml version="1.0"?><dealers><dealer><name>Garage Alpha</name><id>D-1</id></dealer></dealers>' }),
    );
    const result = await withEnv({ FORM_DISCOVERY_DIAGNOSTIC: "1", FORM_VISUAL_EVIDENCE: undefined }, () =>
      executeFillForm({ page, action: { type: "fill_form" }, captures: {}, stepIndex: 1, captureModules: [], taskId: "presence" }),
    );
    assert.equal(result.success, true);
    assert.equal(result.formDiscoveryDebug?.formPresence, undefined);
  } finally {
    await page.close();
    await browser.close();
    await close();
  }
});

test("form presence: page-touching steps carry the probe only when FORM_DISCOVERY_DIAGNOSTIC=1, and never for fill_form or stop actions", async () => {
  const dispatch = (page: Page, type: "scroll" | "stop_blocked") =>
    dispatchAction({ page, action: { type }, captures: {}, stepIndex: 2, captureModules: [], allowedDomains: [], actionNavigationTimeoutMs: 5000 });
  await withPage(PAGES.nonSemantic, async (page) => {
    const off = await withEnv({ FORM_DISCOVERY_DIAGNOSTIC: undefined }, () => dispatch(page, "scroll"));
    assert.equal(off.formPresence, undefined);
    const on = await withEnv({ FORM_DISCOVERY_DIAGNOSTIC: "1" }, () => dispatch(page, "scroll"));
    assert.equal(on.formPresence?.classification, "fields_without_semantic_form");
    await assertActionResultValid(on);
    const stop = await withEnv({ FORM_DISCOVERY_DIAGNOSTIC: "1" }, () => dispatch(page, "stop_blocked"));
    assert.equal(stop.formPresence, undefined);
  });
});
