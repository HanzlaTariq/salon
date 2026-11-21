# syntax=docker/dockerfile:1
# Salon Platform API. Build context: apps/api   (docker build -f apps/api/Dockerfile apps/api)
#
# Targets:
#   runtime (default)  small production image: compiled JS + production dependencies, runs as the unprivileged `node` user.
#   tools              build image with the Prisma CLI and ts-node: `prisma migrate deploy`, `npm run admin:create`, `npm run preflight`.

FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- tools: migrations and one-off commands (never started as the web process)
FROM build AS tools
ENV NODE_ENV=production
USER node
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The generated Prisma client (query engine) comes from the build stage; the runtime image has no Prisma CLI.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# The schema declares `directUrl`, which only migrations use. The API must never hold the owner (postgres) credentials,
# so when DIRECT_URL is not provided it simply mirrors DATABASE_URL.
CMD ["sh", "-c", "DIRECT_URL=\"${DIRECT_URL:-$DATABASE_URL}\" exec node dist/main.js"]
