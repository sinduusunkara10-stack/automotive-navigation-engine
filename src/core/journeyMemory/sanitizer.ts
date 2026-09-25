import { analyzeHost, isSameRegistrableDomain } from "../../discovery/registrableDomain.js";
import { tokenize } from "../../discovery/relevance.js";
import type { SanitizedPageIdentity } from "../../types/journeyMemory.js";

/**
 * Explicit allowlist of query/fragment param names that may be extracted (as a separate,
 * named sanitized semantic field) before the raw URL is discarded -- never a blocklist,
 * per CLAUDE.md/the binding contract §7: an unrecognised param name is always dropped, so
 * a newly-introduced tracking/session/PII param can never leak in by omission. Values
 * themselves are still bounded/sanitized (see extractAllowlistedFields) -- this only says
 * which *names* are ever worth keeping at all, generically, across any site.
 */
const ALLOWLISTED_PARAM_NAMES = new Set(["step", "stage", "model", "variant", "trim", "page", "tab"]);

const MAX_EXTRACTED_VALUE_LENGTH = 64;
const MAX_SEMANTIC_SIGNATURE_TOKENS = 24;

function sanitizeExtractedValue(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, MAX_EXTRACTED_VALUE_LENGTH);
}

/**
 * Normalized path only -- lowercased, trailing slash collapsed, never a query string or
 * fragment. Numeric-looking path segments (likely ids) are replaced with a generic "{id}"
 * placeholder so two otherwise-identical routes differing only by a numeric id (a listing
 * item, a session-scoped resource) are recognised as the same normalized identity.
 */
export function normalizePath(pathname: string): string {
  const collapsed = pathname.replace(/\/+$/g, "") || "/";
  return collapsed
    .split("/")
    .map((segment) => (segment.length > 0 && /^[0-9]+$/.test(segment) ? "{id}" : segment))
    .join("/")
    .toLowerCase();
}

/**
 * Extracts only allowlisted, journey-meaningful query/fragment params -- see
 * ALLOWLISTED_PARAM_NAMES above. Returns undefined when nothing allowlisted was present, so
 * SanitizedPageIdentity.extractedFields is only ever populated with genuine, positively
 * approved signal, never an empty object.
 */
export function extractAllowlistedFields(url: URL): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (ALLOWLISTED_PARAM_NAMES.has(key.toLowerCase())) {
      fields[key.toLowerCase()] = sanitizeExtractedValue(value);
    }
  }
  if (url.hash) {
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    for (const [key, value] of hashParams.entries()) {
      if (ALLOWLISTED_PARAM_NAMES.has(key.toLowerCase())) {
        fields[key.toLowerCase()] = sanitizeExtractedValue(value);
      }
    }
  }
  return Object.keys(fields).length > 0 ? fields : undefined;
}

/**
 * Builds a compact, bounded semantic signature from title/heading vocabulary -- never raw
 * page text, never more than MAX_SEMANTIC_SIGNATURE_TOKENS distinct sorted tokens, so it
 * carries structural/semantic identity (what kind of page this is) without ever being a
 * reversible page-content dump.
 */
export function buildSemanticSignature(text: string[]): string {
  const tokens = new Set<string>();
  for (const t of text) {
    for (const token of tokenize(t)) {
      tokens.add(token);
      if (tokens.size >= MAX_SEMANTIC_SIGNATURE_TOKENS) break;
    }
  }
  return [...tokens].sort().join(" ");
}

/**
 * Sanitizes a raw, live URL + semantic text into a SanitizedPageIdentity fit to persist:
 * registrable domain (via tldts, see registrableDomain.ts) + trusted-subdomain-relationship
 * hostname retained only insofar as its registrable domain, normalized path, a bounded
 * semantic signature, and any explicitly allowlisted extracted fields. Never persists the
 * raw query string, fragment, cookies, storage, or full page text -- see CLAUDE.md/the
 * binding contract §7.
 */
export function sanitizePageIdentity(rawUrl: string, semanticText: string[]): SanitizedPageIdentity {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { registrableDomain: "invalid", normalizedPath: "/", semanticSignature: buildSemanticSignature(semanticText) };
  }
  const host = analyzeHost(url.hostname);
  const extractedFields = extractAllowlistedFields(url);
  return {
    registrableDomain: host.registrableDomain ?? url.hostname,
    normalizedPath: normalizePath(url.pathname),
    semanticSignature: buildSemanticSignature(semanticText),
    ...(extractedFields ? { extractedFields } : {}),
  };
}

export function isSameSanitizedDomain(a: string, b: string): boolean {
  return isSameRegistrableDomain(a, b);
}
