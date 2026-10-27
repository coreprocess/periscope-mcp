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

# Oracle Instant Client Basic Light for PERISCOPE_ORACLE_DRIVER=thick (Native Network Encryption), pinned by
# checksum. Only the OCI libraries stay: no JDBC, C++ or tools.
FROM debian:bookworm-slim AS oracle
ARG TARGETARCH
ARG INSTANT_CLIENT_RELEASE=2390000
ARG INSTANT_CLIENT_VERSION=23.9.0.25.07
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
        amd64) arch=x64; sha256=664a88e52f04ca787184a78b90ce09d34b1af919830be6973688219550e079b3 ;; \
        arm64) arch=arm64; sha256=6fd71c89bad50c4ccf1cb8c9b4a177776a47ca884935b979eda3b9c7d0d4dc16 ;; \
        *) echo "no Instant Client for $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/instantclient.zip \
        "https://download.oracle.com/otn_software/linux/instantclient/${INSTANT_CLIENT_RELEASE}/instantclient-basiclite-linux.${arch}-${INSTANT_CLIENT_VERSION}.zip"; \
    echo "$sha256  /tmp/instantclient.zip" | sha256sum -c -; \
    unzip -q /tmp/instantclient.zip -d /opt/oracle; \
    mv /opt/oracle/instantclient_* /opt/oracle/instantclient; \
    cd /opt/oracle/instantclient; \
    rm -f ./*.jar libocci.so* libocijdbc*.so libtfojdbc*.so adrci genezi uidrvci BASIC_LITE_README

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
RUN apt-get update && apt-get install -y --no-install-recommends libaio1 && rm -rf /var/lib/apt/lists/*
COPY --from=oracle /opt/oracle/instantclient /opt/oracle/instantclient
RUN echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle-instantclient.conf && ldconfig
COPY --from=deps --chown=node:node /app/package.json ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
# numeric, so Kubernetes can verify runAsNonRoot (the official image's node user)
USER 1000:1000
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/index.js"]
