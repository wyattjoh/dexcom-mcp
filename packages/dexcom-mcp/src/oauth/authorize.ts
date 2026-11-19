import { buildLoginUrl } from "@wyattjoh/dexcom";
import { randomToken, sha256, timingSafeEqualString } from "../crypto.ts";
import type { AuthorizationRequest } from "../store.ts";
import {
  bindingCookie,
  bindingCookieName,
  type BridgeContext,
  CALLBACK_COOKIE,
  DEXCOM_CALLBACK_PATH,
  errorPage,
  escapeHtml,
  htmlResponse,
  readCookie,
  readForm,
  redirectToClient,
} from "./context.ts";

const CONSENT_COOKIE = "dexcom_mcp_consent";

/**
 * Returns true when a requested RFC 8707 resource identifies this server's
 * MCP endpoint (ignoring a trailing slash).
 *
 * @param ctx - Bridge context.
 * @param resource - Requested resource.
 * @returns Whether it is acceptable.
 */
export function isAllowedResource(
  ctx: Pick<BridgeContext, "resourceUrl">,
  resource: string,
): boolean {
  const strip = (value: string) => value.replace(/\/+$/, "");
  try {
    const url = new URL(resource);
    url.hash = "";
    return strip(url.href) === strip(ctx.resourceUrl.href) ||
      strip(url.href) === strip(ctx.resourceUrl.origin);
  } catch {
    return false;
  }
}

type ParsedAuthorization =
  | { ok: true; request: AuthorizationRequest; clientName: string }
  | { ok: false; response: Response };

async function parseAuthorization(
  ctx: BridgeContext,
  params: URLSearchParams,
): Promise<ParsedAuthorization> {
  const clientId = params.get("client_id");
  if (!clientId) {
    return { ok: false, response: errorPage("Missing client_id.") };
  }
  const client = await ctx.store.getClient(clientId);
  if (!client) {
    return { ok: false, response: errorPage("Unknown client_id.") };
  }

  const requestedRedirect = params.get("redirect_uri");
  const redirectUri = requestedRedirect ??
    (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return {
      ok: false,
      response: errorPage("redirect_uri does not match a registered URI."),
    };
  }

  // Anyone can register a redirect URI, so malformed requests get an error
  // page rather than an automatic redirect: otherwise this origin would be
  // an open redirector (RFC 9700 section 4.11.2). Outcomes after the user
  // interacts (denial, codes) still go back to the client.
  const fail = (error: string, description: string): ParsedAuthorization => ({
    ok: false,
    response: errorPage(`${description} (${error}).`),
  });

  if (params.get("response_type") !== "code") {
    return fail("unsupported_response_type", "response_type must be code");
  }
  const codeChallenge = params.get("code_challenge");
  if (!codeChallenge || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return fail("invalid_request", "A PKCE S256 code_challenge is required");
  }
  if (params.get("code_challenge_method") !== "S256") {
    return fail("invalid_request", "code_challenge_method must be S256");
  }
  const resource = params.get("resource") ?? undefined;
  if (resource !== undefined && !isAllowedResource(ctx, resource)) {
    return fail("invalid_target", "Unknown resource");
  }

  return {
    ok: true,
    clientName: client.clientName ?? "An MCP client",
    request: {
      clientId,
      redirectUri,
      codeChallenge,
      state: params.get("state") ?? undefined,
      resource,
    },
  };
}

/**
 * GET /authorize: validates the MCP client's request and renders a consent
 * page. Consent is bound to a cookie so an attacker cannot trick a victim
 * into approving the attacker's client.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming request.
 * @returns Consent page, error page, or error redirect.
 */
export async function handleAuthorizeGet(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  const parsed = await parseAuthorization(
    ctx,
    new URL(request.url).searchParams,
  );
  if (!parsed.ok) return parsed.response;

  const consentId = randomToken();
  const binding = randomToken();
  await ctx.store.putConsent(consentId, {
    ...parsed.request,
    browserBindingHash: await sha256(binding),
  });

  const redirectHost = new URL(parsed.request.redirectUri).host ||
    parsed.request.redirectUri;
  const body = `<h1>Connect Dexcom</h1>
<p><strong>${
    escapeHtml(parsed.clientName)
  }</strong> wants read-only access to your Dexcom CGM data (glucose readings, events, alerts, devices) through this MCP server.</p>
<p>After approval you will sign in with Dexcom, and access will be returned to <code>${
    escapeHtml(redirectHost)
  }</code>.</p>
<form method="post" action="/authorize">
<input type="hidden" name="consent_id" value="${escapeHtml(consentId)}">
<div class="actions">
<button type="submit" name="action" value="approve">Continue to Dexcom</button>
<button type="submit" name="action" value="deny">Cancel</button>
</div>
</form>`;
  return htmlResponse("Connect Dexcom", body, 200, {
    "Set-Cookie": bindingCookie(
      ctx,
      CONSENT_COOKIE,
      binding,
      "/authorize",
      "Strict",
    ),
  });
}

/**
 * POST /authorize: records the user's consent decision and, on approval,
 * redirects to Dexcom's login page with a fresh upstream state.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming form POST.
 * @returns Redirect to Dexcom or back to the client.
 */
export async function handleAuthorizePost(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  const form = await readForm(request);
  const consentId = form?.get("consent_id");
  if (!form || !consentId) return errorPage("Missing consent request.");

  const consent = await ctx.store.takeConsent(consentId);
  if (!consent) {
    return errorPage(
      "This authorization request expired. Start again from your MCP client.",
    );
  }

  const binding = readCookie(request, bindingCookieName(ctx, CONSENT_COOKIE));
  if (
    !binding ||
    !timingSafeEqualString(await sha256(binding), consent.browserBindingHash)
  ) {
    return errorPage(
      "This authorization request was started in a different browser.",
      403,
    );
  }

  const clearCookie = bindingCookie(
    ctx,
    CONSENT_COOKIE,
    "",
    "/authorize",
    "Strict",
  );
  const { browserBindingHash: _hash, ...authorization } = consent;

  if (form.get("action") !== "approve") {
    const response = redirectToClient(ctx, authorization.redirectUri, {
      error: "access_denied",
      error_description: "The user declined the request",
      state: authorization.state,
    });
    response.headers.append("Set-Cookie", clearCookie);
    return response;
  }

  // Bind the upstream state to this browser so a Dexcom login URL lured to
  // another user cannot complete this client's authorization.
  const upstreamState = randomToken();
  const callbackBinding = randomToken();
  await ctx.store.putPendingUpstream(upstreamState, {
    ...authorization,
    browserBindingHash: await sha256(callbackBinding),
  });
  const headers = new Headers({
    Location: buildLoginUrl(ctx.dexcom, upstreamState).href,
    "Cache-Control": "no-store",
  });
  headers.append("Set-Cookie", clearCookie);
  headers.append(
    "Set-Cookie",
    bindingCookie(
      ctx,
      CALLBACK_COOKIE,
      callbackBinding,
      DEXCOM_CALLBACK_PATH,
      "Lax",
    ),
  );
  return new Response(null, { status: 302, headers });
}
