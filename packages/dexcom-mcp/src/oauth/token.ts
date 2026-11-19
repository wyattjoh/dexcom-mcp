import { randomToken, verifyPkce } from "../crypto.ts";
import { getLogger } from "../logging.ts";
import type { RegisteredClient, TokenFamily } from "../store.ts";
import { isAllowedResource } from "./authorize.ts";
import {
  type BridgeContext,
  jsonResponse,
  oauthErrorResponse,
  readForm,
} from "./context.ts";

const logger = getLogger(["dexcom-mcp", "oauth"]);

async function issueTokens(
  ctx: BridgeContext,
  client: RegisteredClient,
  family: TokenFamily,
  resource: string | undefined,
): Promise<Response> {
  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const base = {
    userId: family.userId,
    clientId: family.clientId,
    familyId: family.familyId,
    resource,
  };
  const accessExpiresAt = Math.min(
    now + ctx.accessTokenTtlMs,
    family.expiresAt,
  );
  await ctx.store.putAccessToken(accessToken, {
    ...base,
    expiresAt: accessExpiresAt,
  });
  await ctx.store.putRefreshToken(refreshToken, {
    ...base,
    expiresAt: family.expiresAt,
  });
  // A client stays registered while it has tokens that could still refresh.
  await ctx.store.putClient(client, ctx.refreshTokenTtlMs);
  return jsonResponse(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.max(1, Math.floor((accessExpiresAt - now) / 1000)),
      refresh_token: refreshToken,
    },
    200,
    { Pragma: "no-cache" },
  );
}

function checkResource(
  ctx: BridgeContext,
  requested: string | null,
  bound: string | undefined,
): Response | undefined {
  if (requested === null) return undefined;
  if (!isAllowedResource(ctx, requested)) {
    return oauthErrorResponse("invalid_target", "Unknown resource");
  }
  if (bound !== undefined && requested !== bound) {
    return oauthErrorResponse(
      "invalid_target",
      "resource does not match the grant",
    );
  }
  return undefined;
}

/**
 * POST /token: exchanges MCP authorization codes (with PKCE) and rotates MCP
 * refresh tokens. Dexcom tokens never appear in these responses.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming form POST.
 * @returns Token response or OAuth error.
 */
export async function handleToken(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  const form = await readForm(request);
  if (!form) {
    return oauthErrorResponse(
      "invalid_request",
      "Body must be application/x-www-form-urlencoded",
    );
  }
  const clientId = form.get("client_id");
  const client = clientId ? await ctx.store.getClient(clientId) : undefined;
  if (!clientId || !client) {
    return oauthErrorResponse("invalid_client", "Unknown client_id", 401);
  }

  const grantType = form.get("grant_type");
  if (grantType === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    if (!code || !verifier) {
      return oauthErrorResponse(
        "invalid_request",
        "code and code_verifier are required",
      );
    }
    const record = await ctx.store.takeCode(code);
    if (!record || record.clientId !== clientId) {
      return oauthErrorResponse(
        "invalid_grant",
        "Invalid or expired authorization code",
      );
    }
    if (
      form.get("redirect_uri") !== null &&
      form.get("redirect_uri") !== record.redirectUri
    ) {
      return oauthErrorResponse("invalid_grant", "redirect_uri mismatch");
    }
    if (!await verifyPkce(verifier, record.codeChallenge)) {
      return oauthErrorResponse("invalid_grant", "PKCE verification failed");
    }
    const resourceError = checkResource(
      ctx,
      form.get("resource"),
      record.resource,
    );
    if (resourceError) return resourceError;
    const grant = await ctx.store.getGrant(record.userId);
    if (!grant || typeof grant.grant.grantId !== "string") {
      return oauthErrorResponse(
        "invalid_grant",
        "Dexcom authorization is no longer valid",
      );
    }
    const family: TokenFamily = {
      familyId: randomToken(),
      userId: record.userId,
      clientId,
      grantId: grant.grant.grantId,
      expiresAt: Date.now() + ctx.refreshTokenTtlMs,
    };
    await ctx.store.putFamily(family);
    return issueTokens(
      ctx,
      client,
      family,
      record.resource ?? form.get("resource") ?? undefined,
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) {
      return oauthErrorResponse("invalid_request", "refresh_token is required");
    }
    const redemption = await ctx.store.takeRefreshToken(refreshToken);
    if (redemption.status === "reused") {
      // The same client re-sending a token it just spent is a retry (lost
      // response, parallel refresh), not theft: refuse it but keep the
      // family, or the client's freshly issued tokens would die too.
      const isRetry = redemption.clientId === clientId &&
        Date.now() - redemption.spentAt < ctx.refreshRetryGraceMs;
      if (isRetry) {
        return oauthErrorResponse(
          "invalid_grant",
          "Refresh token was already used",
        );
      }
      // Otherwise it leaked: revoke every token rotated from the same
      // authorization (RFC 9700 section 4.14.2).
      await ctx.store.deleteFamily(redemption.familyId);
      logger.warn("Refresh token replayed; revoked its token family", {
        clientId,
      });
      return oauthErrorResponse(
        "invalid_grant",
        "Invalid or expired refresh token",
      );
    }
    if (redemption.status === "invalid") {
      return oauthErrorResponse(
        "invalid_grant",
        "Invalid or expired refresh token",
      );
    }
    const { record } = redemption;
    const family = await ctx.store.getFamily(record.familyId);
    if (!family || family.clientId !== clientId) {
      // Presented by a different client than it was issued to: treat as
      // leaked as well.
      if (family) await ctx.store.deleteFamily(family.familyId);
      return oauthErrorResponse(
        "invalid_grant",
        "Invalid or expired refresh token",
      );
    }
    const resourceError = checkResource(
      ctx,
      form.get("resource"),
      record.resource,
    );
    if (resourceError) return resourceError;
    const grant = await ctx.store.getGrant(family.userId);
    if (!grant || grant.grant.grantId !== family.grantId) {
      await ctx.store.deleteFamily(family.familyId);
      return oauthErrorResponse(
        "invalid_grant",
        "Dexcom authorization was revoked; authorize again",
      );
    }
    return issueTokens(ctx, client, family, record.resource);
  }

  return oauthErrorResponse(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
}
