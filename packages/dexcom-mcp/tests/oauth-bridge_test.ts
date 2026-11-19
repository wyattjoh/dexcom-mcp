import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { encodeBase64Url, sha256 } from "../src/crypto.ts";
import { createHttpHandler, type HttpHandler } from "../src/transports/http.ts";
import { createFixture, FAKE_USER_ID, type Fixture } from "./helpers.ts";

const BASE = "http://localhost:3000";
const CLIENT_REDIRECT = "http://127.0.0.1:9999/callback";

function newVerifier(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function setup(
  overrides: Partial<Fixture["ctx"]> = {},
): Promise<{ fx: Fixture; http: HttpHandler }> {
  const fx = await createFixture();
  const http = createHttpHandler({
    ctx: { ...fx.ctx, ...overrides },
    allowedOriginHostnames: ["localhost"],
    allowInsecureIssuer: true,
  });
  return { fx, http };
}

function call(
  http: HttpHandler,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return http.fetch(new Request(`${BASE}${path}`, init));
}

async function register(http: HttpHandler): Promise<string> {
  const response = await call(http, "/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Test",
      redirect_uris: [CLIENT_REDIRECT],
    }),
  });
  assertEquals(response.status, 201);
  return (await response.json()).client_id;
}

/**
 * Drives the full browser flow and returns the MCP authorization code.
 */
let lastCallback: { upstreamState: string; callbackCookie: string } | undefined;

async function authorize(
  http: HttpHandler,
  clientId: string,
  verifier: string,
  withCallback = true,
): Promise<URL> {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: CLIENT_REDIRECT,
    response_type: "code",
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    state: "client-state",
    resource: `${BASE}/mcp`,
  });
  const consent = await call(http, `/authorize?${params}`);
  assertEquals(consent.status, 200);
  const html = await consent.text();
  const consentId = html.match(/name="consent_id" value="([^"]+)"/)?.[1];
  assert(consentId);
  const cookie = consent.headers.get("set-cookie")?.split(";")[0];
  assert(cookie);

  const approved = await call(http, "/authorize", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookie,
    },
    body: new URLSearchParams({ consent_id: consentId, action: "approve" }),
  });
  assertEquals(approved.status, 302);
  const login = new URL(approved.headers.get("location")!);
  assertEquals(login.pathname, "/v3/oauth2/login");
  assertEquals(login.searchParams.get("scope"), "offline_access");
  assertEquals(
    login.searchParams.get("redirect_uri"),
    `${BASE}/oauth/dexcom/callback`,
  );
  const upstreamState = login.searchParams.get("state")!;
  const callbackCookie = approved.headers.getSetCookie()
    .find((value) => value.startsWith("dexcom_mcp_callback="))
    ?.split(";")[0];
  assert(callbackCookie, "callback binding cookie missing");
  lastCallback = { upstreamState, callbackCookie };

  // Simulate Dexcom redirecting the browser back.
  if (!withCallback) return undefined as unknown as URL;
  const callback = await call(
    http,
    `/oauth/dexcom/callback?code=dexcom-code&state=${upstreamState}`,
    { headers: { Cookie: callbackCookie } },
  );
  assertEquals(callback.status, 302);
  return new URL(callback.headers.get("location")!);
}

async function exchange(
  http: HttpHandler,
  clientId: string,
  code: string,
  verifier: string,
): Promise<Response> {
  return await call(http, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: CLIENT_REDIRECT,
    }),
  });
}

