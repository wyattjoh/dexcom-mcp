import { exchangeCode, getDataRange } from "@wyattjoh/dexcom";
import { randomToken } from "../crypto.ts";
import { getLogger } from "../logging.ts";
import { grantFromTokens } from "../session.ts";
import { type BridgeContext, errorPage, redirectToClient } from "./context.ts";

const logger = getLogger(["dexcom-mcp", "oauth"]);
const AUTHORIZATION_CODE_TTL_MS = 60_000;

/**
 * GET /oauth/dexcom/callback: Dexcom redirects here after login. The Dexcom
 * code is single use and expires within a minute, so it is exchanged right
 * away; the tokens are stored server-side and the MCP client receives its
 * own one-time authorization code instead.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming request.
 * @returns Redirect to the MCP client.
 */
export async function handleDexcomCallback(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (!state) return errorPage("Missing state from Dexcom.");

  const pending = await ctx.store.takePendingUpstream(state);
  if (!pending) {
    return errorPage(
      "This Dexcom sign-in is unknown or expired. Start again from your MCP client.",
    );
  }

  const upstreamError = params.get("error");
  const code = params.get("code");
  if (upstreamError || !code) {
    return redirectToClient(ctx, pending.redirectUri, {
      error: upstreamError === "access_denied"
        ? "access_denied"
        : "server_error",
      error_description: upstreamError === "access_denied"
        ? "The user denied access at Dexcom"
        : "Dexcom did not return an authorization code",
      state: pending.state,
    });
  }

  let userId: string;
  try {
    const tokens = await exchangeCode(ctx.dexcom, code);
    const range = await getDataRange(
      { config: ctx.dexcom, accessToken: tokens.access_token },
      undefined,
    );
    userId = range.userId;
    await ctx.store.putGrant(grantFromTokens(userId, tokens));
  } catch (error) {
    logger.error("Dexcom code exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return redirectToClient(ctx, pending.redirectUri, {
      error: "server_error",
      error_description: "Could not complete authorization with Dexcom",
      state: pending.state,
    });
  }

  const mcpCode = randomToken();
  await ctx.store.putCode(mcpCode, {
    ...pending,
    userId,
    expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS,
  });
  logger.info("Dexcom authorization completed", {
    clientId: pending.clientId,
  });
  return redirectToClient(ctx, pending.redirectUri, {
    code: mcpCode,
    state: pending.state,
  });
}
