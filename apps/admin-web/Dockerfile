# syntax=docker/dockerfile:1
# Admin web + TLS reverse proxy. Build context: the REPOSITORY ROOT (the Caddyfile lives in infra/deploy):
#   docker build -f apps/admin-web/Dockerfile .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY apps/admin-web/package.json apps/admin-web/package-lock.json ./
RUN npm ci
COPY apps/admin-web/ ./
# VITE_API_URL stays EMPTY: the browser calls /api on its own origin and Caddy forwards it to the API.
# That keeps the refresh cookie first-party and needs no CORS for the admin panel.
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv/admin
COPY infra/deploy/Caddyfile /etc/caddy/Caddyfile
