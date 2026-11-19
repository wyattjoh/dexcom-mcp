# @wyattjoh/dexcom

Functional client for the [Dexcom API v3](https://developer.dexcom.com).

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
