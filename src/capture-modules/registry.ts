import type { CaptureModuleName } from "../types/captureModule.js";

/**
 * Which registered capture module names have an implementation wired up in this
 * proof of concept. The other enum member (offer_extraction) is a reserved name
 * for a later module — deliberately not built yet.
 */
export const IMPLEMENTED_CAPTURE_MODULES: ReadonlySet<CaptureModuleName> = new Set([
  "page_visits",
  "page_metadata",
  "data_layer_evidence",
  "ga4_network_events",
  "screenshots",
  "finish_page_ctas",
  "cta_clicks",
  "journey_path",
  "errors",
]);

export function isCaptureModuleImplemented(name: CaptureModuleName): boolean {
  return IMPLEMENTED_CAPTURE_MODULES.has(name);
}
