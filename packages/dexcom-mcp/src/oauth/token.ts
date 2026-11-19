import { randomToken, verifyPkce } from "../crypto.ts";
import type { McpTokenRecord } from "../store.ts";
import { isAllowedResource } from "./authorize.ts";
import {
  type BridgeContext,
  jsonResponse,
  oauthErrorResponse,
  readForm,
} from "./context.ts";

async function issueTokens(
  ctx: BridgeContext,
  base: Omit<McpTokenRecord, "expiresAt">,
): Promise<Response> {
  const now = Date.now();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  await ctx.store.putAccessToken(accessToken, {
    ...base,
    expiresAt: now + ctx.accessTokenTtlMs,
  });
  await ctx.store.putRefreshToken(refreshToken, {
    ...base,
    expiresAt: now + ctx.refreshTokenTtlMs,
  });
  return jsonResponse(
    {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ctx.accessTokenTtlMs / 1000),
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
  if (!clientId || !await ctx.store.getClient(clientId)) {
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
    if (!await ctx.sessions.hasGrant(record.userId)) {
      return oauthErrorResponse(
        "invalid_grant",
        "Dexcom authorization is no longer valid",
      );
    }
    return issueTokens(ctx, {
      userId: record.userId,
      clientId,
      resource: record.resource ?? form.get("resource") ?? undefined,
    });
  }

  if (grantType === "refresh_token") {
    const refreshToken = form.get("refresh_token");
    if (!refreshToken) {
      return oauthErrorResponse("invalid_request", "refresh_token is required");
    }
    const record = await ctx.store.takeRefreshToken(refreshToken);
    if (!record || record.clientId !== clientId) {
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
    if (!await ctx.sessions.hasGrant(record.userId)) {
      return oauthErrorResponse(
        "invalid_grant",
        "Dexcom authorization was revoked; authorize again",
      );
    }
    return issueTokens(ctx, {
      userId: record.userId,
      clientId,
      resource: record.resource,
    });
  }

  return oauthErrorResponse(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token",
  );
}
