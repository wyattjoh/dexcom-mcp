# @wyattjoh/dexcom-mcp

An [MCP](https://modelcontextprotocol.io) server that gives Claude and other AI
clients read-only access to your Dexcom CGM data: glucose readings, time in
range, events, alerts, and devices.

You sign in with Dexcom yourself; your Dexcom tokens stay on the machine running
the server.

## Quick start (local)

Create an app at [developer.dexcom.com](https://developer.dexcom.com) and add
`http://localhost:8765/callback` as a redirect URI. Then:

<!-- x-release-please-start-version -->

```bash
deno install --global --name dexcom-mcp --unstable-kv --allow-net --allow-env --allow-read --allow-write --allow-run jsr:@wyattjoh/dexcom-mcp@0.2.0

DEXCOM_CLIENT_ID=your-id DEXCOM_CLIENT_SECRET=your-secret dexcom-mcp login

claude mcp add dexcom -e DEXCOM_CLIENT_ID=your-id -e DEXCOM_CLIENT_SECRET=your-secret -- dexcom-mcp
```

<!-- x-release-please-end -->

## Hosted (remote MCP with OAuth)

<!-- x-release-please-start-version -->

```bash
MCP_PUBLIC_URL=https://dexcom.example.com DEXCOM_CLIENT_ID=... DEXCOM_CLIENT_SECRET=... \
  deno run --unstable-kv --allow-net --allow-env --allow-read --allow-write --allow-run jsr:@wyattjoh/dexcom-mcp@0.2.0 --http --host 0.0.0.0
```

<!-- x-release-please-end -->

Register `https://dexcom.example.com/oauth/dexcom/callback` with Dexcom and
connect clients to `https://dexcom.example.com/mcp`.

See the [full guide](https://github.com/wyattjoh/dexcom-mcp#readme) for Claude
Desktop setup, Docker, configuration, and troubleshooting.

## Tools

| Tool                      | What it returns                                  |
| ------------------------- | ------------------------------------------------ |
| `dexcom_get_data_range`   | The earliest and latest data available           |
| `dexcom_get_egvs`         | Glucose readings with trend arrows               |
| `dexcom_glucose_summary`  | Average glucose, GMI, variability, time in range |
| `dexcom_get_events`       | Logged carbs, insulin, exercise, health events   |
| `dexcom_get_calibrations` | Fingerstick calibrations                         |
| `dexcom_get_alerts`       | Glucose alerts                                   |
| `dexcom_get_devices`      | Devices and alert settings                       |
