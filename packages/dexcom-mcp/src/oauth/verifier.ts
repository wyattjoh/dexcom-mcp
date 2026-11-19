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
 * token is only valid while its family is live and was issued under the
 * user's current Dexcom grant, so a revoked grant or a replayed refresh token
 * forces clients back through authorization.
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
      const [family, grant] = await Promise.all([
        ctx.store.getFamily(record.familyId),
        ctx.store.getGrant(record.userId),
      ]);
      if (
        !family || family.userId !== record.userId ||
        typeof family.grantId !== "string"
      ) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "Token was revoked");
      }
      // The family must belong to the user's current grant, so tokens from
      // before a revocation stay dead after the user authorizes again.
      if (!grant || grant.grant.grantId !== family.grantId) {
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
