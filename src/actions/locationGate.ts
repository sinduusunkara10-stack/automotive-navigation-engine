import type { Page } from "playwright";
import { waitForAdaptiveSettle } from "../core/robustNavigation.js";
import type { SupportedLanguage } from "../forms/testData.js";
import { firstSelectableOption } from "../forms/vehicleSelection.js";

/**
 * A generic "location gate": a blocking panel some sites show before letting a visitor reach
 * further content (e.g. stock/availability results) that asks only for a postcode/location and
 * a Continue-equivalent control -- structurally distinct from, and never conflated with, the
 * lead-generation <form> src/actions/fillForm.ts already fills (its own customer-address
 * postcode field and its dealer-lookup postcode/city field, see dealerLookup.ts). The
 * distinguishing structural signal this module uses is deliberately simple and generic: a
 * location gate's own postcode/location input lives OUTSIDE any <form> element entirely (most
 * such gates are JS-driven panels/modals, not native forms), so this module never looks inside
 * a <form> at all and fillForm.ts's own form-scoped logic never looks outside one -- the two
 * never see the same field.
 */

const FIELD_INDEX_ATTR = "data-nav-engine-gate-index";
const MAX_GATE_RESOLUTION_ATTEMPTS = 2;

/** Generic location/postcode-entry vocabulary -- intentionally a separate, independent table from fieldKeywords.ts's own postcode list, so this module's detection never depends on (or is coupled to) the lead-form field mapper. */
const LOCATION_INPUT_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["postcode", "postal code", "zip code", "zip", "your location", "enter your location", "enter your postcode"],
  fr: ["code postal", "votre localisation", "entrez votre code postal"],
  de: ["postleitzahl", "plz", "ihr standort"],
  nl: ["postcode", "uw locatie"],
  it: ["codice postale", "cap", "la tua posizione"],
  es: ["codigo postal", "tu ubicacion"],
  pl: ["kod pocztowy", "twoja lokalizacja"],
  pt: ["codigo postal", "sua localizacao"],
};

/** Generic "proceed" vocabulary for a location gate's own confirm control -- never "search"/"find" alone (that is dealer-lookup's own vocabulary, kept separate), though a gate may still use them; continue/validate/confirm are the gate-specific additions. */
const CONTINUE_CONTROL_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["continue", "validate", "confirm", "go", "search", "find", "ok", "submit"],
  fr: ["continuer", "valider", "confirmer", "rechercher", "ok"],
  de: ["weiter", "bestatigen", "bestätigen", "suchen", "ok"],
  nl: ["doorgaan", "bevestigen", "zoeken", "ok"],
  it: ["continua", "conferma", "cerca", "ok"],
  es: ["continuar", "confirmar", "buscar", "ok"],
  pl: ["dalej", "potwierdz", "potwierdź", "szukaj"],
  pt: ["continuar", "confirmar", "pesquisar", "ok"],
};

/** Generic search-radius vocabulary -- a radius/distance control near a location gate, when present, is handled the same bounded way as any other generic required select (see forms/vehicleSelection.ts). */
const RADIUS_KEYWORDS: Record<SupportedLanguage, string[]> = {
  en: ["radius", "distance", "within"],
  fr: ["rayon", "distance"],
  de: ["umkreis", "entfernung"],
  nl: ["straal", "afstand"],
  it: ["raggio", "distanza"],
  es: ["radio", "distancia"],
  pl: ["promien", "promień", "odleglosc", "odległość"],
  pt: ["raio", "distancia"],
};

export interface LocationGateOutcome {
  locationGateDetected: boolean;
  locationGateInputFilled: boolean;
  locationGateSuggestionsDetected: boolean;
  locationGateSuggestionSelected: boolean;
  locationGateRadiusControlDetected: boolean;
  locationGateRadiusControlResolved: boolean;
  locationGateContinueControlFound: boolean;
  locationGateContinueClicked: boolean;
  locationGatePassed: boolean;
  locationGateFailureReason?: string;
}

export const EMPTY_LOCATION_GATE_OUTCOME: LocationGateOutcome = {
  locationGateDetected: false,
  locationGateInputFilled: false,
  locationGateSuggestionsDetected: false,
  locationGateSuggestionSelected: false,
  locationGateRadiusControlDetected: false,
  locationGateRadiusControlResolved: false,
  locationGateContinueControlFound: false,
  locationGateContinueClicked: false,
  locationGatePassed: false,
};

