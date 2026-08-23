import type { CaptureModuleName } from "../types/captureModule.js";

/**
 * Which registered capture module names have an implementation wired up in this
 * proof of concept. The other enum members are reserved names for later modules
 * (dataLayer, GA4 network, screenshots, offer text) — deliberately not built yet.
 */
export const IMPLEMENTED_CAPTURE_MODULES: ReadonlySet<CaptureModuleName> = new Set(["page_visits"]);

export function isCaptureModuleImplemented(name: CaptureModuleName): boolean {
  return IMPLEMENTED_CAPTURE_MODULES.has(name);
}
