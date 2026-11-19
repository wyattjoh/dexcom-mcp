import type { DexcomConfig } from "./config.ts";
import { toDexcomApiError } from "./errors.ts";
import type { TokenResponse } from "./types.ts";

/**
 * Builds the Dexcom login URL that starts user authorization.
 *
 * @param config - Dexcom configuration.
 * @param state - Opaque CSRF/state value returned on the callback.
 * @returns The URL to send the user's browser to.
 */
export function buildLoginUrl(config: DexcomConfig, state: string): URL {
  const url = new URL(`${config.baseUrl}/v3/oauth2/login`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "offline_access");
  url.searchParams.set("state", state);
  return url;
}

async function postToken(
  config: DexcomConfig,
  params: Record<string, string>,
  context: string,
): Promise<TokenResponse> {
  const response = await config.fetch(`${config.baseUrl}/v3/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: new URLSearchParams({
      ...params,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) throw await toDexcomApiError(response, context);
  const body = await response.json() as TokenResponse;
  if (!body.access_token || !body.refresh_token) {
    throw new Error(`${context} returned an incomplete token response`);
  }
  return body;
}

/**
 * Exchanges a single-use authorization code (valid for one minute) for
 * tokens.
 *
 * @param config - Dexcom configuration.
 * @param code - Authorization code from the redirect.
 * @returns Access and refresh tokens.
 */
export function exchangeCode(
  config: DexcomConfig,
  code: string,
): Promise<TokenResponse> {
  return postToken(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  }, "Dexcom code exchange");
}

/**
 * Exchanges a refresh token for new tokens. The refresh token is single use:
 * persist the returned refresh token before relying on the new access token.
 * A 400 response means the grant is gone and the user must re-authorize.
 *
 * @param config - Dexcom configuration.
 * @param refreshToken - Most recent refresh token.
 * @returns New access and refresh tokens.
 */
export function refreshTokens(
  config: DexcomConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, "Dexcom token refresh");
}