interface GateSnapshot {
  inputIndex: string | null;
  inputVisible: boolean;
  continueIndex: string | null;
  radiusIndex: string | null;
  radiusOptions: { value: string; label: string; disabled?: boolean }[];
}

async function snapshotGate(page: Page, language: SupportedLanguage): Promise<GateSnapshot> {
  return page.evaluate(
    // Deliberately avoids any named helper function/const inside this callback -- tsx/esbuild
    // wraps a nested named binding in a __name(...) call that doesn't exist once Playwright
    // serializes the function's source to run in the browser (same constraint as fillForm.ts's
    // tagAndReadFields). Everything stays inline, even at the cost of some repetition.
    (params: { attr: string; locationKeywords: string[]; continueKeywords: string[]; radiusKeywords: string[] }) => {
      let inputIndex: string | null = null;
      let inputVisible = false;
      const allInputs = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')) as HTMLInputElement[];
      for (const input of allInputs) {
        if (input.closest("form")) continue;
        const id = input.getAttribute("id");
        const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const closestLabel = input.closest("label");
        const text =
          (byFor ?? closestLabel)?.textContent?.trim() ||
          input.getAttribute("aria-label") ||
          input.getAttribute("placeholder") ||
          input.getAttribute("name") ||
          "";
        const normalizedText = text
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "");
        const matchesLocation = params.locationKeywords.some((keyword) =>
          normalizedText.includes(
            keyword
              .toLowerCase()
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, ""),
          ),
        );
        const rect = input.getBoundingClientRect();
        const style = window.getComputedStyle(input);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (text && matchesLocation && visible) {
          if (!input.hasAttribute(params.attr)) input.setAttribute(params.attr, "gate-input");
          inputIndex = params.attr;
          inputVisible = true;
          break;
        }
      }

      let continueIndex: string | null = null;
      if (inputIndex) {
        const inputEl = document.querySelector(`[${params.attr}="gate-input"]`);
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="button"], input[type="submit"]')).filter(
          (el) => {
            if (el.closest("form")) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
          },
        );
        for (const button of buttons) {
          const text = button.getAttribute("aria-label")?.trim() || button.textContent?.trim() || (button as HTMLInputElement).value || "";
          const normalizedText = text
            .toLowerCase()
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "");
          const matchesContinue = params.continueKeywords.some((keyword) =>
            normalizedText.includes(
              keyword
                .toLowerCase()
                .normalize("NFD")
                .replace(/[̀-ͯ]/g, ""),
            ),
          );
          if (matchesContinue) {
            // Prefer a button structurally close to the gate input (same container), falling
            // back to the first match on the page when nothing closer is found.
            if (inputEl && (inputEl.parentElement?.contains(button) || button.parentElement?.contains(inputEl))) {
              button.setAttribute(`${params.attr}-continue`, "true");
              continueIndex = `${params.attr}-continue`;
              break;
            }
            if (!continueIndex) {
              button.setAttribute(`${params.attr}-continue`, "true");
              continueIndex = `${params.attr}-continue`;
            }
          }
        }
      }

      let radiusIndex: string | null = null;
      let radiusOptions: { value: string; label: string; disabled?: boolean }[] = [];
      const selects = Array.from(document.querySelectorAll("select")).filter((s) => {
        if (s.closest("form")) return false;
        const rect = s.getBoundingClientRect();
        const style = window.getComputedStyle(s);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
      for (const select of selects) {
        const id = select.getAttribute("id");
        const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const closestLabel = select.closest("label");
        const text = (byFor ?? closestLabel)?.textContent?.trim() || select.getAttribute("aria-label") || select.getAttribute("name") || "";
        const normalizedText = text
          .toLowerCase()
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "");
        const matchesRadius = params.radiusKeywords.some((keyword) =>
          normalizedText.includes(
            keyword
              .toLowerCase()
              .normalize("NFD")
              .replace(/[̀-ͯ]/g, ""),
          ),
        );
        if (matchesRadius) {
          select.setAttribute(`${params.attr}-radius`, "true");
          radiusIndex = `${params.attr}-radius`;
          radiusOptions = Array.from(select.options).map((o) => ({ value: o.value, label: o.textContent?.trim() ?? "", disabled: o.disabled }));
          break;
        }
      }

      return { inputIndex, inputVisible, continueIndex, radiusIndex, radiusOptions };
    },
    {
      attr: FIELD_INDEX_ATTR,
      locationKeywords: LOCATION_INPUT_KEYWORDS[language] ?? LOCATION_INPUT_KEYWORDS.en,
      continueKeywords: CONTINUE_CONTROL_KEYWORDS[language] ?? CONTINUE_CONTROL_KEYWORDS.en,
      radiusKeywords: RADIUS_KEYWORDS[language] ?? RADIUS_KEYWORDS.en,
    },
  );
}

