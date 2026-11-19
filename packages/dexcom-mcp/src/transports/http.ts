import {
  bearerAuthChallengeResponse,
  createMcpHandler,
  type McpHttpHandler,
  oauthMetadataResponse,
  originValidationResponse,
  verifyBearerToken,
} from "@modelcontextprotocol/server";
import { getLogger } from "../logging.ts";
import { handleAuthorizeGet, handleAuthorizePost } from "../oauth/authorize.ts";
import { handleDexcomCallback } from "../oauth/callback.ts";
import {
  type BridgeContext,
  DEXCOM_CALLBACK_PATH,
  jsonResponse,
} from "../oauth/context.ts";
import {
  createAuthMetadataOptions,
  resourceMetadataUrl,
} from "../oauth/metadata.ts";
import { handleRegister } from "../oauth/register.ts";
import { handleToken } from "../oauth/token.ts";
import { createTokenVerifier, userIdFromAuthInfo } from "../oauth/verifier.ts";
import { createMcpServerWithTools } from "../server-factory.ts";

const logger = getLogger(["dexcom-mcp", "transport", "http"]);

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

const MAX_MCP_BODY_BYTES = 1024 * 1024;

/**
 * Options for {@link createHttpHandler}.
 */
export interface HttpHandlerOptions {
  /**
   * Bridge dependencies.
   */
  ctx: BridgeContext;
  /**
   * Browser Origin hostnames allowed to call /mcp.
   */
  allowedOriginHostnames: string[];
  /**
   * Permit an http issuer (loopback development only).
   */
  allowInsecureIssuer: boolean;
}

/**
 * A fetch-style HTTP handler plus teardown.
 */
export interface HttpHandler {
  /**
   * Serves one request.
   */
  fetch: (request: Request) => Promise<Response>;
  /**
   * Closes in-flight MCP exchanges.
   */
  close: () => Promise<void>;
}

function withCors(response: Response): Response {
  // Responses from fetch/SDK may have immutable headers; copy them.
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Creates the HTTP handler serving the OAuth bridge, discovery documents,
 * and the bearer-protected Streamable HTTP MCP endpoint.
 *
 * @param options - Handler options.
 * @returns The handler.
 */
export function createHttpHandler(options: HttpHandlerOptions): HttpHandler {
  const { ctx, allowedOriginHostnames, allowInsecureIssuer } = options;
  const metadataOptions = createAuthMetadataOptions(ctx, allowInsecureIssuer);
  const metadataUrl = resourceMetadataUrl(ctx);
  const verifier = createTokenVerifier(ctx);
  const mcpPath = ctx.resourceUrl.pathname;

  const mcpHandler: McpHttpHandler = createMcpHandler((requestContext) => {
    const userId = userIdFromAuthInfo(requestContext.authInfo);
    if (!userId) {
      throw new Error("MCP request reached the handler without auth");
    }
    return createMcpServerWithTools(ctx.sessions, userId);
  }, {
    onerror: (error) =>
      logger.error("MCP handler failed", { error: error.message }),
  });

  async function serveMcp(request: Request): Promise<Response> {
    const rejected = originValidationResponse(request, allowedOriginHostnames);
    if (rejected) return rejected;
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, {
        Allow: "POST, OPTIONS",
      });
    }
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > MAX_MCP_BODY_BYTES) {
      return jsonResponse({ error: "Request body too large" }, 413);
    }

    let authInfo;
    try {
      authInfo = await verifyBearerToken(request.headers.get("authorization"), {
        verifier,
        resourceMetadataUrl: metadataUrl,
      });
    } catch (error) {
      logger.debug("Rejected MCP request", {
        error: error instanceof Error ? error.message : String(error),
      });
      return bearerAuthChallengeResponse(error, {
        resourceMetadataUrl: metadataUrl,
      });
    }
    return mcpHandler.fetch(request, { authInfo });
  }

  function route(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    const metadata = oauthMetadataResponse(request, metadataOptions);
    if (metadata) return metadata;

    const key = `${request.method} ${url.pathname}`;
    switch (key) {
      case "GET /health":
        return jsonResponse({
          status: "healthy",
          timestamp: new Date().toISOString(),
        });
      case "POST /register":
        return handleRegister(ctx, request);
      case "GET /authorize":
        return handleAuthorizeGet(ctx, request);
      case "POST /authorize":
        return handleAuthorizePost(ctx, request);
      case "POST /token":
        return handleToken(ctx, request);
      case `GET ${DEXCOM_CALLBACK_PATH}`:
        return handleDexcomCallback(ctx, request);
    }
    if (url.pathname === mcpPath) return serveMcp(request);
    return jsonResponse({ error: "Not found" }, 404);
  }

  return {
    fetch: async (request) => {
      try {
        return withCors(await route(request));
      } catch (error) {
        logger.error("Unhandled error in HTTP handler", {
          method: request.method,
          url: request.url,
          error: error instanceof Error ? error.message : String(error),
        });
        return withCors(jsonResponse({ error: "Internal server error" }, 500));
      }
    },
    close: () => mcpHandler.close(),
  };
}

/**
 * Starts the HTTP server with Deno.serve.
 *
 * @param handler - HTTP handler.
 * @param port - Listen port (0 for ephemeral).
 * @param hostname - Bind address.
 * @returns The running server and a close function.
 */
export function startHttpServer(
  handler: HttpHandler,
  port: number,
  hostname: string,
): { server: Deno.HttpServer<Deno.NetAddr>; close: () => Promise<void> } {
  const server = Deno.serve({
    port,
    hostname,
    onListen: (addr) => {
      logger.info("HTTP server listening on {hostname}:{port}", {
        hostname: addr.hostname,
        port: addr.port,
      });
    },
  }, handler.fetch);
  return {
    server,
    close: async () => {
      await handler.close();
      await server.shutdown();
    },
  };
}
