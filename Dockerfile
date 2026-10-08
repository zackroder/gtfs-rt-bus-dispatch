# syntax=docker/dockerfile:1

# ---- Build stage: compile the web + server bundles and a production-only node_modules ----
FROM node:22-slim AS build
# better-sqlite3 prefers a prebuilt binary, but install the toolchain so a source build is
# possible on architectures without one.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install from the lockfile with dev deps first (typecheck/build tooling lives there). Only the
# workspace manifests are copied so this layer caches until a dependency actually changes.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

# Copy the sources and build (typecheck + Vite web bundle + esbuild server bundle).
# tsconfig.base.json is required: both workspaces' tsconfigs extend it, and the typecheck
# silently degrades to default compiler options (then fails) when it is absent.
COPY tsconfig.base.json ./
COPY shared ./shared
COPY server ./server
COPY web ./web
RUN npm run build

# Reinstall a clean production-only dependency tree for the runtime image.
RUN npm ci --omit=dev

# ---- Runtime stage: prod deps, the built server, and the built web bundle ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
# Fly mounts the persistent volume at /data; the DB and cached GTFS zip live there.
ENV PORT=8080 \
    DB_PATH=/data/dispatch.db \
    STATIC_GTFS_PATH=/data/gtfs.zip
WORKDIR /app

# Workspace manifests keep Node's module resolution aware of the workspace layout; the runtime
# dependency tree itself is copied from the build stage.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

# The baked static tables are produced by the deploy workflow's bake step before this build.
# COPY is mandatory: a deploy without baking fails loudly instead of shipping a runtime that
# would try to parse the GTFS zip (and OOM) on the Fly machine.
COPY baked.db ./baked.db

# dotenv.config resolves ../../.env relative to server/dist; absent in the image is harmless —
# Fly injects the real configuration as environment variables.
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
