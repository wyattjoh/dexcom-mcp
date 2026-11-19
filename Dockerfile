# syntax=docker/dockerfile:1

# --- Stage 1: Cache dependencies ---
FROM docker.io/denoland/deno:2.9.8 AS deps

WORKDIR /app

COPY deno.json deno.lock ./
COPY packages/dexcom/deno.json packages/dexcom/deno.json
COPY packages/dexcom-mcp/deno.json packages/dexcom-mcp/deno.json

RUN deno install --frozen

# --- Stage 2: Final image ---
FROM docker.io/denoland/deno:2.9.8

LABEL org.opencontainers.image.title="dexcom-mcp" \
      org.opencontainers.image.description="MCP server for the Dexcom API with an OAuth bridge" \
      org.opencontainers.image.source="https://github.com/wyattjoh/dexcom-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=deps /deno-dir /deno-dir
COPY deno.json deno.lock ./
COPY packages/dexcom/deno.json packages/dexcom/mod.ts packages/dexcom/
COPY packages/dexcom/src/ packages/dexcom/src/
COPY packages/dexcom-mcp/deno.json packages/dexcom-mcp/deno.json
COPY packages/dexcom-mcp/src/ packages/dexcom-mcp/src/

RUN deno task check && mkdir -p /data && chown deno:deno /data

USER deno

ENV DEXCOM_MCP_KV_PATH=/data/dexcom-mcp.kv
VOLUME ["/data"]
EXPOSE 3000

ENTRYPOINT ["deno", "run", "--unstable-kv", "--allow-env", "--allow-net", "--allow-read", "--allow-write=/data", "--cached-only", "packages/dexcom-mcp/src/index.ts", "--http", "--host", "0.0.0.0"]
