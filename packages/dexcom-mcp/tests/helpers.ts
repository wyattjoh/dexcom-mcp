import { createDexcomConfig, type DexcomConfig } from "@wyattjoh/dexcom";
import type { BridgeContext } from "../src/oauth/context.ts";
import { DEXCOM_CALLBACK_PATH } from "../src/oauth/context.ts";
import { createDexcomSessions } from "../src/session.ts";
import { createKvStore, type Store } from "../src/store.ts";

/**
 * Observable state of the fake Dexcom upstream.
 */
export interface FakeDexcom {
  /**
   * Fetch implementation to inject into DexcomConfig.
   */
  fetch: typeof fetch;
  /**
   * Access tokens Dexcom currently accepts.
   */
  validAccessTokens: Set<string>;
  /**
   * Refresh tokens Dexcom currently accepts (single use).
   */
  validRefreshTokens: Set<string>;
  /**
   * Number of refresh grants processed.
   */
  refreshCount: () => number;
  /**
   * Requests seen, as "METHOD /path".
   */
  calls: string[];
  /**
   * When set, refresh requests fail with this status.
   */
  refreshFailureStatus: number | undefined;
}

const USER_ID = "dexcom-user-1";

/**
 * Creates an in-process fake of the Dexcom token and data endpoints.
 *
 * @param refreshDelayMs - Artificial latency on refresh, to widen races.
 * @returns The fake.
 */
export function createFakeDexcom(refreshDelayMs = 0): FakeDexcom {
  let counter = 0;
  let refreshes = 0;
  const validAccessTokens = new Set<string>();
  const validRefreshTokens = new Set<string>();
  const calls: string[] = [];

  function issue(): Response {
    counter++;
    const access = `dex-access-${counter}`;
    const refresh = `dex-refresh-${counter}`;
    validAccessTokens.add(access);
    validRefreshTokens.add(refresh);
    return Response.json({
      access_token: access,
      expires_in: 7200,
      token_type: "Bearer",
      refresh_token: refresh,
      refresh_expires_in: 0,
    });
  }

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);

    if (url.pathname === "/v3/oauth2/token") {
      const form = new URLSearchParams(await request.text());
      if (form.get("client_secret") !== "secret") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "dexcom-code") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        return issue();
      }
      if (fake.refreshFailureStatus !== undefined) {
        return Response.json({ error: "temporarily_unavailable" }, {
          status: fake.refreshFailureStatus,
        });
      }
      const token = form.get("refresh_token") ?? "";
      if (refreshDelayMs) {
        await new Promise((r) => setTimeout(r, refreshDelayMs));
      }
      if (!validRefreshTokens.delete(token)) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      refreshes++;
      return issue();
    }

    const bearer = request.headers.get("authorization")?.replace(
      /^Bearer /,
      "",
    );
    if (!bearer || !validAccessTokens.has(bearer)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const wrapper = (recordType: string, records: unknown[]) =>
      Response.json({
        recordType,
        recordVersion: "3.0",
        userId: USER_ID,
        records,
      });

    switch (url.pathname) {
      case "/v3/users/self/dataRange":
        return Response.json({
          recordType: "dataRange",
          recordVersion: "3.0",
          userId: USER_ID,
          egvs: {
            start: {
              systemTime: "2026-11-01T00:00:00",
              displayTime: "2026-11-01T00:00:00",
            },
            end: {
              systemTime: "2026-11-18T00:00:00",
              displayTime: "2026-11-18T00:00:00",
            },
          },
          calibrations: null,
          events: null,
        });
      case "/v3/users/self/egvs":
        return wrapper(
          "egv",
          [100, 150, 200, 60].map((value, i) => ({
            recordId: `egv-${i}`,
            systemTime: `2026-11-17T00:0${i}:00`,
            displayTime: `2026-11-17T00:0${i}:00`,
            transmitterId: null,
            transmitterTicks: i,
            value,
            status: null,
            trend: "flat",
            trendRate: 0,
            unit: "mg/dL",
            rateUnit: "mg/dL/min",
            displayDevice: "iOS",
            transmitterGeneration: "g7",
            transmitterGenerationVariant: "g7",
            displayApp: "G7",
          })),
        );
      case "/v3/users/self/devices":
        return wrapper("device", []);
      default:
        return Response.json({ error: "not found" }, { status: 404 });
    }
  };

  const fake: FakeDexcom = {
    fetch: fakeFetch as typeof fetch,
    validAccessTokens,
    validRefreshTokens,
    refreshCount: () => refreshes,
    calls,
    refreshFailureStatus: undefined,
  };
  return fake;
}

/**
 * Test fixture: an in-memory store and bridge context wired to a fake
 * Dexcom.
 */
export interface Fixture {
  /**
   * Bridge context.
   */
  ctx: BridgeContext;
  /**
   * Store.
   */
  store: Store;
  /**
   * Fake upstream.
   */
  dexcom: FakeDexcom;
  /**
   * Dexcom config.
   */
  config: DexcomConfig;
  /**
   * Closes the KV handle.
   */
  close: () => void;
}

/**
 * Creates a {@link Fixture}.
 *
 * @param refreshDelayMs - Fake refresh latency.
 * @param issuer - Public origin of the bridge.
 * @returns The fixture.
 */
export async function createFixture(
  refreshDelayMs = 0,
  issuer = "http://localhost:3000",
): Promise<Fixture> {
  const dexcom = createFakeDexcom(refreshDelayMs);
  const config = createDexcomConfig({
    region: "sandbox",
    clientId: "client",
    clientSecret: "secret",
    redirectUri: `${issuer}${DEXCOM_CALLBACK_PATH}`,
    fetch: dexcom.fetch,
  });
  const store = createKvStore(await Deno.openKv(":memory:"));
  const ctx: BridgeContext = {
    issuer,
    resourceUrl: new URL(`${issuer}/mcp`),
    dexcom: config,
    store,
    sessions: createDexcomSessions(config, store),
    accessTokenTtlMs: 3600_000,
    refreshTokenTtlMs: 86_400_000,
    refreshRetryGraceMs: 10_000,
  };
  return { ctx, store, dexcom, config, close: () => store.close() };
}

/**
 * The fake Dexcom user ID.
 */
export const FAKE_USER_ID = USER_ID;