/**
 * Detects and resolves a generic location/postcode gate blocking further progress, using the
 * task's own existing configured workflow postcode (marketDataFor(market).postcode -- never a
 * new input). Bounded: at most MAX_GATE_RESOLUTION_ATTEMPTS resolution attempts, each verifying
 * whether the gate's own input is still visible afterward before trying again.
 */
export async function resolveLocationGate(page: Page, market: string, postcode: string, language: SupportedLanguage): Promise<LocationGateOutcome> {
  const initial = await snapshotGate(page, language);
  if (!initial.inputIndex) {
    return EMPTY_LOCATION_GATE_OUTCOME;
  }

  const outcome: LocationGateOutcome = { ...EMPTY_LOCATION_GATE_OUTCOME, locationGateDetected: true };

  for (let attempt = 0; attempt < MAX_GATE_RESOLUTION_ATTEMPTS; attempt += 1) {
    const snapshot = attempt === 0 ? initial : await snapshotGate(page, language);
    if (!snapshot.inputIndex) {
      // The gate's own input is gone -- already passed (e.g. a previous attempt's continue
      // click took effect after this loop's own wait).
      outcome.locationGatePassed = true;
      return outcome;
    }

    const input = page.locator(`[${FIELD_INDEX_ATTR}="gate-input"]`);
    await input.fill(postcode).catch(() => {});
    outcome.locationGateInputFilled = true;

    // A radius/distance control, when present, is resolved the same generic way any other
    // required select with no matched field is (see forms/vehicleSelection.ts) -- any valid
    // option is acceptable, never a specific distance value.
    if (snapshot.radiusIndex) {
      outcome.locationGateRadiusControlDetected = true;
      const choice = firstSelectableOption(snapshot.radiusOptions, language);
      if (choice) {
        await page
          .locator(`[${FIELD_INDEX_ATTR}-radius="true"]`)
          .selectOption({ value: choice.value })
          .catch(() => {});
        outcome.locationGateRadiusControlResolved = true;
      }
    }

    if (snapshot.continueIndex) {
      outcome.locationGateContinueControlFound = true;
      await page
        .locator(`[${FIELD_INDEX_ATTR}-continue="true"]`)
        .click()
        .catch(() => {});
      outcome.locationGateContinueClicked = true;
    } else {
      await input.press("Enter").catch(() => {});
    }

    await waitForAdaptiveSettle(page);

    // A suggestion list (generic ARIA pattern only -- role="listbox"/"option", never a
    // brand-specific widget) that appears after submitting the postcode is resolved by picking
    // its first accessible result, then re-attempting the continue control once more, since
    // selecting a suggestion can itself reveal (or require re-clicking) the same control.
    const suggestionList = page.locator('[role="listbox"] [role="option"], [role="option"]').first();
    if ((await suggestionList.count().catch(() => 0)) > 0) {
      outcome.locationGateSuggestionsDetected = true;
      await suggestionList.click().catch(() => {});
      outcome.locationGateSuggestionSelected = true;
      await waitForAdaptiveSettle(page);
      const rePost = await snapshotGate(page, language);
      if (rePost.continueIndex) {
        await page
          .locator(`[${FIELD_INDEX_ATTR}-continue="true"]`)
          .click()
          .catch(() => {});
        await waitForAdaptiveSettle(page);
      }
    }

    const after = await snapshotGate(page, language);
    if (!after.inputIndex) {
      outcome.locationGatePassed = true;
      return outcome;
    }
  }

  outcome.locationGateFailureReason = `the gate's own location input was still visible after ${MAX_GATE_RESOLUTION_ATTEMPTS} resolution attempts`;
  return outcome;
}
