import { sha256 } from "./crypto.ts";

/**
 * A dynamically registered MCP client (RFC 7591). Only public clients are
 * supported, so no secret is stored.
 */
export interface RegisteredClient {
  /**
   * Issued client identifier.
   */
  clientId: string;
  /**
   * Display name shown on the consent page.
   */
  clientName: string | undefined;
  /**
   * Exact redirect URIs the client may use.
   */
  redirectUris: string[];
  /**
   * Issue time (seconds since epoch).
   */
  issuedAt: number;
}

/**
 * Validated parameters of an MCP client's /authorize request.
 */
export interface AuthorizationRequest {
  /**
   * Requesting client.
   */
  clientId: string;
  /**
   * Redirect URI the code is returned to.
   */
  redirectUri: string;
  /**
   * PKCE S256 challenge.
   */
  codeChallenge: string;
  /**
   * The client's own state value, echoed back.
   */
  state: string | undefined;
  /**
   * RFC 8707 resource indicator, when supplied.
   */
  resource: string | undefined;
}

/**
 * An authorization request awaiting user consent. Bound to a browser cookie
 * to prevent consent CSRF.
 */
export interface PendingConsent extends AuthorizationRequest {
  /**
   * Hash of the cookie value that must accompany the consent POST.
   */
  browserBindingHash: string;
}

/**
 * A one-time MCP authorization code minted after the Dexcom callback.
 */
export interface AuthorizationCode extends AuthorizationRequest {
  /**
   * Dexcom user the code grants access to.
   */
  userId: string;
  /**
   * Expiry (milliseconds since epoch).
   */
  expiresAt: number;
}

/**
 * An MCP access or refresh token record, keyed by token hash.
 */
export interface McpTokenRecord {
  /**
   * Dexcom user.
   */
  userId: string;
  /**
   * Client the token was issued to.
   */
  clientId: string;
  /**
   * Resource the token is bound to.
   */
  resource: string | undefined;
  /**
   * Expiry (milliseconds since epoch).
   */
  expiresAt: number;
}

/**
 * Dexcom tokens for one user. Never leaves the server.
 */
export interface DexcomGrant {
  /**
   * Dexcom user ID (per account, per client app), or "local" for stdio.
   */
  userId: string;
  /**
   * Current Dexcom access token.
   */
  accessToken: string;
  /**
   * Current single-use Dexcom refresh token.
   */
  refreshToken: string;
  /**
   * Access token expiry (milliseconds since epoch).
   */
  accessTokenExpiresAt: number;
  /**
   * Last update (milliseconds since epoch).
   */
  updatedAt: number;
}

/**
 * A grant together with its KV versionstamp, for compare-and-swap updates.
 */
export interface VersionedGrant {
  /**
   * The grant.
   */
  grant: DexcomGrant;
  /**
   * KV versionstamp of the stored value.
   */
  versionstamp: string;
}

/**
 * Persistent state for the OAuth bridge, backed by Deno KV.
 */
