import {
  type AuthInfo,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { BridgeContext } from "./context.ts";

/**
 * Dexcom user ID carried in {@link AuthInfo.extra}.
 *
 * @param authInfo - Verified auth info, when present.
 * @returns The user ID, or undefined.
 */
export function userIdFromAuthInfo(
  authInfo: AuthInfo | undefined,
): string | undefined {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" ? userId : undefined;
}

/**
 * Verifies opaque MCP access tokens for the SDK's bearer-auth helpers. A
 * token is only valid while the user's Dexcom grant still exists, so a
 * revoked Dexcom grant forces clients back through authorization.
 *
 * @param ctx - Bridge context.
 * @returns The verifier.
 */
export function createTokenVerifier(
  ctx: Pick<BridgeContext, "store" | "resourceUrl">,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const record = await ctx.store.getAccessToken(token);
      if (!record) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Invalid or expired token",
        );
      }
      if (!await ctx.store.getGrant(record.userId)) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          "Dexcom authorization was revoked",
        );
      }
      return {
        token,
        clientId: record.clientId,
        scopes: [],
        expiresAt: Math.floor(record.expiresAt / 1000),
        resource: ctx.resourceUrl,
        extra: { userId: record.userId },
      };
    },
  };
}
