import {
  type DexcomAuth,
  type DexcomConfig,
  isDexcomApiError,
  refreshTokens,
  type TokenResponse,
} from "@wyattjoh/dexcom";
import { getLogger } from "./logging.ts";
import type { DexcomGrant, Store } from "./store.ts";

const logger = getLogger(["dexcom-mcp", "session"]);

/**
 * Refresh this long before the Dexcom access token expires.
 */
const REFRESH_SKEW_MS = 60_000;

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
 * @returns The grant.
 */
export function grantFromTokens(
  userId: string,
  tokens: TokenResponse,
): DexcomGrant {
  const now = Date.now();
  return {
    userId,
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
 * Creates the session manager. Dexcom refresh tokens are single use, so
 * refreshes are single-flighted per user in-process and committed with a KV
 * compare-and-swap so concurrent processes cannot both spend one token.
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

  async function loadGrant(userId: string) {
    const versioned = await store.getGrant(userId);
    if (!versioned) {
      throw createReauthorizationRequiredError(
        "Dexcom authorization is missing or was revoked. Re-authorize this MCP server with Dexcom.",
      );
    }
    return versioned;
  }

  async function doRefresh(
    userId: string,
    staleAccessToken: string | undefined,
  ): Promise<DexcomGrant> {
    const { grant, versionstamp } = await loadGrant(userId);
    // Another request (or process) already rotated past the stale token.
    if (
      staleAccessToken !== undefined && grant.accessToken !== staleAccessToken
    ) {
      return grant;
    }
    if (
      staleAccessToken === undefined &&
      grant.accessTokenExpiresAt - REFRESH_SKEW_MS > Date.now()
    ) {
      return grant;
    }

    let tokens: TokenResponse;
    try {
      tokens = await refreshTokens(config, grant.refreshToken);
    } catch (error) {
      // Dexcom documents 400 as "this refresh token is no longer valid".
      // Other statuses (429 rate limit, 401 bad client secret, 5xx) must not
      // destroy users' grants.
      if (isDexcomApiError(error) && error.status === 400) {
        const current = await store.getGrant(userId);
        if (current && current.grant.refreshToken !== grant.refreshToken) {
          // Lost a race with another process; its rotation is valid.
          return current.grant;
        }
        logger.warn("Dexcom refresh rejected; deleting grant", {
          userId,
          status: error.status,
        });
        await store.deleteGrant(userId);
        throw createReauthorizationRequiredError(
          "Dexcom rejected the stored refresh token (revoked, expired, or password reset). Re-authorize this MCP server with Dexcom.",
        );
      }
      throw error;
    }

    const next = grantFromTokens(userId, tokens);
    // Persist the rotated refresh token before anyone uses the new access token.
    if (!await store.replaceGrant(next, versionstamp)) {
      logger.warn(
        "Grant changed during refresh; overwriting with newest tokens",
        {
          userId,
        },
      );
      await store.putGrant(next);
    }
    logger.debug("Refreshed Dexcom tokens", { userId });
    return next;
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
