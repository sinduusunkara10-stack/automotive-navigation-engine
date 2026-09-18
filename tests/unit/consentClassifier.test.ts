import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessConsentSurface,
  classifyConsentControlPolarity,
  resolveAmbiguousConsentSurface,
  type ConsentAmbiguityResolver,
} from "../../src/safety/consentClassifier.js";
import type { InteractiveElement, Observation } from "../../src/types/task-response.js";

/**
 * Multilingual consent handling (corrective pass, see CLAUDE.md "Multilingual consent
 * handling"): coverage for src/safety/consentClassifier.ts's per-language wording table
 * (English, French, German, Spanish, Italian, Dutch -- the required minimum), the
 * conservative genuine-surface gate across languages, the distinction between
 * accept-all/decline/settings and ordinary non-consent controls, and the bounded,
 * independently-verified model-assist fallback for a language the table doesn't cover.
 */

function el(id: string, accessibleName: string, extra: Partial<InteractiveElement> = {}): InteractiveElement {
  return { id, role: "button", accessibleName, visible: true, ...extra };
}

function observationWithBanner(params: {
  heading: string;
  acceptLabel: string;
  otherLabel: string;
  otherPolarity?: "decline" | "settings";
  pageLanguage?: string;
  extraElements?: InteractiveElement[];
}): Observation {
  const { heading, acceptLabel, otherLabel, pageLanguage, extraElements = [] } = params;
  return {
    url: "https://example-fictional-oem.test/listing",
    title: "Listing",
    notableText: [heading],
    interactiveElements: [el("accept", acceptLabel), el("other", otherLabel), ...extraElements],
    ...(pageLanguage ? { pageLanguage } : {}),
  };
}

const LANGUAGE_FIXTURES: {
  code: string;
  heading: string;
  acceptAll: string;
  decline: string;
  settings: string;
}[] = [
  { code: "en", heading: "We use cookies", acceptAll: "Accept All Cookies", decline: "Reject All", settings: "Manage Cookie Preferences" },
  { code: "fr", heading: "Nous utilisons des cookies", acceptAll: "Tout accepter", decline: "Tout refuser", settings: "Gérer les préférences" },
  { code: "de", heading: "Wir verwenden Cookies", acceptAll: "Alle akzeptieren", decline: "Alle ablehnen", settings: "Cookie-Einstellungen" },
  { code: "es", heading: "Usamos cookies", acceptAll: "Aceptar todo", decline: "Rechazar todo", settings: "Configuración de cookies" },
  { code: "it", heading: "Utilizziamo i cookie", acceptAll: "Accetta tutto", decline: "Rifiuta tutto", settings: "Impostazioni cookie" },
  { code: "nl", heading: "Wij gebruiken cookies", acceptAll: "Alles accepteren", decline: "Alles weigeren", settings: "Cookie-instellingen" },
];

for (const fixture of LANGUAGE_FIXTURES) {
  test(`classifies accept-all/decline/settings correctly in ${fixture.code}`, () => {
    const accept = classifyConsentControlPolarity(fixture.acceptAll);
    assert.equal(accept?.polarity, "accept_all");
    assert.equal(accept?.language, fixture.code);

    const decline = classifyConsentControlPolarity(fixture.decline);
    assert.equal(decline?.polarity, "decline");
    assert.equal(decline?.language, fixture.code);

    const settings = classifyConsentControlPolarity(fixture.settings);
    assert.equal(settings?.polarity, "settings");
    assert.equal(settings?.language, fixture.code);
  });

  test(`assessConsentSurface detects a genuine ${fixture.code} consent surface (accept-all + decline) and reports pageLanguage`, () => {
    const observation = observationWithBanner({
      heading: fixture.heading,
      acceptLabel: fixture.acceptAll,
      otherLabel: fixture.decline,
      pageLanguage: fixture.code,
    });
    const assessment = assessConsentSurface(observation);
    assert.equal(assessment.surfaceDetected, true);
    assert.equal(assessment.acceptAllCandidate?.elementId, "accept");
    assert.equal(assessment.declineCandidate?.elementId, "other");
    assert.equal(assessment.languageAmbiguous, false);
    assert.equal(assessment.pageLanguage, fixture.code);
  });

  test(`assessConsentSurface detects a genuine ${fixture.code} consent surface (accept-all + settings/manage-preferences)`, () => {
    const observation = observationWithBanner({
      heading: fixture.heading,
      acceptLabel: fixture.acceptAll,
      otherLabel: fixture.settings,
    });
    const assessment = assessConsentSurface(observation);
    assert.equal(assessment.surfaceDetected, true);
    assert.equal(assessment.acceptAllCandidate?.elementId, "accept");
    assert.equal(assessment.settingsCandidate?.elementId, "other");
  });
}

test("a lone accept-shaped label with no corroborating consent-context evidence is never treated as a consent surface", () => {
  const observation: Observation = {
    url: "https://example-fictional-oem.test/settings",
    title: "Settings",
    interactiveElements: [el("loc", "Allow location access"), el("other", "Deny")],
  };
  const assessment = assessConsentSurface(observation);
  // surfaceDetected is the actual gate core/loop.ts acts on (see its own "if
  // (consentAssessment.surfaceDetected && ...)" check) -- a lone accept-shaped label with no
  // corroborating consent-context evidence must never flip it true, however a raw per-element
  // label match (acceptAllCandidate, kept for diagnostics/callers that want it regardless)
  // might otherwise look.
  assert.equal(assessment.surfaceDetected, false);
});