async function connectClient(
  http: HttpHandler,
  accessToken: string,
  mode: "legacy" | "auto" = "legacy",
): Promise<Client> {
  const client = new Client({ name: "test", version: "1.0.0" }, {
    versionNegotiation: { mode },
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    fetch: (input, init) => http.fetch(new Request(input, init)),
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
  await client.connect(transport);
  return client;
}

Deno.test("unauthenticated /mcp returns a discoverable 401 challenge", async () => {
  const { fx, http } = await setup();
  try {
    const response = await call(http, "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assertEquals(response.status, 401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    assertMatch(
      challenge,
      /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/,
    );

    const prm =
      await (await call(http, "/.well-known/oauth-protected-resource/mcp"))
        .json();
    assertEquals(prm.resource, `${BASE}/mcp`);
    assertEquals(prm.authorization_servers, [BASE]);

    const as =
      await (await call(http, "/.well-known/oauth-authorization-server"))
        .json();
    assertEquals(as.code_challenge_methods_supported, ["S256"]);
    assertEquals(as.registration_endpoint, `${BASE}/register`);
  } finally {
    fx.close();
  }
});

Deno.test("full bridge flow issues opaque tokens and serves tools", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const verifier = newVerifier();
    const redirect = await authorize(http, clientId, verifier);
    assertEquals(redirect.searchParams.get("state"), "client-state");
    assertEquals(redirect.searchParams.get("iss"), BASE);
    const code = redirect.searchParams.get("code")!;

    const tokenResponse = await exchange(http, clientId, code, verifier);
    assertEquals(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert(
      !String(tokens.access_token).startsWith("dex-"),
      "Dexcom token leaked",
    );
    assert(
      !String(tokens.refresh_token).startsWith("dex-"),
      "Dexcom token leaked",
    );

    const stored = await fx.store.getGrant(FAKE_USER_ID);
    assertEquals(stored?.grant.accessToken, "dex-access-1");

    const client = await connectClient(http, tokens.access_token);
    const tools = await client.listTools();
    assert(tools.tools.some((tool) => tool.name === "dexcom_get_egvs"));

    const summary = await client.callTool({
      name: "dexcom_glucose_summary",
      arguments: {
        startDate: "2026-11-17T00:00:00",
        endDate: "2026-11-18T00:00:00",
      },
    });
    assert(!summary.isError);
    const text = (summary.content as Array<{ text: string }>)[0]!.text;
    assertEquals(JSON.parse(text).readings, 4);
    await client.close();

    // Authorization codes are single use.
    const reuse = await exchange(http, clientId, code, verifier);
    assertEquals(reuse.status, 400);

    // Refresh rotates the MCP refresh token.
    const refreshBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    const refreshed = await call(http, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    assertEquals(refreshed.status, 200);
    const replay = await call(http, "/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: refreshBody,
    });
    assertEquals(replay.status, 400);
  } finally {
    await http.close();
    fx.close();
  }
});

Deno.test("PKCE mismatch and wrong redirect are rejected", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const verifier = newVerifier();
    const redirect = await authorize(http, clientId, verifier);
    const bad = await exchange(
      http,
      clientId,
      redirect.searchParams.get("code")!,
      newVerifier(),
    );
    assertEquals(bad.status, 400);
    assertEquals((await bad.json()).error, "invalid_grant");

    const wrongRedirect = await call(
      http,
      `/authorize?client_id=${clientId}&redirect_uri=${
        encodeURIComponent("https://evil.example/cb")
      }&response_type=code&code_challenge=${await sha256(
        verifier,
      )}&code_challenge_method=S256`,
    );
    assertEquals(wrongRedirect.status, 400);
    assertEquals(wrongRedirect.headers.get("location"), null);
  } finally {
    fx.close();
  }
});

Deno.test("consent POST without the browser cookie is refused", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: CLIENT_REDIRECT,
      response_type: "code",
      code_challenge: await sha256(newVerifier()),
      code_challenge_method: "S256",
    });
    const html = await (await call(http, `/authorize?${params}`)).text();
    const consentId = html.match(/name="consent_id" value="([^"]+)"/)?.[1]!;
    const response = await call(http, "/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ consent_id: consentId, action: "approve" }),
    });
    assertEquals(response.status, 403);
  } finally {
    fx.close();
  }
});

