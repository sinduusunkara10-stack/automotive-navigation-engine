import type { CaptureModuleName } from "../types/captureModule.js";

/**
 * Which registered capture module names have an implementation wired up in this
 * proof of concept. The other enum members (cta_clicks, errors, offer_extraction) are
 * reserved names for later modules — deliberately not built yet.
 */
export const IMPLEMENTED_CAPTURE_MODULES: ReadonlySet<CaptureModuleName> = new Set([
  "page_visits",
  "page_metadata",
  "data_layer_evidence",
  "ga4_network_events",
  "screenshots",
  "finish_page_ctas",
]);

export function isCaptureModuleImplemented(name: CaptureModuleName): boolean {
  return IMPLEMENTED_CAPTURE_MODULES.has(name);
}
