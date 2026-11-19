import type { DexcomConfig } from "@wyattjoh/dexcom";
import type { DexcomSessions } from "../session.ts";
import type { Store } from "../store.ts";

/**
 * Shared dependencies of the OAuth bridge endpoints.
 */
export interface BridgeContext {
  /**
   * Public base URL of this server (issuer), without a trailing slash.
   */
  readonly issuer: string;
  /**
   * The protected MCP endpoint URL (RFC 8707 resource identifier).
   */
  readonly resourceUrl: URL;
  /**
   * Dexcom configuration whose redirect URI is this server's callback.
   */
  readonly dexcom: DexcomConfig;
  /**
   * Persistent store.
   */
  readonly store: Store;
  /**
   * Dexcom session manager.
   */
  readonly sessions: DexcomSessions;
  /**
   * MCP access token lifetime in milliseconds.
   */
  readonly accessTokenTtlMs: number;
  /**
   * MCP refresh token lifetime in milliseconds.
   */
  readonly refreshTokenTtlMs: number;
}

/**
 * Path of the Dexcom redirect URI served by this server.
 */
export const DEXCOM_CALLBACK_PATH = "/oauth/dexcom/callback";

/**
 * Builds a JSON response with no-store caching.
 *
 * @param body - JSON-serializable body.
 * @param status - HTTP status.
 * @param headers - Extra headers.
 * @returns The response.
 */
export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/**
 * Builds an RFC 6749 error response.
 *
 * @param error - OAuth error code.
 * @param description - Human-readable description.
 * @param status - HTTP status; defaults to 400.
 * @returns The response.
 */
export function oauthErrorResponse(
  error: string,
  description: string,
  status = 400,
): Response {
  return jsonResponse({ error, error_description: description }, status);
}

/**
 * Redirects to a client's redirect URI with query parameters, adding the
 * RFC 9207 `iss` parameter.
 *
 * @param ctx - Bridge context.
 * @param redirectUri - Registered redirect URI.
 * @param params - Parameters to append; undefined values are skipped.
 * @returns A 302 response.
 */
export function redirectToClient(
  ctx: BridgeContext,
  redirectUri: string,
  params: Record<string, string | undefined>,
): Response {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", ctx.issuer);
  return new Response(null, {
    status: 302,
    headers: { Location: url.href, "Cache-Control": "no-store" },
  });
}

/**
 * Reads an application/x-www-form-urlencoded body, capped at 64 KiB.
 *
 * @param request - Incoming request.
 * @returns The parsed parameters, or undefined when unreadable.
 */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | undefined> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) return undefined;
  const text = await request.text();
  if (text.length > 64 * 1024) return undefined;
  return new URLSearchParams(text);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes text for HTML content and attribute values.
 *
 * @param value - Untrusted text.
 * @returns Escaped text.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Renders a minimal, frame-protected HTML page.
 *
 * @param title - Page title.
 * @param body - Trusted HTML body.
 * @param status - HTTP status.
 * @param headers - Extra headers.
 * @returns The response.
 */
export function htmlResponse(
  title: string,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1f2328}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{font:inherit;padding:.5rem 1.25rem;border-radius:.375rem;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer}
button[value=approve]{background:#1f883d;border-color:#1f883d;color:#fff}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:.25rem}
</style></head><body>${body}</body></html>`;
  return new Response(page, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

/**
 * Renders an error page for failures that must not redirect (unknown client
 * or redirect URI).
 *
 * @param message - Description.
 * @param status - HTTP status.
 * @returns The response.
 */
export function errorPage(message: string, status = 400): Response {
  return htmlResponse(
    "Authorization error",
    `<h1>Authorization error</h1><p>${escapeHtml(message)}</p>`,
    status,
  );
}