export interface Store {
  /**
   * Saves a registered client.
   */
  putClient(client: RegisteredClient): Promise<void>;
  /**
   * Loads a registered client.
   */
  getClient(clientId: string): Promise<RegisteredClient | undefined>;
  /**
   * Saves a consent request for ten minutes.
   */
  putConsent(id: string, consent: PendingConsent): Promise<void>;
  /**
   * Reads and deletes a consent request.
   */
  takeConsent(id: string): Promise<PendingConsent | undefined>;
  /**
   * Saves an approved request until Dexcom calls back (ten minutes).
   */
  putPendingUpstream(
    state: string,
    request: AuthorizationRequest,
  ): Promise<void>;
  /**
   * Reads and deletes an approved request by upstream state.
   */
  takePendingUpstream(state: string): Promise<AuthorizationRequest | undefined>;
  /**
   * Saves a one-time authorization code by hash.
   */
  putCode(code: string, record: AuthorizationCode): Promise<void>;
  /**
   * Reads and deletes an authorization code (single use).
   */
  takeCode(code: string): Promise<AuthorizationCode | undefined>;
  /**
   * Saves an MCP access token by hash.
   */
  putAccessToken(token: string, record: McpTokenRecord): Promise<void>;
  /**
   * Loads an MCP access token record.
   */
  getAccessToken(token: string): Promise<McpTokenRecord | undefined>;
  /**
   * Saves an MCP refresh token by hash.
   */
  putRefreshToken(token: string, record: McpTokenRecord): Promise<void>;
  /**
   * Reads and deletes an MCP refresh token (rotation).
   */
  takeRefreshToken(token: string): Promise<McpTokenRecord | undefined>;
  /**
   * Loads a user's Dexcom grant with its versionstamp.
   */
  getGrant(userId: string): Promise<VersionedGrant | undefined>;
  /**
   * Unconditionally writes a grant (initial authorization).
   */
  putGrant(grant: DexcomGrant): Promise<void>;
  /**
   * Writes a grant only if it is unchanged since `versionstamp`.
   *
   * @returns Whether the write was applied.
   */
  replaceGrant(grant: DexcomGrant, versionstamp: string): Promise<boolean>;
  /**
   * Deletes a grant. MCP tokens for the user stop working because the
   * verifier requires a live grant.
   */
  deleteGrant(userId: string): Promise<void>;
  /**
   * Closes the underlying KV handle.
   */
  close(): void;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

function remainingMs(expiresAt: number): number {
  return Math.max(1000, expiresAt - Date.now());
}

/**
 * Creates a {@link Store} on a Deno KV database.
 *
 * @param kv - An open KV handle (file-backed, `:memory:`, or remote).
 * @returns The store.
 */
export function createKvStore(kv: Deno.Kv): Store {
  async function take<T>(key: Deno.KvKey): Promise<T | undefined> {
    const entry = await kv.get<T>(key);
    if (entry.value === null) return undefined;
    // Atomic check makes single-use values safe under concurrent requests.
    const result = await kv.atomic().check(entry).delete(key).commit();
    return result.ok ? entry.value : undefined;
  }

  function isLive<T extends { expiresAt: number }>(
    value: T | undefined,
  ): T | undefined {
    return value && value.expiresAt > Date.now() ? value : undefined;
  }

  return {
    async putClient(client) {
      await kv.set(["client", client.clientId], client);
    },
    async getClient(clientId) {
      return (await kv.get<RegisteredClient>(["client", clientId])).value ??
        undefined;
    },
    async putConsent(id, consent) {
      await kv.set(["consent", await sha256(id)], consent, {
        expireIn: TEN_MINUTES_MS,
      });
    },
    async takeConsent(id) {
      return take<PendingConsent>(["consent", await sha256(id)]);
    },
    async putPendingUpstream(state, request) {
      await kv.set(["pending", await sha256(state)], request, {
        expireIn: TEN_MINUTES_MS,
      });
    },
    async takePendingUpstream(state) {
      return take<AuthorizationRequest>(["pending", await sha256(state)]);
    },
    async putCode(code, record) {
      await kv.set(["code", await sha256(code)], record, {
        expireIn: remainingMs(record.expiresAt),
      });
    },
    async takeCode(code) {
      return isLive(
        await take<AuthorizationCode>(["code", await sha256(code)]),
      );
    },
    async putAccessToken(token, record) {
      await kv.set(["access", await sha256(token)], record, {
        expireIn: remainingMs(record.expiresAt),
      });
    },
    async getAccessToken(token) {
      const entry = await kv.get<McpTokenRecord>([
        "access",
        await sha256(token),
      ]);
      return isLive(entry.value ?? undefined);
    },
    async putRefreshToken(token, record) {
      await kv.set(["refresh", await sha256(token)], record, {
        expireIn: remainingMs(record.expiresAt),
      });
    },
    async takeRefreshToken(token) {
      return isLive(
        await take<McpTokenRecord>(["refresh", await sha256(token)]),
      );
    },
    async getGrant(userId) {
      const entry = await kv.get<DexcomGrant>(["grant", userId]);
      if (entry.value === null || entry.versionstamp === null) return undefined;
      return { grant: entry.value, versionstamp: entry.versionstamp };
    },
    async putGrant(grant) {
      await kv.set(["grant", grant.userId], grant);
    },
    async replaceGrant(grant, versionstamp) {
      const result = await kv.atomic()
        .check({ key: ["grant", grant.userId], versionstamp })
        .set(["grant", grant.userId], grant)
        .commit();
      return result.ok;
    },
    async deleteGrant(userId) {
      await kv.delete(["grant", userId]);
    },
    close() {
      kv.close();
    },
  };
}