Deno.test("upstream 401 refreshes once and retries; revoked grant forces re-auth", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const verifier = newVerifier();
    const redirect = await authorize(http, clientId, verifier);
    const tokens = await (await exchange(
      http,
      clientId,
      redirect.searchParams.get("code")!,
      verifier,
    )).json();
    const client = await connectClient(http, tokens.access_token);

    // Dexcom invalidates the access token early.
    fx.dexcom.validAccessTokens.clear();
    const result = await client.callTool({
      name: "dexcom_get_devices",
      arguments: {},
    });
    assert(!result.isError, JSON.stringify(result));
    assertEquals(fx.dexcom.refreshCount(), 1);

    // User revokes at Dexcom: both tokens die.
    fx.dexcom.validAccessTokens.clear();
    fx.dexcom.validRefreshTokens.clear();
    const failed = await client.callTool({
      name: "dexcom_get_devices",
      arguments: {},
    });
    assert(failed.isError);
    assertEquals(await fx.store.getGrant(FAKE_USER_ID), undefined);
    await client.close();

    const after = await call(http, "/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.access_token}`,
      },
      body: "{}",
    });
    assertEquals(after.status, 401);
  } finally {
    await http.close();
    fx.close();
  }
});

Deno.test("Dexcom callback from another browser is refused", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    await authorize(http, clientId, newVerifier(), false);
    const { upstreamState } = lastCallback!;
    // A victim's browser lacks the attacker's binding cookie.
    const response = await call(
      http,
      `/oauth/dexcom/callback?code=dexcom-code&state=${upstreamState}`,
    );
    assertEquals(response.status, 403);
    assertEquals(response.headers.get("location"), null);
    assertEquals(await fx.store.getGrant(FAKE_USER_ID), undefined);
    assertEquals(fx.dexcom.calls.includes("POST /v3/oauth2/token"), false);
  } finally {
    fx.close();
  }
});

Deno.test("modern-era clients receive authInfo and can call tools", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const verifier = newVerifier();
    const redirect = await authorize(http, clientId, verifier);
    const tokens = await (await exchange(
      http,
      clientId,
      redirect.searchParams.get("code")!,
      verifier,
    )).json();
    const client = await connectClient(http, tokens.access_token, "auto");
    const result = await client.callTool({
      name: "dexcom_get_data_range",
      arguments: {},
    });
    assert(!result.isError, JSON.stringify(result));
    await client.close();
  } finally {
    await http.close();
    fx.close();
  }
});

async function refreshWith(
  http: HttpHandler,
  clientId: string,
  refreshToken: string,
): Promise<Response> {
  return await call(http, "/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }),
  });
}

async function mcpStatus(http: HttpHandler, accessToken: string) {
  const response = await call(http, "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  await response.body?.cancel();
  return response.status;
}

async function newTokens(http: HttpHandler, clientId: string) {
  const verifier = newVerifier();
  const redirect = await authorize(http, clientId, verifier);
  const response = await exchange(
    http,
    clientId,
    redirect.searchParams.get("code")!,
    verifier,
  );
  assertEquals(response.status, 200);
  return await response.json() as {
    access_token: string;
    refresh_token: string;
  };
}

function oversizedBody(totalBytes: number) {
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x61);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  return { stream, sent: () => sent };
}

Deno.test("oversized streamed bodies are rejected without buffering them", async () => {
  const { fx, http } = await setup();
  try {
    for (
      const [path, type] of [
        ["/register", "application/json"],
        ["/token", "application/x-www-form-urlencoded"],
      ]
    ) {
      const body = oversizedBody(64 * 1024 * 1024);
      const response = await call(http, path!, {
        method: "POST",
        headers: { "Content-Type": type! },
        body: body.stream,
      });
      assertEquals(response.status, 400, path);
      await response.body?.cancel();
      assert(body.sent() < 1024 * 1024, `${path} read ${body.sent()} bytes`);
    }
  } finally {
    fx.close();
  }
});

Deno.test("a refresh retry by the same client keeps the new tokens valid", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const first = await newTokens(http, clientId);
    const [a, b] = await Promise.all([
      refreshWith(http, clientId, first.refresh_token),
      refreshWith(http, clientId, first.refresh_token),
    ]);
    const statuses = [a.status, b.status].sort();
    assertEquals(statuses, [200, 400]);
    const winner = await (a.status === 200 ? a : b).json();
    await (a.status === 200 ? b : a).body?.cancel();
    assert(await mcpStatus(http, winner.access_token) !== 401);
    assertEquals(
      (await refreshWith(http, clientId, winner.refresh_token)).status,
      200,
    );
  } finally {
    await http.close();
    fx.close();
  }
});

