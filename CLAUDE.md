# CLAUDE.md

This file provides guidance to coding agents working in this repository.

## Project Overview

A Deno workspace with a functional Dexcom API v3 client and an MCP server. In
HTTP mode, the server is an OAuth 2.1 authorization server for MCP clients and a
confidential OAuth client of Dexcom. Clients receive opaque MCP tokens; Dexcom
tokens never leave the server.

## Development Commands

- `deno task check` - Type-check both packages
- `deno task lint` - Lint
- `deno task fmt` - Format (`deno fmt --check` in CI)
- `deno task test` - Run all tests (fake Dexcom upstream, in-memory KV)
- `deno task start` / `deno task start:http` - Stdio / HTTP server
- `deno task login` - Interactive Dexcom login for stdio mode
- `deno task publish:check` - Validate JSR packages

KV is unstable in Deno 2: `"unstable": ["kv"]` in `deno.json` covers tasks;
direct `deno run` needs `--unstable-kv`.

## Workspace Structure

- `packages/dexcom/` - `@wyattjoh/dexcom`: `src/config.ts` (regions),
  `src/oauth.ts` (login URL, code exchange, refresh), `src/client.ts` (private
  `makeRequest`, data endpoints, 30-day window validation), `src/errors.ts`,
  `src/types.ts`
- `packages/dexcom-mcp/` - `@wyattjoh/dexcom-mcp`:
  - `src/index.ts` - cliffy CLI and env config
  - `src/store.ts` - Deno KV store (clients, consents, pending upstream states,
    codes, hashed MCP tokens, Dexcom grants)
  - `src/session.ts` - Dexcom token refresh: single-flight per user,
    compare-and-swap persistence, 401 retry, grant deletion on rejected refresh
  - `src/oauth/` - discovery metadata, DCR, consent/authorize, Dexcom callback,
    token endpoint, bearer verifier
  - `src/transports/http.ts` - fetch-style router served with `Deno.serve`;
    `/mcp` uses the SDK's `createMcpHandler` with `verifyBearerToken`
  - `src/transports/stdio.ts` - `serveStdio` using the `local` grant
  - `src/tools/` - tool registration, `wrapToolHandler`, glucose summary math

Keep Dexcom protocol behavior in `@wyattjoh/dexcom`. MCP files validate input,
adapt results, and own the OAuth bridge.

## Conventions

- Functional style, no classes; errors are plain `Error`s with a `name`
  discriminant and `is*` guards
- `exactOptionalPropertyTypes` is on; prefer `| undefined`
- JSDoc (multi-line) on every export
- Tool handlers are wrapped with `wrapToolHandler`; don't add per-tool try/catch
- All fetches use `AbortSignal.timeout`

## OAuth Bridge Invariants

- Dexcom authorization codes are single use and expire in one minute: exchange
  them inside the callback, never at `/token`
- Dexcom refresh tokens are single use: always go through
  `createDexcomSessions`, which persists rotated tokens before use
- Never return or log Dexcom tokens; MCP tokens are stored only as SHA-256
  hashes
- MCP access tokens are valid only while the user's Dexcom grant exists
- `/authorize` requires PKCE S256 and an exact registered `redirect_uri`;
  consent is bound to a SameSite=Strict cookie, and the Dexcom callback to a
  SameSite=Lax cookie set on approval (so a forwarded Dexcom login URL cannot
  complete someone else's authorization)
- Only a Dexcom 400 on refresh deletes a grant; 429/401/5xx are rethrown
- The same region host serves login, token, and data calls

## Environment Variables

See `.env.example`. Required: `DEXCOM_CLIENT_ID`, `DEXCOM_CLIENT_SECRET`. HTTP:
`MCP_PUBLIC_URL` (origin only, https off loopback). Stdio: `DEXCOM_REDIRECT_URI`
(loopback). Optional: `DEXCOM_REGION`, `DEXCOM_BASE_URL`, `DEXCOM_MCP_KV_PATH`,
`MCP_ALLOWED_ORIGINS`, `MCP_ACCESS_TOKEN_TTL`, `MCP_REFRESH_TOKEN_TTL`.

## Releases

release-please (`release-please-config.json`, `.release-please-manifest.json`)
versions both packages from Conventional Commits and bumps each `deno.json`
version. Merging the release PR runs `.github/workflows/release.yml`, which
publishes to JSR with GitHub OIDC (`deno publish`). Human-facing docs use
`jsr:@wyattjoh/dexcom-mcp`; keep them in sync with CLI flags and env vars.

## Reference

The Dexcom OpenAPI bundle is at
https://developer.dexcom.com/docs/_bundle/swaggerV3.json.
