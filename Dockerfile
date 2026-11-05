# Multi-stage build for the Rituals Space web client, a modified Hush web
# client (see README.md for the dated modification notice).
# WASM crypto is installed from @gethush/hush-crypto on npmjs.com (public).
# Admin dashboard is not included here — it is embedded in hush-server.

# --- Stage 1: Vite build (main client) ---
FROM node:22-alpine AS client-builder
WORKDIR /app
COPY .npmrc package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_DEBUG_TOOLBAR=false
ENV VITE_DEBUG_TOOLBAR=$VITE_DEBUG_TOOLBAR
# Rituals fork: public build facts for the AGPL notice in the About dialog.
# Each points at the Corresponding Source of this build; empty keeps the
# client's default, https://space.rit.al/source/. COMMIT is optional and is
# shown next to the version.
ARG VITE_RITUALS_SOURCE_WEB=
ARG VITE_RITUALS_SOURCE_SERVER=
ARG VITE_RITUALS_SOURCE_CRYPTO=
ARG VITE_RITUALS_SOURCE_COMMIT=
ENV VITE_RITUALS_SOURCE_WEB=$VITE_RITUALS_SOURCE_WEB \
    VITE_RITUALS_SOURCE_SERVER=$VITE_RITUALS_SOURCE_SERVER \
    VITE_RITUALS_SOURCE_CRYPTO=$VITE_RITUALS_SOURCE_CRYPTO \
    VITE_RITUALS_SOURCE_COMMIT=$VITE_RITUALS_SOURCE_COMMIT
RUN npm run build

# --- Stage 2: Caddy serve ---
# The Rituals host bundle supplies its own Caddyfile at runtime; the one
# copied here only serves /srv for a standalone run.
FROM caddy:2-alpine
COPY docker/caddy/Caddyfile /etc/caddy/Caddyfile
COPY --from=client-builder /app/dist /srv
