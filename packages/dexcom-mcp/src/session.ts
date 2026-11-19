import {
  type DexcomAuth,
  type DexcomConfig,
  isDexcomApiError,
  refreshTokens,
  type TokenResponse,
} from "@wyattjoh/dexcom";
import { randomToken } from "./crypto.ts";
import { getLogger } from "./logging.ts";
import type { DexcomGrant, Store, VersionedGrant } from "./store.ts";

const logger = getLogger(["dexcom-mcp", "session"]);

/**
 * Refresh this long before the Dexcom access token expires.
 */
const REFRESH_SKEW_MS = 60_000;

/**
 * How often a process waiting on another process's refresh re-checks KV.
 */
const LOCK_POLL_MS = 200;

/**
 * Error thrown when a user's Dexcom grant is missing or revoked and they must
 * authorize again.
 */
export interface ReauthorizationRequiredError extends Error {
  /**
   * Discriminant.
   */
  readonly name: "ReauthorizationRequiredError";
}

/**
 * Creates a {@link ReauthorizationRequiredError}.
 *
 * @param message - Description for the user.
 * @returns The error.
 */
export function createReauthorizationRequiredError(
  message: string,
): ReauthorizationRequiredError {
  return Object.assign(new Error(message), {
    name: "ReauthorizationRequiredError" as const,
  });
}

/**
 * Narrows to {@link ReauthorizationRequiredError}.
 *
 * @param error - Caught value.
 * @returns Whether a re-authorization is required.
 */
export function isReauthorizationRequiredError(
  error: unknown,
): error is ReauthorizationRequiredError {
  return error instanceof Error &&
    error.name === "ReauthorizationRequiredError";
}

/**
 * Converts a Dexcom token response into a stored grant.
 *
 * @param userId - Dexcom user ID.
 * @param tokens - Token response.
 * @param grantId - The existing grant's ID, or undefined to mint one (no
 * grant stored, or one from before grant IDs existed).
 * @returns The grant.
 */
export function grantFromTokens(
  userId: string,
  tokens: TokenResponse,
  grantId: string | undefined,
): DexcomGrant {
  const now = Date.now();
  return {
    userId,
    grantId: grantId || randomToken(),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accessTokenExpiresAt: now + tokens.expires_in * 1000,
    updatedAt: now,
  };
}

/**
 * Runs Dexcom calls for a user with a valid access token, handling refresh.
 */
export interface DexcomSessions {
  /**
   * Calls `fn` with fresh credentials; on a 401 it refreshes once and
   * retries.
   *
   * @param userId - Dexcom user.
   * @param fn - The Dexcom call.
   * @returns The call's result.
   */
  withAuth<T>(userId: string, fn: (auth: DexcomAuth) => Promise<T>): Promise<T>;
  /**
   * Whether the user currently has a stored grant.
   */
  hasGrant(userId: string): Promise<boolean>;
}

/**
 * Creates the session manager. Dexcom refresh tokens are single use, so a
 * refresh is single-flighted per user in-process and serialized across
 * processes sharing the KV by a lease, then committed with a compare-and-swap.
 *
 * @param config - Dexcom configuration.
 * @param store - Persistent store.
 * @returns The session manager.
 */
