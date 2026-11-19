# @wyattjoh/dexcom

Functional client for the [Dexcom API v3](https://developer.dexcom.com): OAuth
helpers plus read-only access to glucose readings (EGVs), events, calibrations,
alerts, devices, and data ranges. Used by
[`@wyattjoh/dexcom-mcp`](https://jsr.io/@wyattjoh/dexcom-mcp).

<!-- x-release-please-start-version -->

```bash
deno add jsr:@wyattjoh/dexcom@0.1.0
```

<!-- x-release-please-end -->

```ts
import {
  buildLoginUrl,
  createDexcomConfig,
  exchangeCode,
  getEgvs,
} from "@wyattjoh/dexcom";

const config = createDexcomConfig({
  region: "sandbox",
  clientId: "...",
  clientSecret: "...",
  redirectUri: "https://example.com/callback",
});

const loginUrl = buildLoginUrl(config, crypto.randomUUID());
// ...user signs in, Dexcom redirects with ?code=...
const tokens = await exchangeCode(config, code);
const egvs = await getEgvs(
  { config, accessToken: tokens.access_token },
  { startDate: "2026-11-01T00:00:00", endDate: "2026-11-02T00:00:00" },
);
```

Refresh tokens are single use: persist the token returned by `refreshTokens`
before using the new access token.

Requests are limited to 30-day windows (`validateWindow` enforces this).
Regions: `us`, `eu`, `jp`, and `sandbox`; the login, token, and data calls must
use the same one.
