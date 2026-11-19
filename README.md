# dexcom-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the
[Dexcom API v3](https://developer.dexcom.com/docs/dexcomv3/endpoint-overview),
with read-only tools for CGM data.

In HTTP mode, the server is an OAuth 2.1 authorization server for MCP clients
that bridges to Dexcom's OAuth. Users connect the MCP server, approve access,
sign in at Dexcom, and their client gets an opaque MCP token. Dexcom tokens stay
on the server (as Dexcom requires) and are refreshed automatically.

## Packages

- [`@wyattjoh/dexcom`](packages/dexcom): functional Dexcom API client (OAuth
  helpers, EGVs, events, calibrations, alerts, devices, data range)
- [`@wyattjoh/dexcom-mcp`](packages/dexcom-mcp): the MCP server

## Tools

| Tool                      | Description                                                       |
| ------------------------- | ----------------------------------------------------------------- |
| `dexcom_get_data_range`   | Earliest/latest available EGV, event, and calibration times       |
| `dexcom_get_egvs`         | CGM readings (mg/dL, optional mmol/L) with trends, ≤30-day window |
| `dexcom_glucose_summary`  | Mean, GMI, SD/CV, time in consensus ranges, ≤30-day window        |
| `dexcom_get_events`       | User-entered carbs, insulin, exercise, health events              |
| `dexcom_get_calibrations` | Fingerstick calibrations                                          |
| `dexcom_get_alerts`       | High/low/urgent-low/rise/fall/no-reading alerts                   |
| `dexcom_get_devices`      | Devices, transmitters, alert schedules and thresholds             |

Query windows are UTC, inclusive of `startDate`, exclusive of `endDate`, and
limited to 30 days. Dexcom delays mobile-app data by 1 hour in the US and 3
hours elsewhere.

## Setup

1. Register an app at <https://developer.dexcom.com> and note its client ID and
   secret.
2. Add redirect URIs to the app:
   - HTTP mode: `{MCP_PUBLIC_URL}/oauth/dexcom/callback`
   - Stdio mode: `DEXCOM_REDIRECT_URI` (default
     `http://localhost:8765/callback`)
3. Copy `.env.example` to `.env` and fill it in. Start with
   `DEXCOM_REGION=sandbox`.

### HTTP (remote, multi-user)

```bash
deno task start:http --port 3000 --host 127.0.0.1   # local
MCP_PUBLIC_URL=https://dexcom.example.com deno task start:http --host 0.0.0.0
```

Point an MCP client at `{MCP_PUBLIC_URL}/mcp`. It will discover the
authorization server, register dynamically, and open the consent page.

| Endpoint                                    | Purpose                                                     |
| ------------------------------------------- | ----------------------------------------------------------- |
| `/.well-known/oauth-protected-resource/mcp` | RFC 9728 resource metadata                                  |
| `/.well-known/oauth-authorization-server`   | RFC 8414 server metadata                                    |
| `POST /register`                            | RFC 7591 dynamic client registration (public clients, PKCE) |
| `GET/POST /authorize`                       | Consent page, then redirect to Dexcom login                 |
| `GET /oauth/dexcom/callback`                | Dexcom redirect; exchanges the code server-side             |
| `POST /token`                               | `authorization_code` (PKCE S256) and `refresh_token` grants |
| `POST /mcp`                                 | Bearer-protected Streamable HTTP MCP endpoint               |
| `GET /health`                               | Health check                                                |

On a non-loopback host, `MCP_PUBLIC_URL` must be https.

### Stdio (local, single user)

```bash
deno task login   # opens Dexcom login, stores the grant in Deno KV
deno task start   # serves MCP on stdio
```

MCP clients launch the server from their own working directory, so `.env` in
this repo isn't read. Pass the credentials explicitly. Claude Code example:

```bash
claude mcp add dexcom \
  -e DEXCOM_CLIENT_ID=... -e DEXCOM_CLIENT_SECRET=... -e DEXCOM_REGION=sandbox \
  -- deno run --unstable-kv -A /path/to/dexcom-mcp/packages/dexcom-mcp/src/index.ts
```

Grants live in Deno KV at `DEXCOM_MCP_KV_PATH`. By default that's a per-user
data directory (`~/Library/Application Support/dexcom-mcp/` on macOS,
`$XDG_DATA_HOME` or `~/.local/share/dexcom-mcp/` on Linux,
`%LOCALAPPDATA%\dexcom-mcp\` on Windows), so `login` and the stdio server share
it regardless of the working directory.

### Docker

```bash
docker build -t dexcom-mcp .
docker run -p 3000:3000 -v dexcom-data:/data --env-file .env \
  -e MCP_PUBLIC_URL=https://dexcom.example.com dexcom-mcp
```

## Development

```bash
deno task check
deno task lint
deno task fmt
deno task test
```

## License

MIT
