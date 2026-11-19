# Changelog

## [0.2.0](https://github.com/wyattjoh/dexcom-mcp/compare/dexcom-mcp-v0.1.0...dexcom-mcp-v0.2.0) (2026-11-19)


### ⚠ BREAKING CHANGES

* hosted-mode MCP tokens issued by 0.1.0 are no longer accepted, so connected clients sign in again once. dexcom_get_egvs returns compact records. MCP_PUBLIC_URL must be https unless it is a loopback address. On macOS, XDG_DATA_HOME no longer moves the KV file.

### Bug Fixes

* harden the OAuth bridge and refresh path from review findings ([35ca298](https://github.com/wyattjoh/dexcom-mcp/commit/35ca298dfe54b02cd80934bc0e203ecf45566d4b))
* refuse replayed pre-family refresh tokens with invalid_grant ([0b8887f](https://github.com/wyattjoh/dexcom-mcp/commit/0b8887f63128489163a09e8137a26bddc29af85d))
* tolerate refresh retries and document the 0.1.0 upgrade ([40ea4a9](https://github.com/wyattjoh/dexcom-mcp/commit/40ea4a9aa5dc58f483fbd981a362897a7295603a))

## 0.1.0 (2026-11-19)


### Features

* add Dexcom MCP server with OAuth bridge ([6eb3cf9](https://github.com/wyattjoh/dexcom-mcp/commit/6eb3cf98d4abc30741330c0144e7fbdcc93ff458))


### Bug Fixes

* bind Dexcom callback to the consenting browser ([dbd2423](https://github.com/wyattjoh/dexcom-mcp/commit/dbd242373abd42c172b5e9d850ee1d906b40930e))