Deno.test("a replayed refresh token revokes its whole token family", async () => {
  // Outside the retry grace window, as when a stolen token is used later.
  const { fx, http } = await setup({ refreshRetryGraceMs: 0 });
  try {
    const clientId = await register(http);
    const first = await newTokens(http, clientId);
    // The attacker redeems the stolen refresh token first.
    const attacker = await (await refreshWith(
      http,
      clientId,
      first.refresh_token,
    )).json();
    assert(attacker.refresh_token);
    // The legitimate client's replay is detected...
    assertEquals(
      (await refreshWith(http, clientId, first.refresh_token)).status,
      400,
    );
    // ...and every token in the family dies, including the attacker's.
    assertEquals(
      (await refreshWith(http, clientId, attacker.refresh_token)).status,
      400,
    );
    assertEquals(await mcpStatus(http, attacker.access_token), 401);
    assertEquals(await mcpStatus(http, first.access_token), 401);

    // Another authorization of the same user is unaffected.
    const other = await newTokens(http, clientId);
    assert(await mcpStatus(http, other.access_token) !== 401);
  } finally {
    await http.close();
    fx.close();
  }
});

Deno.test("re-authorizing after a revoked grant does not revive old tokens", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const old = await newTokens(http, clientId);
    assert(await mcpStatus(http, old.access_token) !== 401);

    // A second client connecting keeps the first one's tokens valid.
    const second = await newTokens(http, await register(http));
    assert(await mcpStatus(http, old.access_token) !== 401);

    const grant = await fx.store.getGrant(FAKE_USER_ID);
    assert(grant);
    assert(await fx.store.deleteGrantIf(FAKE_USER_ID, grant.versionstamp));
    assertEquals(await mcpStatus(http, old.access_token), 401);

    const fresh = await newTokens(http, clientId);
    assert(await mcpStatus(http, fresh.access_token) !== 401);
    assertEquals(await mcpStatus(http, old.access_token), 401);
    assertEquals(await mcpStatus(http, second.access_token), 401);
    assertEquals(
      (await refreshWith(http, clientId, old.refresh_token)).status,
      400,
    );
  } finally {
    await http.close();
    fx.close();
  }
});

Deno.test("malformed authorize requests show an error page instead of redirecting", async () => {
  const { fx, http } = await setup();
  try {
    const clientId = await register(http);
    const response = await call(
      http,
      `/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "token",
      })}`,
    );
    assertEquals(response.status, 400);
    assertEquals(response.headers.get("location"), null);
    assertMatch(await response.text(), /unsupported_response_type/);
  } finally {
    fx.close();
  }
});

Deno.test("https issuers use __Host- binding cookies", async () => {
  const fx = await createFixture(0, "https://dexcom.example.com");
  const http = createHttpHandler({
    ctx: fx.ctx,
    allowedOriginHostnames: ["dexcom.example.com"],
    allowInsecureIssuer: false,
  });
  try {
    const clientId = await register(http);
    const verifier = newVerifier();
    const consent = await call(
      http,
      `/authorize?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: CLIENT_REDIRECT,
        response_type: "code",
        code_challenge: await sha256(verifier),
        code_challenge_method: "S256",
      })}`,
    );
    assertEquals(consent.status, 200);
    const consentId = (await consent.text())
      .match(/name="consent_id" value="([^"]+)"/)?.[1];
    assert(consentId);
    const set = consent.headers.get("set-cookie") ?? "";
    assertMatch(set, /^__Host-dexcom_mcp_consent=[^;]+; Path=\/;.*; Secure$/);

    // A plain-named cookie (as a sibling subdomain could set) is ignored.
    const value = set.split(";")[0]!.split("=")[1]!;
    const planted = await call(http, "/authorize", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: `dexcom_mcp_consent=${value}`,
      },
      body: new URLSearchParams({ consent_id: consentId, action: "approve" }),
    });
    assertEquals(planted.status, 403);
    await planted.body?.cancel();
  } finally {
    fx.close();
  }
});
