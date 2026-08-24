import { timingSafeEqual } from "node:crypto";

/**
 * "Test mode" (NODE_ENV=test) is the one context where a missing
 * NAVIGATION_ENGINE_API_TOKEN does not abort server creation — it lets unit tests that
 * never exercise the API import this module without every one of them wiring up a
 * token. Any request still needs a matching bearer token to be authenticated (see
 * isAuthorized below): an unconfigured token fails every request closed, it never opens
 * the API up.
 */
function isTestMode(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "test";
}

export class MissingApiTokenError extends Error {
  constructor() {
    super(
      "NAVIGATION_ENGINE_API_TOKEN is required to start the navigation-engine API outside " +
        "test mode. Set it in your environment (see .env.example) — never commit a real " +
        "token to source.",
    );
    this.name = "MissingApiTokenError";
  }
}

export interface ApiAuthConfig {
  token: string | undefined;
}

export function readApiAuthConfig(env: NodeJS.ProcessEnv = process.env): ApiAuthConfig {
  const token = env.NAVIGATION_ENGINE_API_TOKEN?.trim();
  if (!token) {
    if (!isTestMode(env)) {
      throw new MissingApiTokenError();
    }
    return { token: undefined };
  }
  return { token };
}

function extractBearerToken(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const [scheme, ...rest] = headerValue.split(" ");
  if (scheme !== "Bearer" || rest.length === 0) return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time comparison so a near-miss token takes the same time to reject as a
 * wildly wrong one. timingSafeEqual throws on length mismatch, so a mismatched length
 * still runs a same-shape comparison against itself before returning false, rather than
 * short-circuiting immediately.
 */
function safeCompare(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    timingSafeEqual(providedBuf, providedBuf);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

export function isAuthorized(authorizationHeader: string | undefined, config: ApiAuthConfig): boolean {
  if (!config.token) return false;
  const provided = extractBearerToken(authorizationHeader);
  if (!provided) return false;
  return safeCompare(provided, config.token);
}