test("ordinary navigation/account/offer-CTA/form-submission/modal-close/Continue controls are never mistaken for consent controls, even alongside a genuine consent surface", () => {
  const observation = observationWithBanner({
    heading: "We use cookies",
    acceptLabel: "Accept All Cookies",
    otherLabel: "Reject All",
    extraElements: [
      el("nav", "My Account"),
      el("cta", "Request A Quote"),
      el("submit", "Submit Application"),
      el("close", "Close"),
      el("continue", "Continue"),
    ],
  });
  for (const id of ["nav", "cta", "submit", "close", "continue"]) {
    const target = observation.interactiveElements.find((e) => e.id === id);
    assert.ok(target);
    assert.equal(classifyConsentControlPolarity(target!.accessibleName), undefined, `expected "${target!.accessibleName}" not to classify as any consent polarity`);
  }
});

test("a consent surface whose wording matches none of the configured languages is reported as languageAmbiguous, never guessed at", () => {
  // Polish, not in the configured table -- genuine consent-context evidence (the shared
  // "cookie"/"cookies" token still appears, as real widgets often keep an English word in
  // an unsupported-language label) but no configured-language wording resolves a choice shape.
  const observation = observationWithBanner({
    heading: "Używamy plików cookie",
    acceptLabel: "Zaakceptuj wszystkie cookie",
    otherLabel: "Zarządzaj preferencjami cookie",
    pageLanguage: "pl",
  });
  const assessment = assessConsentSurface(observation);
  assert.equal(assessment.surfaceDetected, false);
  assert.equal(assessment.acceptAllCandidate, undefined);
  assert.equal(assessment.languageAmbiguous, true);
  assert.equal(assessment.pageLanguage, "pl");
  assert.ok(assessment.consentContextEvidence.length > 0, "expected genuine consent-context evidence despite the unsupported wording");
});

test("resolveAmbiguousConsentSurface uses the bounded resolver only when ambiguous, and independently verifies its answer against the observed candidates", async () => {
  const observation = observationWithBanner({
    heading: "Używamy plików cookie",
    acceptLabel: "Zaakceptuj wszystkie cookie",
    otherLabel: "Zarządzaj preferencjami cookie",
    pageLanguage: "pl",
  });
  const assessment = assessConsentSurface(observation);
  assert.equal(assessment.languageAmbiguous, true);

  const resolver: ConsentAmbiguityResolver = {
    async resolve(context) {
      const acceptControl = context.candidates.find((c) => c.label === "Zaakceptuj wszystkie cookie");
      return { acceptAllElementId: acceptControl?.elementId, rationale: "Polish 'accept all' phrasing", confidence: 0.9 };
    },
  };
  const resolved = await resolveAmbiguousConsentSurface(observation, assessment, resolver);
  assert.equal(resolved?.elementId, "accept");
  assert.equal(resolved?.polarity, "accept_all");
});

test("resolveAmbiguousConsentSurface rejects a resolution naming an element outside the observed candidate set", async () => {
  const observation = observationWithBanner({
    heading: "Używamy plików cookie",
    acceptLabel: "Zaakceptuj wszystkie cookie",
    otherLabel: "Zarządzaj preferencjami cookie",
  });
  const assessment = assessConsentSurface(observation);
  const resolver: ConsentAmbiguityResolver = {
    async resolve() {
      return { acceptAllElementId: "not-a-real-candidate-id", rationale: "hallucinated", confidence: 0.95 };
    },
  };
  const resolved = await resolveAmbiguousConsentSurface(observation, assessment, resolver);
  assert.equal(resolved, undefined, "a resolution naming a control that was never actually observed must never be trusted");
});

test("resolveAmbiguousConsentSurface rejects a low-confidence resolution", async () => {
  const observation = observationWithBanner({
    heading: "Używamy plików cookie",
    acceptLabel: "Zaakceptuj wszystkie cookie",
    otherLabel: "Zarządzaj preferencjami cookie",
  });
  const assessment = assessConsentSurface(observation);
  const resolver: ConsentAmbiguityResolver = {
    async resolve(context) {
      const acceptControl = context.candidates.find((c) => c.label === "Zaakceptuj wszystkie cookie");
      return { acceptAllElementId: acceptControl?.elementId, rationale: "not very sure", confidence: 0.2 };
    },
  };
  const resolved = await resolveAmbiguousConsentSurface(observation, assessment, resolver);
  assert.equal(resolved, undefined);
});

test("resolveAmbiguousConsentSurface is never invoked (no-ops) when the deterministic table already resolved the surface", async () => {
  const observation = observationWithBanner({
    heading: "We use cookies",
    acceptLabel: "Accept All Cookies",
    otherLabel: "Reject All",
  });
  const assessment = assessConsentSurface(observation);
  assert.equal(assessment.surfaceDetected, true);

  let called = false;
  const resolver: ConsentAmbiguityResolver = {
    async resolve() {
      called = true;
      return { rationale: "should never run", confidence: 1 };
    },
  };
  const resolved = await resolveAmbiguousConsentSurface(observation, assessment, resolver);
  assert.equal(resolved, undefined);
  assert.equal(called, false, "the model-assist resolver must never be invoked when the deterministic path already succeeded");
});
