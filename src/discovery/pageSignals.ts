import type { Page } from "playwright";

export type AnchorEvidenceType = "visible_anchor" | "nav_anchor";

export interface CandidateAnchor {
  url: string;
  accessibleName: string;
  evidenceType: AnchorEvidenceType;
}

export interface PageSignals {
  canonicalUrl?: string;
  anchors: CandidateAnchor[];
}

// Generic semantic landmarks only -- <nav>, [role="navigation"], header, footer -- never a
// brand-specific or site-specific selector. This mirrors the same "no hardcoded selector for
// a specific site" rule CLAUDE.md applies to the core loop.
const NAV_LANDMARK_SELECTOR = 'nav, [role="navigation"], header, footer';

// Cap how many anchors preflight ever inspects, mirroring the existing convention of
// bounding lists sent onward (see promptBuilder.ts) -- a page with hundreds of links should
// not make preflight discovery unbounded.
const MAX_ANCHORS = 200;

/**
 * Reads canonical URL + candidate anchors directly from the live DOM of the page preflight
 * just navigated to. Anchors without a resolvable http/https-looking href, and anchors that
 * are not visible, are excluded here at the source -- same "don't offer what isn't a real
 * candidate" posture as observationBuilder.ts's interactive-element scan. Anchor
 * classification (visible vs. nav-landmark) is purely structural (DOM position/visibility),
 * never based on link text/brand content.
 */
export async function gatherPageSignals(page: Page): Promise<PageSignals> {
  return page.evaluate(
    ({ navSelector, maxAnchors }) => {
      const canonicalEl = document.querySelector('link[rel="canonical"]');
      const rawCanonicalHref = canonicalEl?.getAttribute("href")?.trim();
      let canonicalHref: string | undefined;
      if (rawCanonicalHref) {
        try {
          canonicalHref = new URL(rawCanonicalHref, document.baseURI).href;
        } catch {
          canonicalHref = undefined;
        }
      }

      const navLandmarks = Array.from(document.querySelectorAll(navSelector));
      const isInNav = (el: Element): boolean => navLandmarks.some((landmark) => landmark.contains(el));

      const anchorEls = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"));
      const anchors: { url: string; accessibleName: string; evidenceType: "visible_anchor" | "nav_anchor" }[] = [];

      for (const el of anchorEls) {
        if (anchors.length >= maxAnchors) break;

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) continue;

        const accessibleName = el.getAttribute("aria-label")?.trim() || el.textContent?.trim() || "";
        anchors.push({
          url: el.href,
          accessibleName,
          evidenceType: isInNav(el) ? "nav_anchor" : "visible_anchor",
        });
      }

      return {
        ...(canonicalHref ? { canonicalUrl: canonicalHref } : {}),
        anchors,
      };
    },
    { navSelector: NAV_LANDMARK_SELECTOR, maxAnchors: MAX_ANCHORS },
  );
}
