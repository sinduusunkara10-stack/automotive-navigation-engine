import type { Page } from "playwright";
import type { CookieNameEntry, HostContextSnapshotCapture, StorageKeyEntry } from "../types/task-response.js";

const MAX_REPORTED_COOKIES = 50;
const MAX_REPORTED_STORAGE_KEYS = 50;

/**
 * Bounded, names-only footprint of cookies and localStorage/sessionStorage keys on the
 * current page -- see HostContextSnapshotCapture's own doc comment (types/task-response.ts)
 * for what this is for and why it deliberately never reads a value. Cookies come from the
 * whole browser context's jar (checkNavigationAllowed-style host filtering is not applied
 * here -- every cookie name/domain the context currently holds is reported, since which
 * domain a cookie is scoped to is exactly the evidence a caller needs to reason about
 * cross-host propagation); storage keys come only from the current page's own origin, since
 * localStorage/sessionStorage are always origin-scoped by the browser itself.
 */
export async function captureHostContextSnapshot(page: Page, stepIndex: number): Promise<HostContextSnapshotCapture> {
  const rawCookies = await page.context().cookies();
  const cookieNames: CookieNameEntry[] = rawCookies
    .slice(0, MAX_REPORTED_COOKIES)
    .map((cookie) => ({ name: cookie.name, domain: cookie.domain }));

  const storageKeyNames: StorageKeyEntry[] = await page
    .evaluate(() => {
      const readKeys = (storage: Storage): string[] => {
        try {
          return Object.keys(storage);
        } catch {
          return [];
        }
      };
      return {
        local: readKeys(window.localStorage),
        session: readKeys(window.sessionStorage),
      };
    })
    .then((keys) => [
      ...keys.local.map((key) => ({ store: "local" as const, key })),
      ...keys.session.map((key) => ({ store: "session" as const, key })),
    ])
    .catch(() => [] as StorageKeyEntry[]);

  let hostname = "";
  try {
    hostname = new URL(page.url()).hostname;
  } catch {
    hostname = "";
  }

  return {
    stepIndex,
    timestamp: new Date().toISOString(),
    hostname,
    cookieNames,
    storageKeyNames: storageKeyNames.slice(0, MAX_REPORTED_STORAGE_KEYS),
  };
}
