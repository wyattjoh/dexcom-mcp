import { exchangeCode, getDataRange } from "@wyattjoh/dexcom";
import { randomToken, sha256, timingSafeEqualString } from "../crypto.ts";
import { getLogger } from "../logging.ts";
import { grantFromTokens } from "../session.ts";
import {
  bindingCookie,
  type BridgeContext,
  CALLBACK_COOKIE,
  DEXCOM_CALLBACK_PATH,
  errorPage,
  readCookie,
  redirectToClient,
} from "./context.ts";

const logger = getLogger(["dexcom-mcp", "oauth"]);
const AUTHORIZATION_CODE_TTL_MS = 60_000;

function clearBinding(ctx: BridgeContext, response: Response): Response {
  response.headers.append(
    "Set-Cookie",
    bindingCookie(ctx, CALLBACK_COOKIE, "", DEXCOM_CALLBACK_PATH, "Lax"),
  );
  return response;
}

/**
 * GET /oauth/dexcom/callback: Dexcom redirects here after login. The request
 * must carry the cookie set when this browser approved consent, so a Dexcom
 * login URL forwarded to someone else cannot complete the authorization. The
 * Dexcom code is single use and expires within a minute, so it is exchanged
 * right away; the tokens are stored server-side and the MCP client receives
 * its own one-time authorization code instead.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming request.
 * @returns Redirect to the MCP client, or an error page.
 */
export async function handleDexcomCallback(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const state = params.get("state");
  if (!state) return errorPage("Missing state from Dexcom.");

  const stored = await ctx.store.takePendingUpstream(state);
  if (!stored) {
    return errorPage(
      "This Dexcom sign-in is unknown or expired. Start again from your MCP client.",
    );
  }
  const binding = readCookie(request, CALLBACK_COOKIE);
  if (
    !binding ||
    !timingSafeEqualString(await sha256(binding), stored.browserBindingHash)
  ) {
    logger.warn("Dexcom callback from a browser that did not give consent", {
      clientId: stored.clientId,
    });
    return errorPage(
      "This Dexcom sign-in was started in a different browser. Start again from your MCP client.",
      403,
    );
  }
  const { browserBindingHash: _hash, ...pending } = stored;
  const back = (params: Record<string, string | undefined>) =>
    clearBinding(ctx, redirectToClient(ctx, pending.redirectUri, params));

  const upstreamError = params.get("error");
  const code = params.get("code");
  if (upstreamError || !code) {
    const denied = upstreamError === "access_denied";
    return back({
      error: denied ? "access_denied" : "server_error",
      error_description: denied
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
    // userId is the only tenant key for this user's health data.
    if (typeof range.userId !== "string" || range.userId.length === 0) {
      throw new Error("Dexcom did not return a user ID");
    }
    userId = range.userId;
    await ctx.store.putGrant(grantFromTokens(userId, tokens));
  } catch (error) {
    logger.error("Dexcom code exchange failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return back({
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
  logger.info("Dexcom authorization completed", { clientId: pending.clientId });
  return back({ code: mcpCode, state: pending.state });
}
