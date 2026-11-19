import { assertEquals, assertThrows } from "@std/assert";
import {
  buildLoginUrl,
  createDexcomConfig,
  getEgvs,
  isDexcomApiError,
  refreshTokens,
  toDexcomTimestamp,
  validateWindow,
} from "../mod.ts";

function configWith(fetchImpl: typeof fetch) {
  return createDexcomConfig({
    region: "eu",
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://mcp.example/cb",
    fetch: fetchImpl,
  });
}

Deno.test("region selects the base URL for login", () => {
  const url = buildLoginUrl(configWith(fetch), "s1");
  assertEquals(url.origin, "https://api.dexcom.eu");
  assertEquals(url.searchParams.get("scope"), "offline_access");
  assertEquals(url.searchParams.get("response_type"), "code");
  assertEquals(url.searchParams.get("state"), "s1");
});

Deno.test("timestamps normalize to UTC without offset", () => {
  assertEquals(
    toDexcomTimestamp("2026-11-01T10:00:00-07:00"),
    "2026-11-01T17:00:00",
  );
  assertEquals(toDexcomTimestamp("2026-11-01T10:00:00"), "2026-11-01T10:00:00");
  assertEquals(toDexcomTimestamp("2026-11-01"), "2026-11-01T00:00:00");
});

Deno.test("windows over 30 days or reversed are rejected", () => {
  assertThrows(() =>
    validateWindow({ startDate: "2026-01-01", endDate: "2026-02-15" })
  );
  assertThrows(() =>
    validateWindow({ startDate: "2026-02-01", endDate: "2026-01-01" })
  );
  assertEquals(
    validateWindow({ startDate: "2026-01-01", endDate: "2026-01-31" }).endDate,
    "2026-01-31T00:00:00",
  );
});

Deno.test("data requests send the bearer token and window", async () => {
  let seen: Request | undefined;
  const config = configWith((input, init) => {
    seen = new Request(input, init);
    return Promise.resolve(
      Response.json({
        recordType: "egv",
        recordVersion: "3.0",
        userId: "u",
        records: [],
      }),
    );
  });
  await getEgvs({ config, accessToken: "tok" }, {
    startDate: "2026-11-01T00:00:00Z",
    endDate: "2026-11-02T00:00:00Z",
  });
  const url = new URL(seen!.url);
  assertEquals(url.pathname, "/v3/users/self/egvs");
  assertEquals(url.searchParams.get("startDate"), "2026-11-01T00:00:00");
  assertEquals(seen!.headers.get("authorization"), "Bearer tok");
});

Deno.test("refresh posts form data and surfaces OAuth errors", async () => {
  let body = "";
  const config = configWith(async (input, init) => {
    body = await new Request(input, init).text();
    return Response.json(
      { error: "invalid_grant", error_description: "used" },
      { status: 400 },
    );
  });
  try {
    await refreshTokens(config, "r1");
    throw new Error("expected failure");
  } catch (error) {
    assertEquals(isDexcomApiError(error), true);
    if (isDexcomApiError(error)) {
      assertEquals(error.status, 400);
      assertEquals(error.code, "invalid_grant");
    }
  }
  const form = new URLSearchParams(body);
  assertEquals(form.get("grant_type"), "refresh_token");
  assertEquals(form.get("client_secret"), "secret");
});
