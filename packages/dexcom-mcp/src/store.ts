import { randomToken, sha256 } from "./crypto.ts";

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
 * An authorization request bound to a browser cookie: used both while
 * awaiting consent and while waiting for the Dexcom callback.
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
   * Token family (one authorization and all of its refresh rotations).
   */
  familyId: string;
  /**
   * Expiry (milliseconds since epoch).
   */
  expiresAt: number;
}

/**
 * One MCP authorization and every token rotated from it. Deleting the family
 * revokes all of its access and refresh tokens at once.
 */
export interface TokenFamily {
  /**
   * Family identifier.
   */
  familyId: string;
  /**
   * Dexcom user.
   */
  userId: string;
  /**
   * Client the family was issued to.
   */
  clientId: string;
  /**
   * {@link DexcomGrant.grantId} the family was issued under; a new grant
   * (after the old one was deleted) does not revive the family.
   */
  grantId: string;
  /**
   * Absolute expiry of the family (milliseconds since epoch); rotation never
   * extends it.
   */
  expiresAt: number;
}

/**
 * Outcome of redeeming an MCP refresh token.
 */
export type RefreshTokenRedemption =
  | {
    /**
     * The token was live and is now spent.
     */
    status: "redeemed";
    /**
     * The token's record.
     */
    record: McpTokenRecord;
  }
  | {
    /**
     * The token was already spent: it has been replayed.
     */
    status: "reused";
    /**
     * Family the spent token belonged to.
     */
    familyId: string;
    /**
     * Client the token was issued to.
     */
    clientId: string;
    /**
     * When the token was first redeemed (milliseconds since epoch).
     */
    spentAt: number;
  }
  | {
    /**
     * Unknown or expired token.
     */
    status: "invalid";
  };

/**
 * Dexcom tokens for one user. Never leaves the server.
 */
export interface DexcomGrant {
  /**
   * Dexcom user ID (per account, per client app), or "local" for stdio.
   */
  userId: string;
  /**
   * Random identifier minted when the grant is first created and kept across
   * refreshes and re-authorizations. MCP token families are bound to it.
   */
  grantId: string;
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
   * Saves a registered client for `ttlMs`. Saving it again extends the TTL.
   */
  putClient(client: RegisteredClient, ttlMs: number): Promise<void>;
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
  putPendingUpstream(state: string, request: PendingConsent): Promise<void>;
  /**
   * Reads and deletes an approved request by upstream state.
   */
  takePendingUpstream(state: string): Promise<PendingConsent | undefined>;
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
   * Redeems an MCP refresh token (rotation). The spent token is remembered
   * until it would have expired, so a replay is reported as `reused`.
   */
  takeRefreshToken(token: string): Promise<RefreshTokenRedemption>;
  /**
   * Saves a token family until its absolute expiry.
   */
  putFamily(family: TokenFamily): Promise<void>;
  /**
   * Loads a live token family.
   */
  getFamily(familyId: unknown): Promise<TokenFamily | undefined>;
  /**
   * Deletes a token family, revoking all of its tokens.
   */
  deleteFamily(familyId: string): Promise<void>;
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
   * Deletes a grant only if it is unchanged since `versionstamp`. MCP tokens
   * for the user stop working because the verifier requires the grant their
   * family was issued under.
   *
   * @returns Whether the grant was deleted.
   */
  deleteGrantIf(userId: string, versionstamp: string): Promise<boolean>;
  /**
   * Takes the cross-process lease for refreshing a user's Dexcom tokens.
   *
   * @returns An owner token, or undefined while another holder's lease is
   * live.
   */
  acquireRefreshLock(
    userId: string,
    ttlMs: number,
  ): Promise<string | undefined>;
  /**
   * Releases a refresh lease if `owner` still holds it.
   */
  releaseRefreshLock(userId: string, owner: string): Promise<void>;
  /**
   * Closes the underlying KV handle.
   */
  close(): void;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;

interface SpentToken {
  familyId: string;
  clientId: string;
  spentAt: number;
}

interface RefreshLease {
  owner: string;
  expiresAt: number;
}

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
    async putClient(client, ttlMs) {
      await kv.set(["client", client.clientId], client, { expireIn: ttlMs });
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
      return take<PendingConsent>(["pending", await sha256(state)]);
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
      const hash = await sha256(token);
      const key = ["refresh", hash];
      const usedKey = ["refresh-used", hash];
      const [entry, used] = await kv.getMany<[McpTokenRecord, SpentToken]>([
        key,
        usedKey,
      ]);
      if (used.value) return { status: "reused", ...used.value };
      const record = isLive(entry.value ?? undefined);
      if (!record) return { status: "invalid" };
      // Spend the token and leave a tombstone in one atomic step, so a
      // concurrent replay sees either the live token or the tombstone.
      const result = await kv.atomic()
        .check(entry)
        .check(used)
        .delete(key)
        .set(
          usedKey,
          {
            familyId: record.familyId,
            clientId: record.clientId,
            spentAt: Date.now(),
          } satisfies SpentToken,
          {
            expireIn: remainingMs(record.expiresAt),
          },
        )
        .commit();
      return result.ok ? { status: "redeemed", record } : {
        status: "reused",
        familyId: record.familyId,
        clientId: record.clientId,
        spentAt: Date.now(),
      };
    },
    async putFamily(family) {
      await kv.set(["family", family.familyId], family, {
        expireIn: remainingMs(family.expiresAt),
      });
    },
    async getFamily(familyId) {
      if (typeof familyId !== "string" || !familyId) return undefined;
      const entry = await kv.get<TokenFamily>(["family", familyId]);
      return isLive(entry.value ?? undefined);
    },
    async deleteFamily(familyId) {
      await kv.delete(["family", familyId]);
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
    async deleteGrantIf(userId, versionstamp) {
      const result = await kv.atomic()
        .check({ key: ["grant", userId], versionstamp })
        .delete(["grant", userId])
        .commit();
      return result.ok;
    },
    async acquireRefreshLock(userId, ttlMs) {
      const key = ["refresh-lock", userId];
      // KV expiry is lazy, so the lease carries its own deadline.
      const entry = await kv.get<RefreshLease>(key);
      if (entry.value && entry.value.expiresAt > Date.now()) return undefined;
      const owner = randomToken();
      const result = await kv.atomic()
        .check(entry)
        .set(key, { owner, expiresAt: Date.now() + ttlMs }, {
          expireIn: ttlMs,
        })
        .commit();
      return result.ok ? owner : undefined;
    },
    async releaseRefreshLock(userId, owner) {
      const key = ["refresh-lock", userId];
      const entry = await kv.get<RefreshLease>(key);
      if (entry.value?.owner !== owner) return;
      await kv.atomic().check(entry).delete(key).commit();
    },
    close() {
      kv.close();
    },
  };
}
