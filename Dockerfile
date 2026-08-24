# Both stages use the same Playwright-compatible base image (rather than a separate
# generic Node image for the builder) — it already ships a Node.js satisfying
# package.json's "engines.node": ">=20", so the build and runtime Node versions match
# exactly and only one base image family is pulled.

# ---- Builder: compiles TypeScript with full devDependencies (not shipped) ----
FROM mcr.microsoft.com/playwright:v1.56.1-jammy AS builder
WORKDIR /app

# Building only compiles source with tsc; it never launches a browser, so skip
# Playwright's browser download here entirely.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc

# ---- Runtime: Playwright-compatible base image (bundles Chromium + OS deps) ----
FROM mcr.microsoft.com/playwright:v1.56.1-jammy AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
WORKDIR /app

# Production dependencies only (@anthropic-ai/sdk, ajv, ajv-formats, playwright, zod —
# see package.json; the base image already provides Chromium, so this reuses it rather
# than downloading a second copy).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app + the JSON schemas it validates requests/responses against at runtime.
# The compiled layout is dist/src/... (tsconfig rootDir "."), so schemas must land at
# dist/schemas to match the ../../schemas path src/api/validation.ts resolves relative
# to its own compiled location.
COPY --from=builder /app/dist/src ./dist/src
COPY schemas ./dist/schemas

EXPOSE 3000

# GET /v1/health is intentionally unauthenticated and minimal (status/service/version
# only) — safe for a container health check to call with no credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# mcr.microsoft.com/playwright images ship a pre-created, low-privilege "pwuser" account
# set up so Chromium runs correctly without --no-sandbox — use it instead of root.
USER pwuser

CMD ["node", "dist/src/api/main.js"]
