/**
 * The HTTP API's own version, independent of package.json's npm package version and of
 * schemaVersion/outputSchemaVersion in the task contracts. Bump it when the API's
 * request/response shape (routes, status codes, auth behavior) changes in a way callers
 * should be able to detect from GET /v1/health.
 */
export const API_VERSION = "1.0.0";
