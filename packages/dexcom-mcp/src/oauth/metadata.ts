import {
  type AuthMetadataOptions,
  getOAuthProtectedResourceMetadataUrl,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import type { BridgeContext } from "./context.ts";

/**
 * Builds RFC 8414 Authorization Server metadata for the bridge.
 *
 * @param ctx - Bridge context.
 * @returns The metadata document.
 */
export function createAuthorizationServerMetadata(
  ctx: Pick<BridgeContext, "issuer">,
): OAuthMetadata {
  return {
    issuer: ctx.issuer,
    authorization_endpoint: `${ctx.issuer}/authorize`,
    token_endpoint: `${ctx.issuer}/token`,
    registration_endpoint: `${ctx.issuer}/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * Options for the SDK's `oauthMetadataResponse`, which serves both the
 * RFC 9728 protected resource and RFC 8414 discovery documents.
 *
 * @param ctx - Bridge context.
 * @param allowInsecureIssuer - Permit an http issuer (local development).
 * @returns The metadata options.
 */
export function createAuthMetadataOptions(
  ctx: Pick<BridgeContext, "issuer" | "resourceUrl">,
  allowInsecureIssuer: boolean,
): AuthMetadataOptions {
  return {
    oauthMetadata: createAuthorizationServerMetadata(ctx),
    resourceServerUrl: ctx.resourceUrl,
    resourceName: "Dexcom MCP",
    dangerouslyAllowInsecureIssuerUrl: allowInsecureIssuer,
  };
}

/**
 * The RFC 9728 metadata URL advertised in WWW-Authenticate challenges.
 *
 * @param ctx - Bridge context.
 * @returns The metadata URL.
 */
export function resourceMetadataUrl(
  ctx: Pick<BridgeContext, "resourceUrl">,
): string {
  return getOAuthProtectedResourceMetadataUrl(ctx.resourceUrl);
}
