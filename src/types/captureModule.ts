export const CAPTURE_MODULE_NAMES = [
  "page_visits",
  "cta_clicks",
  "data_layer_evidence",
  "ga4_network_events",
  "screenshots",
  "errors",
  "offer_extraction",
] as const;

export type CaptureModuleName = (typeof CAPTURE_MODULE_NAMES)[number];
