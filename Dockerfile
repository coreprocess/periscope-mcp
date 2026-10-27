# syntax=docker/dockerfile:1.7

FROM node:24.22.1-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY patches ./patches

# Production dependencies only, installed from scratch.
FROM base AS deps
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM base AS build
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM node:24.22.1-bookworm-slim
ARG PERISCOPE_VERSION=dev
LABEL org.opencontainers.image.source="https://github.com/coreprocess/periscope-mcp" \
      org.opencontainers.image.description="Read-only MCP server for Postgres, Oracle, SQL Server, Cosmos DB, Blob Storage, Log Analytics, Redis and KIM" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PERISCOPE_VERSION=${PERISCOPE_VERSION} \
    TZ=UTC \
    PERISCOPE_TRANSPORT=http \
    PERISCOPE_PORT=8080
WORKDIR /app
COPY --from=deps --chown=node:node /app/package.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# numeric, so Kubernetes can verify runAsNonRoot (the official image's node user)
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/index.js"]
