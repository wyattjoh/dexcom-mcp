import { randomToken } from "../crypto.ts";
import type { RegisteredClient } from "../store.ts";
import {
  type BridgeContext,
  jsonResponse,
  oauthErrorResponse,
} from "./context.ts";

const MAX_REDIRECT_URIS = 10;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set([
  "javascript:",
  "data:",
  "file:",
  "vbscript:",
]);

/**
 * Validates a client redirect URI: absolute, no fragment, https unless
 * loopback http, and no script-capable schemes. Custom schemes are allowed
 * for native apps.
 *
 * @param value - Candidate URI.
 * @returns An error message, or undefined when valid.
 */
export function validateRedirectUri(value: unknown): string | undefined {
  if (typeof value !== "string") return "redirect_uris must be strings";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Invalid redirect URI: ${value}`;
  }
  if (url.hash) return "Redirect URIs must not contain a fragment";
  if (FORBIDDEN_SCHEMES.has(url.protocol)) {
    return `Unsupported redirect URI scheme: ${url.protocol}`;
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return "http redirect URIs are only allowed for loopback hosts";
  }
  return undefined;
}

/**
 * Handles RFC 7591 dynamic client registration. All clients are public and
 * must use PKCE; any requested authentication method is downgraded to
 * `none`.
 *
 * @param ctx - Bridge context.
 * @param request - Incoming POST /register request.
 * @returns The registration response.
 */
export async function handleRegister(
  ctx: BridgeContext,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 16 * 1024) {
      return oauthErrorResponse("invalid_client_metadata", "Body too large");
    }
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return oauthErrorResponse("invalid_client_metadata", "Body must be JSON");
  }

  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) || redirectUris.length === 0 ||
    redirectUris.length > MAX_REDIRECT_URIS
  ) {
    return oauthErrorResponse(
      "invalid_redirect_uri",
      `redirect_uris must list 1-${MAX_REDIRECT_URIS} URIs`,
    );
  }
  for (const uri of redirectUris) {
    const problem = validateRedirectUri(uri);
    if (problem) return oauthErrorResponse("invalid_redirect_uri", problem);
  }

  const grantTypes = body.grant_types;
  if (
    grantTypes !== undefined &&
    (!Array.isArray(grantTypes) ||
      grantTypes.some((g) =>
        g !== "authorization_code" && g !== "refresh_token"
      ))
  ) {
    return oauthErrorResponse(
      "invalid_client_metadata",
      "Only authorization_code and refresh_token grants are supported",
    );
  }

  const clientName = typeof body.client_name === "string"
    ? body.client_name.slice(0, 100)
    : undefined;
  const client: RegisteredClient = {
    clientId: randomToken(),
    clientName,
    redirectUris: redirectUris as string[],
    issuedAt: Math.floor(Date.now() / 1000),
  };
  await ctx.store.putClient(client);

  return jsonResponse({
    client_id: client.clientId,
    client_id_issued_at: client.issuedAt,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }, 201);
}
