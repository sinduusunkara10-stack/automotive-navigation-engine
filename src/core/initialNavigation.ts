import type { Page } from "playwright";
import { assessNavigationRecovery, robustGoto, type NavigationRecovery, type RobustGotoOutcome } from "./robustNavigation.js";

// Re-exported under their original names: this module is the engine's one-off initial
// page navigation (the first page.goto() in src/core/engine.ts, before the observe/
// decide/act loop starts). The underlying robust-navigation mechanics now live in
// ./robustNavigation.ts, shared with in-loop action navigation (src/actions/navigate.ts,
// src/actions/click.ts), but this module's public shape is unchanged.
export type InitialNavigationRecovery = NavigationRecovery;
export const assessInitialNavigationRecovery = assessNavigationRecovery;

export type InitialNavigationOutcome = RobustGotoOutcome;

/**
 * Performs the engine's initial page.goto(), via the shared robust-navigation helper:
 * waits only for "domcontentloaded" (never "load"/networkidle as a required condition --
 * a page with long-polling analytics/ads traffic may never fire "load" at all), and on a
 * timeout, attempts recovery so a slow-but-usable real page (e.g. a hosted OEM site)
 * doesn't fail the whole run before the engine ever gets to observe/decide.
 */
export async function navigateInitialPage(params: {
  page: Page;
  startUrl: string;
  allowedDomains: string[];
  timeoutMs: number;
}): Promise<InitialNavigationOutcome> {
  const { page, startUrl, allowedDomains, timeoutMs } = params;
  return robustGoto({ page, url: startUrl, allowedDomains, timeoutMs });
}