export function createDexcomSessions(
  config: DexcomConfig,
  store: Store,
): DexcomSessions {
  const inflight = new Map<string, Promise<DexcomGrant>>();
  // Outlives the refresh request (fetch timeout) so a live holder keeps it.
  const leaseMs = config.timeoutMs * 2 + 5_000;

  async function loadGrant(userId: string) {
    const versioned = await store.getGrant(userId);
    if (!versioned) {
      throw createReauthorizationRequiredError(
        "Dexcom authorization is missing or was revoked. Re-authorize this MCP server with Dexcom.",
      );
    }
    return versioned;
  }

  function isCurrent(
    grant: DexcomGrant,
    staleAccessToken: string | undefined,
  ): boolean {
    // Another request (or process) already rotated past the stale token.
    if (staleAccessToken !== undefined) {
      return grant.accessToken !== staleAccessToken;
    }
    return grant.accessTokenExpiresAt - REFRESH_SKEW_MS > Date.now();
  }

  async function refreshHeld(
    userId: string,
    { grant, versionstamp }: VersionedGrant,
  ): Promise<DexcomGrant> {
    let tokens: TokenResponse;
    try {
      tokens = await refreshTokens(config, grant.refreshToken);
    } catch (error) {
      // Dexcom documents 400 as "this refresh token is no longer valid".
      // Other statuses (429 rate limit, 401 bad client secret, 5xx) must not
      // destroy users' grants.
      if (!isDexcomApiError(error) || error.status !== 400) throw error;
      // Only delete the grant this refresh was based on; if a writer that
      // does not hold the lease replaced it meanwhile, its tokens are newer.
      if (!await store.deleteGrantIf(userId, versionstamp)) {
        return (await loadGrant(userId)).grant;
      }
      logger.warn("Dexcom refresh rejected; deleted grant", {
        userId,
        status: error.status,
      });
      throw createReauthorizationRequiredError(
        "Dexcom rejected the stored refresh token (revoked, expired, or password reset). Re-authorize this MCP server with Dexcom.",
      );
    }

    const next = grantFromTokens(userId, tokens, grant.grantId);
    // Persist the rotated refresh token before anyone uses the new access
    // token. Dexcom already spent the old one, so these tokens are the only
    // valid ones even if the grant changed underneath us.
    if (!await store.replaceGrant(next, versionstamp)) {
      logger.warn("Grant changed during refresh; storing the newest tokens", {
        userId,
      });
      await store.putGrant(next);
    }
    logger.debug("Refreshed Dexcom tokens", { userId });
    return next;
  }

  async function doRefresh(
    userId: string,
    staleAccessToken: string | undefined,
  ): Promise<DexcomGrant> {
    const deadline = Date.now() + leaseMs;
    while (true) {
      const loaded = await loadGrant(userId);
      if (isCurrent(loaded.grant, staleAccessToken)) return loaded.grant;

      const owner = await store.acquireRefreshLock(userId, leaseMs);
      if (owner === undefined) {
        // Another process is spending the refresh token; wait for its result.
        if (Date.now() > deadline) {
          throw new Error(
            "Timed out waiting for another process to refresh Dexcom tokens",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
        continue;
      }
      try {
        // Re-read under the lease: the previous holder may have finished.
        const current = await loadGrant(userId);
        if (isCurrent(current.grant, staleAccessToken)) return current.grant;
        return await refreshHeld(userId, current);
      } finally {
        await store.releaseRefreshLock(userId, owner);
      }
    }
  }

  function refresh(
    userId: string,
    staleAccessToken: string | undefined,
  ): Promise<DexcomGrant> {
    const existing = inflight.get(userId);
    if (existing) return existing;
    const promise = doRefresh(userId, staleAccessToken).finally(() => {
      inflight.delete(userId);
    });
    inflight.set(userId, promise);
    return promise;
  }

  async function currentGrant(userId: string): Promise<DexcomGrant> {
    const pending = inflight.get(userId);
    if (pending) return pending;
    const { grant } = await loadGrant(userId);
    if (grant.accessTokenExpiresAt - REFRESH_SKEW_MS > Date.now()) return grant;
    return refresh(userId, undefined);
  }

  return {
    async withAuth(userId, fn) {
      const grant = await currentGrant(userId);
      try {
        return await fn({ config, accessToken: grant.accessToken });
      } catch (error) {
        if (!isDexcomApiError(error) || error.status !== 401) throw error;
        logger.debug("Dexcom returned 401; refreshing and retrying", {
          userId,
        });
        const refreshed = await refresh(userId, grant.accessToken);
        return await fn({ config, accessToken: refreshed.accessToken });
      }
    },
    async hasGrant(userId) {
      return (await store.getGrant(userId)) !== undefined;
    },
  };
}
