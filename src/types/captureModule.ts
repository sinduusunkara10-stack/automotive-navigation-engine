export const CAPTURE_MODULE_NAMES = [
  "page_visits",
  "page_metadata",
  "cta_clicks",
  "finish_page_ctas",
  "journey_path",
  "data_layer_evidence",
  "ga4_network_events",
  "screenshots",
  "errors",
  "offer_extraction",
  "host_context_snapshot",
] as const;

export type CaptureModuleName = (typeof CAPTURE_MODULE_NAMES)[number];
