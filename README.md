# Dexcom MCP

[![JSR](https://jsr.io/badges/@wyattjoh/dexcom-mcp)](https://jsr.io/@wyattjoh/dexcom-mcp)
[![JSR](https://jsr.io/badges/@wyattjoh/dexcom)](https://jsr.io/@wyattjoh/dexcom)

Connect Claude and other [MCP](https://modelcontextprotocol.io) clients to your
Dexcom CGM data. Ask questions like "how was my time in range last week?" or
"when did I go low overnight?" and the assistant reads your glucose readings,
events, and alerts from the official [Dexcom API](https://developer.dexcom.com).

Access is read-only. You sign in with Dexcom yourself, and your Dexcom login and
tokens never reach the AI client.

## What you can ask about

| Tool                      | What it returns                                                      |
| ------------------------- | -------------------------------------------------------------------- |
| `dexcom_get_data_range`   | The earliest and latest data available                               |
| `dexcom_get_egvs`         | Glucose readings (mg/dL, optionally mmol/L) with trend arrows        |
| `dexcom_glucose_summary`  | Average glucose, GMI (estimated A1c), variability, and time in range |
| `dexcom_get_events`       | Carbs, insulin, exercise, and health events you logged               |
| `dexcom_get_calibrations` | Fingerstick calibrations                                             |
| `dexcom_get_alerts`       | High, low, urgent low, rise, fall, and signal-loss alerts            |
| `dexcom_get_devices`      | Your devices and their alert settings                                |

Each request covers up to 30 days. Dexcom delays app data by about 1 hour in the
US and 3 hours elsewhere, so the newest readings may not show up yet.

## Before you start

1. Install [Deno](https://docs.deno.com/runtime/getting_started/installation/)
   2.x.
2. Create a free developer account and app at
   [developer.dexcom.com](https://developer.dexcom.com). Note the **Client ID**
   and **Client Secret**.
3. Add a **redirect URI** to the app. Which one depends on how you run the
   server (below).

New Dexcom apps start in the **sandbox**, which serves sample data and doesn't
need a real Dexcom password. To read your own data, request production access
from Dexcom and set `DEXCOM_REGION` to `us`, `eu`, or `jp`.

## Option 1: Run it on your computer (one user)

Use this with Claude Code, Claude Desktop, or any client that launches MCP
servers locally.

1. Add `http://localhost:8765/callback` as a redirect URI in your Dexcom app.

2. Install the command:

   <!-- x-release-please-start-version -->
   ```bash
   deno install --global --name dexcom-mcp --unstable-kv --allow-net --allow-env --allow-read --allow-write --allow-run jsr:@wyattjoh/dexcom-mcp@0.2.0
   ```
   <!-- x-release-please-end -->

3. Sign in with Dexcom. A browser window opens; approve access and close it when
   it says you're connected.

   ```bash
   DEXCOM_CLIENT_ID=your-id DEXCOM_CLIENT_SECRET=your-secret DEXCOM_REGION=sandbox \
     dexcom-mcp login
   ```

4. Add the server to your MCP client.

   **Claude Code**

   ```bash
   claude mcp add dexcom \
     -e DEXCOM_CLIENT_ID=your-id \
     -e DEXCOM_CLIENT_SECRET=your-secret \
     -e DEXCOM_REGION=sandbox \
     -- dexcom-mcp
   ```

   **Claude Desktop** (`claude_desktop_config.json`), or any client that takes a
   JSON config:

   <!-- x-release-please-start-version -->
   ```json
   {
     "mcpServers": {
       "dexcom": {
         "command": "deno",
         "args": [
           "run",
           "--unstable-kv",
           "--allow-net",
           "--allow-env",
           "--allow-read",
           "--allow-write",
           "--allow-run",
           "jsr:@wyattjoh/dexcom-mcp@0.2.0"
         ],
         "env": {
           "DEXCOM_CLIENT_ID": "your-id",
           "DEXCOM_CLIENT_SECRET": "your-secret",
           "DEXCOM_REGION": "sandbox"
         }
       }
     }
   }
   ```
   <!-- x-release-please-end -->

Your Dexcom sign-in is saved in a local database and refreshed automatically. It
lasts up to a year, or until you revoke access at dexcom.com. Run
`dexcom-mcp login` again if the assistant reports that authorization is missing.

## Option 2: Host it for remote clients (many users)

In this mode the server is a remote MCP server with its own OAuth sign-in, for
clients that connect by URL (Claude connectors, for example). Each person who
connects approves access, signs in with Dexcom, and only sees their own data.

1. Choose the public HTTPS address the server will have, e.g.
   `https://dexcom.example.com`.
2. Add `https://dexcom.example.com/oauth/dexcom/callback` as a redirect URI in
   your Dexcom app.
3. Start the server behind your HTTPS proxy:

   <!-- x-release-please-start-version -->
   ```bash
   DEXCOM_CLIENT_ID=your-id \
   DEXCOM_CLIENT_SECRET=your-secret \
   DEXCOM_REGION=us \
   MCP_PUBLIC_URL=https://dexcom.example.com \
     deno run --unstable-kv --allow-net --allow-env --allow-read --allow-write --allow-run jsr:@wyattjoh/dexcom-mcp@0.2.0 --http --host 0.0.0.0 --port 3000
   ```
   <!-- x-release-please-end -->

   Or with Docker:

   <!-- x-release-please-start-version -->
   ```bash
   docker build -t dexcom-mcp https://github.com/wyattjoh/dexcom-mcp.git#dexcom-mcp-v0.2.0
   docker run -d -p 3000:3000 -v dexcom-data:/data \
     -e DEXCOM_CLIENT_ID=your-id -e DEXCOM_CLIENT_SECRET=your-secret \
     -e DEXCOM_REGION=us -e MCP_PUBLIC_URL=https://dexcom.example.com \
     dexcom-mcp
   ```
   <!-- x-release-please-end -->

4. In your MCP client, add the server URL `https://dexcom.example.com/mcp`. The
   client opens a consent page, then Dexcom's sign-in.

To try it locally first, run with `--host 127.0.0.1`, leave `MCP_PUBLIC_URL`
unset (it defaults to `http://localhost:3000`), and register
`http://localhost:3000/oauth/dexcom/callback` with Dexcom.

## Configuration

| Variable                | Required | Description                                                                                                                                                                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DEXCOM_CLIENT_ID`      | Yes      | Your Dexcom app's client ID                                                                                                                                                                                                                                          |
| `DEXCOM_CLIENT_SECRET`  | Yes      | Your Dexcom app's client secret                                                                                                                                                                                                                                      |
| `DEXCOM_REGION`         | No       | `sandbox` (default), `us`, `eu` (EU and outside the US), or `jp`                                                                                                                                                                                                     |
| `MCP_PUBLIC_URL`        | Option 2 | Public origin of the server, no path. Must be `https` unless it is a loopback address (`localhost`, `127.0.0.1`, `[::1]`) and the server binds to loopback                                                                                                           |
| `DEXCOM_REDIRECT_URI`   | No       | Option 1 sign-in callback; default `http://localhost:8765/callback`                                                                                                                                                                                                  |
| `DEXCOM_MCP_KV_PATH`    | No       | Where sign-ins are stored. Default: `~/Library/Application Support/dexcom-mcp/` (macOS), `$XDG_DATA_HOME/dexcom-mcp/` or `~/.local/share/dexcom-mcp/` (Linux), `%LOCALAPPDATA%\dexcom-mcp\` (Windows); `/data` in Docker. `dexcom-mcp login` prints the path it used |
| `MCP_ALLOWED_ORIGINS`   | No       | Browser origins allowed to call `/mcp`; default `localhost,127.0.0.1,[::1]`                                                                                                                                                                                          |
| `MCP_ACCESS_TOKEN_TTL`  | No       | Lifetime of tokens given to MCP clients, in seconds (default 3600)                                                                                                                                                                                                   |
| `MCP_REFRESH_TOKEN_TTL` | No       | How long a client stays signed in after approving access, in seconds (default 30 days). Refreshing does not extend it; the user approves again afterwards                                                                                                            |

Variables can also go in a `.env` file in the directory you start the server
from.

## Upgrading from 0.1.0

- Hosted servers (Option 2): MCP clients connected under 0.1.0 must sign in
  again once, because tokens are now tracked per sign-in so a leaked refresh
  token can be revoked.
- `dexcom_get_egvs` returns compact records (`systemTime`, `displayTime`,
  `value`, `status`, `trend`, `trendRate`) instead of the full Dexcom response.
- `MCP_PUBLIC_URL` must be `https` unless it is a loopback address, even when
  the server binds to `127.0.0.1` behind a proxy.
- macOS: `XDG_DATA_HOME` is no longer used. If you had it set when you ran
  `dexcom-mcp login`, run `login` again or set `DEXCOM_MCP_KV_PATH` to the old
  file.

## Privacy and security

- The server only reads data. It cannot change anything in your Dexcom account.
- Dexcom tokens are stored on the machine running the server and are never sent
  to MCP clients. Clients get separate tokens that only work through this
  server.
- Revoke access anytime at [dexcom.com](https://www.dexcom.com) under your
  account's authorized apps. The server then asks you to sign in again.
- Keep your client secret private. If it leaks, regenerate it in the Dexcom
  developer portal.

## Troubleshooting

- **"No Dexcom authorization found"**: run `dexcom-mcp login` with the same
  `DEXCOM_MCP_KV_PATH` the server uses.
- **Dexcom says the redirect URI is invalid**: the URI registered in your Dexcom
  app must match exactly, including port and path.
- **No recent readings**: Dexcom delays app uploads by 1 to 3 hours. Ask for the
  data range to see what's available.
- **"This version is blocked by the minimum dependency age policy"**: Deno 2.9+
  won't install a package version in its first 24 hours. Wait a day after a
  release, or add `--min-dep-age=0` to the command.
- **Readings from the sandbox look fake**: they are. Switch `DEXCOM_REGION`
  after Dexcom grants production access.

## Using the API client directly

[`@wyattjoh/dexcom`](packages/dexcom) is the Dexcom API client this server is
built on, published separately:

```bash
deno add jsr:@wyattjoh/dexcom
```

## Development

```bash
git clone https://github.com/wyattjoh/dexcom-mcp.git && cd dexcom-mcp
cp .env.example .env
lefthook install        # fmt/lint on commit; check, test, lockfile on push
deno task test          # unit and integration tests (fake Dexcom, no credentials needed)
deno task check && deno task lint && deno fmt --check
deno task dev:http      # local HTTP server with reload
deno task login && deno task start   # stdio from source
```

Install commands in the READMEs are pinned to the latest release. Release-please
rewrites every version between `x-release-please-start-version` and
`x-release-please-end` markers, so keep new install snippets inside those
markers.

Releases are automated with
[release-please](https://github.com/googleapis/release-please): merging the
release PR publishes both packages to JSR. Use
[Conventional Commits](https://www.conventionalcommits.org/).

## License

MIT. Not affiliated with or endorsed by Dexcom, Inc.
