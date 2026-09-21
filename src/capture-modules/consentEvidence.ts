import type { Ga4NetworkEventCapture } from "../types/task-response.js";

/**
 * Reads whether Google's Consent Mode v2 marked analytics/ad storage as granted, from
 * evidence this engine already captures verbatim -- never a new capture mechanism, never a
 * brand-specific one. Two independent, protocol-level (not vendor-specific to any one site)
 * signals are checked, in order of directness:
 *
 * 1. A `gtag('consent', 'default' | 'update', {...})` call, which a standard gtag-to-
 *    dataLayer bridge reports to window.dataLayer as `arguments`, i.e. an object with
 *    numeric-string keys {"0": "consent", "1": "default"|"update", "2": {analytics_storage,
 *    ad_storage, ...}} -- exactly the shape already observed verbatim in
 *    captures.data_layer_evidence / dataLayerDelta.newEntries. This is gtag's own documented
 *    wire format (developers.google.com/tag-platform/devsite/gtagjs/reference#consent), not
 *    any one client's convention.
 * 2. Failing that, the standard GA4 Measurement Protocol "gcs" (Google Consent Status)
 *    parameter already read verbatim into Ga4NetworkEventCapture.consentState -- format
 *    "G1" + one digit for ad_storage + one digit for analytics_storage ("1" granted, "0"
 *    denied), per Google's own documented encoding. Only decoded when it matches that exact
 *    fixed shape; never guessed otherwise.
 */
export interface ConsentStorageEvidence {
  analyticsStorageGranted?: boolean;
  adStorageGranted?: boolean;
  /** True if any consent-mode signal (of either kind above) was found at all. */
  observed: boolean;
}

const GCS_PATTERN = /^G1(\d)(\d)/;

function readGtagConsentEntries(entries: Record<string, unknown>[]): ConsentStorageEvidence | undefined {
  let analyticsStorageGranted: boolean | undefined;
  let adStorageGranted: boolean | undefined;
  let found = false;

  for (const entry of entries) {
    if (entry["0"] !== "consent" || (entry["1"] !== "default" && entry["1"] !== "update")) {
      continue;
    }
    const payload = entry["2"];
    if (!payload || typeof payload !== "object") {
      continue;
    }
    found = true;
    const record = payload as Record<string, unknown>;
    if (record.analytics_storage === "granted") {
      analyticsStorageGranted = true;
    } else if (record.analytics_storage === "denied") {
      analyticsStorageGranted = analyticsStorageGranted ?? false;
    }
    if (record.ad_storage === "granted") {
      adStorageGranted = true;
    } else if (record.ad_storage === "denied") {
      adStorageGranted = adStorageGranted ?? false;
    }
  }

  return found ? { analyticsStorageGranted, adStorageGranted, observed: true } : undefined;
}

function readGa4ConsentState(events: Ga4NetworkEventCapture[]): ConsentStorageEvidence | undefined {
  for (const event of events) {
    const gcs = event.consentState?.gcs;
    if (!gcs) {
      continue;
    }
    const match = GCS_PATTERN.exec(gcs);
    if (!match) {
      continue;
    }
    return {
      adStorageGranted: match[1] === "1",
      analyticsStorageGranted: match[2] === "1",
      observed: true,
    };
  }
  return undefined;
}

/**
 * Combines every dataLayer entry (across the whole run, not just one action's window --
 * consent is a run-wide state transition, not a per-click fact) with this action's own GA4
 * window. dataLayer evidence is preferred when present (it is the site's own explicit
 * consent-mode call, closer to ground truth than a derived request parameter).
 */
export function readConsentStorageEvidence(params: {
  dataLayerEntries: Record<string, unknown>[];
  ga4Events: Ga4NetworkEventCapture[];
}): ConsentStorageEvidence {
  return (
    readGtagConsentEntries(params.dataLayerEntries) ??
    readGa4ConsentState(params.ga4Events) ?? { observed: false }
  );
}
